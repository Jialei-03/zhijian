import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { ApiError } from "../../api";
import { DiffDialog } from "./ChangeCards";
import { changeError } from "./TeamMessageChanges";
import { readTeamDiff, revertTeamMessage } from "./team-api";

afterEach(() => vi.unstubAllGlobals());

describe("team message changes", () => {
  it("requests a literal path without losing tabs, newlines, or pathspec characters", async () => {
    const path = "文稿/[1]\t\n.md";
    const response = {
      path,
      diff: "@@ -1 +1 @@\n-old\n+new",
      truncated: false,
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetch);
    expect(await readTeamDiff("workspace", "message/id", path)).toEqual(
      response,
    );
    const url = new URL(fetch.mock.calls[0][0], "https://offline.test");
    expect(url.pathname).toBe(
      "/api/v1/research/workspaces/workspace/team/messages/message%2Fid/diff",
    );
    expect(url.searchParams.get("path")).toBe(path);
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
  });

  it("posts the revert and retains its receipt", async () => {
    const message = { data: { reverted_by: "b".repeat(40) } };
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(message)));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("document", { cookie: "paper_csrf=offline" });
    expect(await revertTeamMessage("workspace", "message")).toEqual(message);
    expect(fetch.mock.calls[0][0]).toBe(
      "/api/v1/research/workspaces/workspace/team/messages/message/revert",
    );
    expect(fetch.mock.calls[0][1].method).toBe("POST");
    expect(fetch.mock.calls[0][1].headers.get("X-CSRF-Token")).toBe("offline");
  });

  it("shows conflict files as labels and preserves ordinary errors", async () => {
    const detail = {
      message: "Revert conflict",
      conflicts: ["draft.md", "notes.md"],
    };
    vi.stubGlobal("document", { cookie: "" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ detail }), { status: 409 }),
        ),
    );
    await expect(revertTeamMessage("workspace", "message")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 409 &&
        changeError(error) === "Revert conflict · draft.md · notes.md",
    );
    expect(changeError(new Error("Unavailable"))).toBe("Unavailable");
  });

  it("reuses the diff dialog for inline patches and lazy file lists", () => {
    const file = {
      path: "draft.md",
      added: 2,
      removed: 1,
      diff: "+inline patch",
    };
    const render = (loadDiff?: (path: string) => Promise<{ diff: string }>) =>
      renderToStaticMarkup(
        createElement(I18nProvider, {
          locale: "en",
          children: createElement(DiffDialog, {
            changes: { files: [file, { ...file, path: "deleted.md" }] },
            loadDiff,
            onClose() {},
          }),
        }),
      );
    expect(render()).toContain("+inline patch");
    const load = vi.fn().mockResolvedValue({ diff: "+loaded patch" });
    const lazy = render(load);
    expect(lazy).toContain("draft.md");
    expect(lazy).toContain("deleted.md");
    expect(lazy).not.toContain("+inline patch");
    expect(lazy.match(/<details open=""/g)).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();
  });
});
