import { describe, expect, it, vi } from "vitest";
import { parseAppRoute } from "../../app/routes";
import { workflowMembers } from "./TeamSettings";
import {
  ruleHash,
  settingsHash,
  saveTeamWorkflow,
  selectTeamWorkflow,
  type Team,
} from "../research/team-api";
import { readWorkflows, ruleWorkflow } from "../workflows/workflows-api";
import { en } from "../../i18n/messages/en";
import type { Workflow } from "./workflow/workflow-model";

const calls = vi.hoisted(() => ({ api: vi.fn(), send: vi.fn() }));
vi.mock("../../api", () => calls);
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workflow: Workflow = {
  id: "research",
  name: "Research",
  version: 4,
  builtin: true,
  rules: [],
  layout: { members: {}, channels: {} },
};
const team: Team = {
  workspace_id: "workspace",
  channels: [],
  notifications: [],
  workflow,
  members: [
    {
      id: "owner",
      name: "Me",
      role: "human",
      status: "idle",
      active_run_id: null,
    },
    {
      id: "agent",
      name: "Advisor",
      role: "advisor",
      status: "working",
      active_run_id: "run",
    },
  ],
};

describe("team workflow wiring", () => {
  it("maps Step 1 identities into trusted contract roles", () => {
    expect(workflowMembers(team, (key) => en[key])).toEqual([
      {
        id: "owner",
        name: "Researcher",
        kind: "human",
        role: "owner",
        avatar_seed: "owner",
      },
      {
        id: "agent",
        name: "Advisor",
        kind: "agent",
        role: "advisor",
        avatar_seed: "advisor",
      },
    ]);
  });
  it("keeps the rule identity and workflow version in message navigation", () => {
    const route = parseAppRoute(
      ruleHash(workspaceId, "research", 4, "research:1:result"),
    );
    expect(route).toMatchObject({
      screen: "team",
      workspaceId,
      channelId: "settings",
      threadId: "rule:research:4:research:1:result",
    });
    expect(parseAppRoute(settingsHash(workspaceId, "compare"))).toMatchObject({
      channelId: "settings",
      threadId: "compare",
    });
  });
  it("saves the complete versioned rule graph and selects team workflows", () => {
    saveTeamWorkflow("workspace", workflow);
    expect(calls.send).toHaveBeenLastCalledWith(
      "/research/workspaces/workspace/team/workflow",
      workflow,
      "PUT",
    );
    selectTeamWorkflow("workspace", "peers");
    expect(calls.send).toHaveBeenLastCalledWith(
      "/research/workspaces/workspace/team/workflow",
      { workflow_id: "peers" },
    );
    readWorkflows("workspace");
    expect(calls.api).toHaveBeenLastCalledWith(
      "/research/workflows?workspace_id=workspace",
    );
  });
  it("opens rule graphs while retaining legacy progress only in thread projections", () => {
    expect(ruleWorkflow({ ...workflow, steps: [] })).toEqual(workflow);
  });
});
