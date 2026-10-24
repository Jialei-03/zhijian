import type {
  Workflow,
  WorkflowChannel,
  WorkflowMember,
} from "../screens/team/workflow/workflow-model";

// Shared only by unit tests and the isolated e2e-ui entry.
export const workflowMembers: WorkflowMember[] = [
  { id: "owner", name: "Leslie", kind: "human", role: "owner" },
  { id: "executor", name: "Alex", kind: "agent", role: "executor" },
  { id: "reviewer", name: "Morgan", kind: "agent", role: "reviewer" },
  { id: "writer", name: "Sam", kind: "agent", role: "writer" },
];
export const workflowChannels: WorkflowChannel[] = [
  { id: "lab", name: "Lab", kind: "channel" },
  { id: "papers", name: "Papers", kind: "channel" },
  { id: "writing", name: "Writing", kind: "channel" },
];
export const workflowFixture: Workflow = {
  id: "test-workflow",
  name: "Research",
  builtin: false,
  version: 1,
  rules: [
    {
      id: "review",
      enabled: true,
      when: {
        event: "message",
        channel: "lab",
        from_member: "executor",
        kind: "result",
      },
      then: {
        action: "review",
        member: "reviewer",
        instruction: "Check results",
        on_fail: "executor",
        max_rounds: 3,
      },
      limit: { per_thread: 10 },
    },
    {
      id: "wait",
      enabled: true,
      when: { event: "conclusion_proposed", from_role: "reviewer" },
      then: { action: "wait_for_owner" },
      limit: { per_thread: 5 },
    },
    {
      id: "subscribe",
      enabled: true,
      when: { event: "message", channel: "papers" },
      then: { action: "wake", role: "executor" },
      limit: { per_thread: 10 },
    },
    {
      id: "schedule",
      enabled: true,
      when: {
        event: "schedule",
        cron: "0 9 * * *",
        timezone: "Asia/Singapore",
      },
      then: { action: "post", channel: "papers", text: "Daily papers" },
      limit: { per_thread: 1 },
      position: { x: 0, y: 380 },
    },
  ],
  layout: {
    members: {
      executor: { x: 0, y: 0 },
      reviewer: { x: 340, y: 0 },
      owner: { x: 680, y: 0 },
    },
    channels: { lab: { x: 0, y: 190 }, papers: { x: 340, y: 190 } },
  },
};

// Research topology with parallel channel rules, review feedback and a self-loop.
export const researchWorkflowFixture: Workflow = {
  id: "research",
  name: "Research",
  builtin: true,
  version: 1,
  rules: [
    {
      id: "research:start",
      enabled: true,
      when: {
        event: "message",
        from_role: "owner",
        channel: "lab",
      },
      then: {
        action: "wake",
        role: "advisor",
      },
      limit: {
        per_thread: 0,
      },
    },
    {
      id: "research:approved-start",
      enabled: true,
      when: {
        event: "plan_approved",
        from_role: "owner",
        channel: "lab",
      },
      then: {
        action: "wake",
        role: "executor",
      },
      limit: {
        per_thread: 0,
      },
    },
    {
      id: "research:0:wait",
      enabled: true,
      when: {
        event: "message",
        from_role: "advisor",
        kind: "plan",
        channel: "lab",
      },
      then: {
        action: "wait_for_owner",
      },
      limit: {
        per_thread: 0,
      },
    },
    {
      id: "research:1:result",
      enabled: true,
      when: {
        event: "message",
        from_role: "executor",
        kind: "result",
        channel: "lab",
      },
      then: {
        action: "review",
        role: "advisor",
        on_fail: "executor",
      },
      limit: {
        per_thread: 0,
      },
    },
    {
      id: "research:1:review",
      enabled: true,
      when: {
        event: "message",
        from_role: "advisor",
        kind: "review",
        channel: "lab",
      },
      then: {
        action: "wake",
        role: "executor",
      },
      limit: {
        per_thread: 0,
      },
    },
    {
      id: "research:1:job",
      enabled: true,
      when: {
        event: "job_finished",
      },
      then: {
        action: "wake",
        role: "executor",
      },
      limit: {
        per_thread: 0,
      },
    },
    {
      id: "research:1:wait",
      enabled: true,
      when: {
        event: "conclusion_proposed",
        from_role: "advisor",
        channel: "lab",
      },
      then: {
        action: "wait_for_owner",
      },
      limit: {
        per_thread: 0,
      },
    },
    {
      id: "research:1:approved",
      enabled: true,
      when: {
        event: "plan_approved",
        from_role: "owner",
        kind: "conclusion",
        channel: "lab",
      },
      then: {
        action: "wake",
        role: "distiller",
      },
      limit: {
        per_thread: 0,
      },
    },
    {
      id: "research:2:continue",
      enabled: true,
      when: {
        event: "message",
        from_role: "distiller",
        kind: "text",
        channel: "lab",
      },
      then: {
        action: "wake",
        role: "distiller",
      },
      limit: {
        per_thread: 0,
      },
    },
    {
      id: "research:2:done",
      enabled: true,
      when: {
        event: "message",
        from_role: "distiller",
        kind: "result",
        channel: "lab",
      },
      then: {
        action: "wait_for_owner",
      },
      limit: {
        per_thread: 0,
      },
    },
    {
      id: "research:discuss-conclusion",
      enabled: true,
      when: {
        event: "message",
        from_role: "owner",
        kind: "text",
        channel: "lab",
      },
      then: {
        action: "wake",
        role: "advisor",
      },
      limit: {
        per_thread: 0,
      },
    },
    {
      id: "research:reopen",
      enabled: true,
      when: {
        event: "plan_approved",
        from_role: "owner",
        kind: "result",
        channel: "lab",
      },
      then: {
        action: "wake",
        role: "executor",
      },
      limit: {
        per_thread: 0,
      },
    },
    ...(["job_finished", "plan_approved", "review_failed"] as const).map(
      (event) => ({
        id: `research:lab:${event}`,
        enabled: true,
        when: { event, channel: "lab" },
        then: { action: "wake" as const, role: "executor" },
      }),
    ),
  ],
  layout: {
    members: {},
    channels: {},
  },
};
export const researchWorkflowMembers: WorkflowMember[] = [
  { id: "owner", name: "Leslie", kind: "human", role: "owner" },
  { id: "advisor", name: "Advisor", kind: "agent", role: "advisor" },
  { id: "executor", name: "Alex", kind: "agent", role: "executor" },
  { id: "distiller", name: "Distiller", kind: "agent", role: "distiller" },
];
