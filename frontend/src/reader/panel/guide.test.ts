import { describe, expect, it } from "vitest";
import type { Preparation } from "../../lib/preparation";
import {
  EMPTY_GUIDE,
  guideView,
  pickGuide,
  readGuide,
  type GuideArtifact,
} from "./guide";

const GUIDE = {
  keywords: ["attention", "  "],
  summary: ["One.", "Two.", "Three."],
  sections: [
    { title: "研究问题", body: "Body.", pages: [3, 0, 2.5, "4"] },
    { title: "方法" },
    null,
  ],
};

function artifact(
  fields: Partial<GuideArtifact> & { id: string },
): GuideArtifact {
  return {
    file_id: "f1",
    kind: "guide",
    status: "completed",
    error: "",
    ...fields,
  };
}

function preparation(fields: Partial<Preparation> = {}): Preparation {
  return {
    enabled: true,
    status: "queued",
    stage: "",
    error: "",
    completed: 0,
    total: 0,
    guide_status: "queued",
    translation_status: "queued",
    layout_status: "queued",
    ...fields,
  };
}

const known = { loaded: true, loadError: null, models: 1 } as const;

describe("readGuide", () => {
  it("keeps what is well formed and drops the rest", () => {
    expect(readGuide(GUIDE)).toEqual({
      keywords: ["attention"],
      summary: ["One.", "Two.", "Three."],
      sections: [{ title: "研究问题", body: "Body.", pages: [3] }],
      cited: false,
    });
  });

  it("knows a guide whose sentence citations were checked", () => {
    expect(readGuide({ ...GUIDE, cited: true }).cited).toBe(true);
    expect(readGuide({ ...GUIDE, cited: "yes" }).cited).toBe(false);
  });

  it("reads nothing from what is not a guide", () => {
    for (const value of [null, undefined, "guide", 4, []])
      expect(readGuide(value)).toEqual(EMPTY_GUIDE);
    expect(readGuide({ keywords: "a", summary: {}, sections: 1 })).toEqual(
      EMPTY_GUIDE,
    );
  });
});

describe("pickGuide", () => {
  const rows = [
    artifact({ id: "new-failed", status: "failed" }),
    artifact({ id: "other-file", file_id: "f2", status: "running" }),
    artifact({ id: "quiz", kind: "quiz", status: "running" }),
    artifact({ id: "done", result: GUIDE }),
    artifact({ id: "running", status: "running" }),
  ];

  it("prefers the one being made, then a finished one, then the latest", () => {
    expect(pickGuide(rows, "f1")?.id).toBe("running");
    expect(pickGuide(rows.slice(0, 4), "f1")?.id).toBe("done");
    expect(pickGuide(rows.slice(0, 1), "f1")?.id).toBe("new-failed");
  });

  it("looks only at guides of the file", () => {
    expect(pickGuide(rows, "f3")).toBeNull();
    expect(pickGuide([], "f1")).toBeNull();
  });
});

describe("guideView", () => {
  it("waits for what is being read", () => {
    expect(
      guideView({
        ...known,
        loaded: false,
        preparation: null,
        artifact: null,
      }),
    ).toEqual({ kind: "loading" });
  });

  it("shows a guide that is there, whatever else is the case", () => {
    const view = guideView({
      loaded: true,
      loadError: null,
      models: 0,
      preparation: null,
      artifact: artifact({ id: "a", result: GUIDE }),
    });
    expect(view.kind).toBe("ready");
  });

  it("asks for a model when there is none and no guide", () => {
    expect(
      guideView({
        ...known,
        models: 0,
        preparation: preparation(),
        artifact: null,
      }),
    ).toEqual({ kind: "noModel" });
  });

  it("shows the draft of a guide being written", () => {
    const view = guideView({
      ...known,
      preparation: null,
      artifact: artifact({
        id: "a",
        status: "running",
        preview: { keywords: ["x"], sections: [] },
      }),
    });
    expect(view).toEqual({
      kind: "working",
      content: { keywords: ["x"], summary: [], sections: [], cited: false },
    });
  });

  it("is working while the preparation is about to make the guide", () => {
    for (const status of ["queued", "running"])
      expect(
        guideView({
          ...known,
          preparation: preparation({ status }),
          artifact: null,
        }),
      ).toEqual({ kind: "working", content: EMPTY_GUIDE });
  });

  it("offers to make it when the preparation is off or paused", () => {
    for (const fields of [
      { enabled: false },
      { status: "paused" },
      { status: "completed" },
    ])
      expect(
        guideView({
          ...known,
          preparation: preparation(fields),
          artifact: null,
        }),
      ).toEqual({ kind: "idle", note: "", stopped: false });
    expect(
      guideView({ ...known, preparation: null, artifact: null }).kind,
    ).toBe("idle");
  });

  it("says why a guide failed, in the service's words", () => {
    expect(
      guideView({
        ...known,
        preparation: null,
        artifact: artifact({ id: "a", status: "failed", error: "没有成功" }),
      }),
    ).toEqual({ kind: "failed", message: "没有成功" });
    expect(
      guideView({
        ...known,
        preparation: preparation({
          status: "failed",
          guide_status: "failed",
          error: "导读失败；第 2 页翻译失败；布局失败",
        }),
        artifact: null,
      }),
    ).toEqual({ kind: "failed", message: "" });
  });

  it("does not show translation or layout errors in a missing guide", () => {
    expect(
      guideView({
        ...known,
        preparation: preparation({
          status: "failed",
          guide_status: "waiting",
          error: "第 2 页翻译失败；布局失败",
        }),
        artifact: null,
      }),
    ).toEqual({ kind: "idle", note: "", stopped: false });
    expect(
      guideView({
        ...known,
        preparation: preparation({
          status: "failed",
          guide_status: "failed",
          error: "导读失败；第 2 页翻译失败",
        }),
        artifact: artifact({
          id: "guide",
          status: "failed",
          error: "导读失败",
        }),
      }),
    ).toEqual({ kind: "failed", message: "导读失败" });
  });

  it("offers to make a stopped guide anew", () => {
    expect(
      guideView({
        ...known,
        preparation: null,
        artifact: artifact({
          id: "a",
          status: "cancelled",
          error: "自动准备已暂停",
        }),
      }),
    ).toEqual({ kind: "idle", note: "自动准备已暂停", stopped: true });
  });

  it("fails when the guide could not be read", () => {
    expect(
      guideView({
        ...known,
        loadError: "离线",
        preparation: null,
        artifact: null,
      }),
    ).toEqual({ kind: "failed", message: "离线" });
  });

  it("keeps the earlier guide while a new one is made, and when making it fails", () => {
    const earlier = { summary: ["Earlier summary."], sections: [] };
    const base = {
      id: "g",
      file_id: "f",
      kind: "guide",
      error: "",
      previous: earlier,
    };
    const state = {
      loaded: true,
      loadError: null,
      models: 1,
      preparation: null,
    };
    const working = guideView({
      ...state,
      artifact: { ...base, status: "running", preview: {} },
    });
    expect(working).toMatchObject({
      kind: "working",
      content: { summary: ["Earlier summary."] },
    });
    const failed = guideView({
      ...state,
      artifact: { ...base, status: "failed", error: "model busy" },
    });
    expect(failed).toMatchObject({
      kind: "ready",
      content: { summary: ["Earlier summary."] },
      failed: "model busy",
    });
    const none = guideView({
      ...state,
      artifact: { ...base, previous: undefined, status: "failed", error: "x" },
    });
    expect(none).toEqual({ kind: "failed", message: "x" });
  });
});
