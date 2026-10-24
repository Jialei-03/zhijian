import { describe, expect, it } from "vitest";
import type {
  NavigationResearch,
  NavigationWorkspace,
  ResearchNavigation,
} from "./navigation-api";
import { needsYou, type AttentionMessage } from "./navigation-attention";
import { teamHash } from "./team-api";

const research = (
  id: string,
  extra: Partial<NavigationResearch> = {},
): NavigationResearch => ({
  id,
  workspace_id: "project",
  title: id,
  question: id,
  status: "active",
  stage: "scoping",
  updated_at: "2026-10-24",
  session_id: "session",
  collection_id: null,
  on_board: true,
  pinned_at: null,
  end_reason: "",
  column: "running",
  rounds: 0,
  best: null,
  working: "",
  waiting: 0,
  compute_id: "host",
  ...extra,
});
const message = (id: string, extra = {}): AttentionMessage =>
  ({
    id,
    workspace_id: "project",
    channel_id: "channel",
    thread_id: null,
    text: id,
    data: {},
    created_at: "2026-10-23",
    ...extra,
  }) as AttentionMessage;
const navigation = (researches: NavigationResearch[]): ResearchNavigation => ({
  workspaces: [
    { id: "project", archived: false, researches } as NavigationWorkspace,
  ],
  collections: [],
});

describe("needs you", () => {
  it("only lists explicit waits, including plans, newest first with their exact destinations", () => {
    const data = navigation([
      research("unread", { unread: true }),
      research("wait", { status: "waiting" }),
      research("plan", { stage: "scoping", planned: true }),
      research("archived", { status: "waiting", archived_at: "2026-10-23" }),
    ]);
    const items = needsYou(data, [
      message("mention"),
      message("question", { data: { waiting: true }, thread_id: "root" }),
      message("confirmation", { data: { waiting: true } }),
      message("hidden", { workspace_id: "other", data: { waiting: true } }),
    ]);
    expect(items.map((item) => item.title)).toEqual([
      "plan",
      "wait",
      "confirmation",
      "question",
    ]);
    expect(items.find((item) => item.title === "question")?.hash).toBe(
      teamHash("project", "channel", "root"),
    );
    expect(items.find((item) => item.title === "confirmation")?.hash).toBe(
      teamHash("project", "channel", "confirmation"),
    );
    expect(items[0].hash).toBe(teamHash("project", "", "research:plan"));
  });

  it("disappears when decisions are resolved or projects archived", () => {
    const data = navigation([research("wait", { status: "waiting" })]);
    expect(needsYou(data, [])).toHaveLength(1);
    data.workspaces[0].researches[0].status = "finished";
    expect(needsYou(data, [message("read")])).toEqual([]);
    data.workspaces[0].archived = true;
    expect(
      needsYou(data, [message("wait", { data: { waiting: true } })]),
    ).toEqual([]);
  });
});
