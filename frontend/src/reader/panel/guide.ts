import type { Preparation } from "../../lib/preparation";

/** One of the guide's sections: the title comes from the result (研究问题, 方法, …). */
export type GuideSection = { title: string; body: string; pages: number[] };

/** What a guide holds, whole (`result`) or as far as it has been written (`preview`). */
export type GuideContent = {
  keywords: string[];
  summary: string[];
  sections: GuideSection[];
  /**
   * The service checked every sentence's citation marker against the pages
   * (`[[p3: "…"]]`); guides made before that have page chips only.
   */
  cited: boolean;
};

/** A reading artifact as the service sends it, as far as the guide reads it. */
export type GuideArtifact = {
  id: string;
  file_id: string;
  kind: string;
  status: string;
  error: string;
  result?: unknown;
  preview?: unknown;
  /** The last finished guide, kept while a new one is made (and if making it fails). */
  previous?: unknown;
};

/** What the tab shows. */
export type GuideView =
  | { kind: "loading" }
  | { kind: "noModel" }
  /** Being made; `content` is what has arrived (nothing yet, at first). */
  | { kind: "working"; content: GuideContent }
  /** `failed`: making a newer guide failed, with this reason; the earlier one is shown meanwhile. */
  | { kind: "ready"; content: GuideContent; failed?: string }
  /** `message` is the service's own words, `""` when it gave none. */
  | { kind: "failed"; message: string }
  /**
   * Nothing is on the way: the person starts it. `stopped` is a guide that was
   * stopped (a paused preparation); `note` is the service's word on it, if any.
   */
  | { kind: "idle"; note: string; stopped: boolean };

export const EMPTY_GUIDE: GuideContent = {
  keywords: [],
  summary: [],
  sections: [],
  cited: false,
};

const running = (artifact: GuideArtifact) =>
  artifact.status === "queued" || artifact.status === "running";

/** Whether the guide is still being made. */
export const isRunning = (artifact: GuideArtifact | null) =>
  artifact !== null && running(artifact);

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim() !== "",
      )
    : [];

const pagesOf = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is number =>
          Number.isInteger(item) && (item as number) >= 1,
      )
    : [];

/** The parts of `value` that are well formed; a half-written or odd result never breaks the tab. */
export function readGuide(value: unknown): GuideContent {
  if (typeof value !== "object" || value === null) return EMPTY_GUIDE;
  const record = value as Record<string, unknown>;
  const sections = Array.isArray(record.sections)
    ? record.sections.flatMap((entry): GuideSection[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const section = entry as Record<string, unknown>;
        if (
          typeof section.title !== "string" ||
          typeof section.body !== "string"
        )
          return [];
        return [
          {
            title: section.title,
            body: section.body,
            pages: pagesOf(section.pages),
          },
        ];
      })
    : [];
  return {
    keywords: strings(record.keywords),
    summary: strings(record.summary),
    sections,
    cited: record.cited === true,
  };
}

const hasContent = (content: GuideContent) =>
  content.keywords.length + content.summary.length + content.sections.length >
  0;

/**
 * The guide of a file among a paper's artifacts: the one being made, else a
 * finished one, else the latest (the list comes newest first).
 */
export function pickGuide(
  rows: readonly GuideArtifact[],
  fileId: string,
): GuideArtifact | null {
  const guides = rows.filter(
    (row) => row.kind === "guide" && row.file_id === fileId,
  );
  return (
    guides.find(running) ??
    guides.find(
      (row) => row.status === "completed" && hasContent(readGuide(row.result)),
    ) ??
    guides[0] ??
    null
  );
}

/** Whether the automatic preparation is going to make a guide by itself. */
export function preparing(preparation: Preparation | null): boolean {
  return (
    preparation !== null &&
    preparation.enabled &&
    (preparation.status === "queued" || preparation.status === "running")
  );
}

/** What to show, from what is known. A guide that is there is shown whatever else is the case. */
export function guideView(state: {
  loaded: boolean;
  /** Why loading the guide failed (`""` when the service said nothing), or `null` when it did not. */
  loadError: string | null;
  models: number;
  preparation: Preparation | null;
  artifact: GuideArtifact | null;
}): GuideView {
  const { artifact, preparation } = state;
  if (artifact?.status === "completed") {
    const content = readGuide(artifact.result);
    if (hasContent(content)) return { kind: "ready", content };
  }
  const earlier = artifact ? readGuide(artifact.previous) : EMPTY_GUIDE;
  if (artifact && running(artifact)) {
    const preview = readGuide(artifact.preview);
    return {
      kind: "working",
      content: hasContent(preview) ? preview : earlier,
    };
  }
  if (
    artifact &&
    (artifact.status === "failed" || artifact.status === "cancelled") &&
    hasContent(earlier)
  )
    return { kind: "ready", content: earlier, failed: artifact.error };
  if (!state.loaded) return { kind: "loading" };
  if (state.loadError !== null)
    return { kind: "failed", message: state.loadError };
  if (state.models === 0) return { kind: "noModel" };
  if (artifact?.status === "failed" || artifact?.status === "completed")
    return { kind: "failed", message: artifact.error };
  if (artifact?.status === "cancelled")
    return { kind: "idle", note: artifact.error, stopped: true };
  if (!artifact) {
    if (preparing(preparation))
      return { kind: "working", content: EMPTY_GUIDE };
    if (preparation?.guide_status === "failed")
      return { kind: "failed", message: "" };
  }
  return { kind: "idle", note: "", stopped: false };
}
