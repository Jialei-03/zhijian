import type { Connection } from "@xyflow/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/I18nProvider";
import { createTranslator } from "../../../i18n/i18n";
import {
  workflowChannels as channels,
  workflowFixture,
  workflowMembers as members,
} from "../../../ui-kit/workflow-fixture";
import { RuleEditor } from "./RuleEditor";
import { WorkflowRules } from "./WorkflowRules";
import {
  connectionToRule,
  edgeToRule,
  layoutFromNodes,
  moveRule,
  newRule,
  recentFired,
  ruleSummary,
  saveRule,
  validateRule,
  workflowToFlow,
  updateCanvasNodes,
  type Workflow,
  type WorkflowRule,
} from "./workflow-model";

const fixture = () => structuredClone(workflowFixture);
const graph = (workflow = fixture()) =>
  workflowToFlow(workflow, members, channels);
const connect = (source: string, target: string): Connection => ({
  source,
  target,
  sourceHandle: "out",
  targetHandle: "in",
});

describe("contract rules and flow edges", () => {
  it("preserves decision events and the dynamic original-author target", () => {
    for (const event of ["accepted", "changes_requested"] as const) {
      const rule: WorkflowRule = {
        id: "decision",
        enabled: true,
        when: { event },
        then: { action: "wake", member: "$author" },
      };
      expect(validateRule(rule)).toBe(true);
      const flow = { ...fixture(), rules: [rule] };
      const { nodes, edges } = graph(flow);
      expect(
        nodes.find((node) => node.id === "author:$author")?.data.kind,
      ).toBe("author");
      expect(edges[0].target).toBe("author:$author");
      expect(layoutFromNodes(flow, nodes).layout.members).not.toHaveProperty(
        "$author",
      );
      for (const locale of ["zh", "en"] as const) {
        const { t } = createTranslator(locale);
        expect(ruleSummary(rule, members, channels, t)).toContain(
          t("teamWorkflow.originalAuthor"),
        );
        expect(ruleSummary(rule, members, channels, t)).toContain(
          t(`teamWorkflow.event.${event}`),
        );
      }
    }
  });
  it("projects reviews, return lines, owner waits, subscriptions and schedules without losing fields", () => {
    const workflow = fixture();
    const before = structuredClone(workflow);
    const { nodes, edges } = graph(workflow);
    expect(
      edges.map((edge) => [edge.data?.kind, edge.source, edge.target]),
    ).toEqual([
      ["review", "member:executor", "member:reviewer"],
      ["return", "member:reviewer", "member:executor"],
      ["wait_for_owner", "member:reviewer", "member:owner"],
      ["subscription", "channel:papers", "member:executor"],
      ["schedule", "trigger:schedule", "channel:papers"],
    ]);
    for (const edge of edges)
      expect(edgeToRule(edge, workflow)).toBe(
        workflow.rules.find((rule) => rule.id === edge.data?.rule),
      );
    expect(
      nodes.find((node) => node.id === "trigger:schedule")?.position,
    ).toEqual({ x: 0, y: 380 });
    expect(nodes.find((node) => node.id === "channel:lab")?.data.name).toBe(
      "Lab",
    );
    expect(workflow).toEqual(before);
    expect(
      edgeToRule({ ...edges[0], data: undefined }, workflow),
    ).toBeUndefined();
  });

  it("maps role-based return targets to member IDs, and generic events to editable trigger nodes", () => {
    const workflow = fixture();
    workflow.rules[0].then.on_fail = "writer";
    const wake = newRule("generic");
    wake.when.event = "job_finished";
    wake.then.role = "writer";
    workflow.rules.push(wake);
    const { nodes, edges } = graph(workflow);
    expect(edges.find((edge) => edge.id === "return:review")?.target).toBe(
      "member:writer",
    );
    expect(edges.find((edge) => edge.id === "rule:generic")).toMatchObject({
      source: "trigger:generic",
      target: "member:writer",
      data: { kind: "wake" },
    });
    expect(
      nodes.find((node) => node.id === "trigger:generic")?.data.event,
    ).toBe("job_finished");
  });

  it("keeps owner waits editable without creating a member record", () => {
    const workflow = fixture();
    const { nodes, edges } = workflowToFlow(
      workflow,
      members.filter((member) => member.kind !== "human"),
      channels,
    );
    expect(
      edges.find((edge) => edge.data?.kind === "wait_for_owner")?.target,
    ).toBe("owner:owner");
    expect(nodes.find((node) => node.id === "owner:owner")?.draggable).toBe(
      false,
    );
  });

  it("seeds the shared editor from connections; schedule filters and the human target survive", () => {
    const nodes = graph().nodes;
    expect(
      connectionToRule(
        connect("member:executor", "member:reviewer"),
        nodes,
        "new",
      ),
    ).toMatchObject({
      id: "new",
      when: { event: "message", from_member: "executor" },
      then: { action: "wake", member: "reviewer" },
    });
    expect(
      connectionToRule(
        connect("channel:papers", "member:executor"),
        nodes,
        "new",
      ),
    ).toMatchObject({
      when: { channel: "papers" },
      then: { action: "wake", member: "executor" },
    });
    expect(
      connectionToRule(connect("member:reviewer", "member:owner"), nodes, "new")
        ?.then,
    ).toEqual({ action: "wait_for_owner" });
    expect(
      connectionToRule(
        connect("trigger:schedule", "channel:papers"),
        nodes,
        "new",
      ),
    ).toMatchObject({
      when: workflowFixture.rules[3].when,
      then: { action: "post", channel: "papers" },
    });
    expect(
      connectionToRule(connect("missing", "member:owner"), nodes, "new"),
    ).toBeUndefined();
    expect(
      connectionToRule(
        connect("member:executor", "trigger:schedule"),
        nodes,
        "new",
      ),
    ).toBeUndefined();
  });
});

describe("editing and ordering the one workflow", () => {
  it("updates a review from either line, keeping its identity, position, limits and ordering", () => {
    const workflow = fixture();
    const edge = graph(workflow).edges.find(
      (edge) => edge.data?.kind === "return",
    )!;
    const rule = structuredClone(edgeToRule(edge, workflow)!);
    rule.then.instruction = "Check again";
    rule.then.max_rounds = 5;
    rule.limit = { per_thread: 7 };
    rule.enabled = false;
    const next = saveRule(workflow, rule);
    expect(next.rules[0]).toEqual(rule);
    expect(next.rules.map((item) => item.id)).toEqual(
      workflow.rules.map((item) => item.id),
    );
    expect(edgeToRule(graph(next).edges[0], next)?.enabled).toBe(false);
    expect(workflow.rules[0].then.instruction).toBe("Check results");
    expect(next.layout).toBe(workflow.layout);
    const created = newRule("new");
    expect(created.limit?.per_thread).toBe(0);
    expect(saveRule(next, created).rules.at(-1)).toBe(created);
  });

  it("reorders with stable IDs and respects keyboard/menu boundaries", () => {
    const workflow = fixture();
    expect(
      moveRule(workflow, "review", 2).rules.map((rule) => rule.id),
    ).toEqual(["wait", "subscribe", "review", "schedule"]);
    expect(
      moveRule(workflow, "schedule", 0).rules.map((rule) => rule.id),
    ).toEqual(["schedule", "review", "wait", "subscribe"]);
    for (const [id, to] of [
      ["missing", 0],
      ["review", -1],
      ["review", 4],
      ["review", 0],
    ] as const)
      expect(moveRule(workflow, id, to)).toBe(workflow);
    expect(workflow.rules[0].id).toBe("review");
  });

  it("validates required references, integer limits, cron ranges and time zones", () => {
    for (const rule of fixture().rules) expect(validateRule(rule)).toBe(true);
    const rule = newRule("new");
    expect(validateRule(rule)).toBe(false);
    rule.then.member = "executor";
    expect(validateRule(rule)).toBe(true);
    for (const limit of [-1, 1.5, NaN, Infinity])
      expect(validateRule({ ...rule, limit: { per_thread: limit } })).toBe(
        false,
      );
    const review = fixture().rules[0];
    expect(
      validateRule({ ...review, then: { ...review.then, on_fail: undefined } }),
    ).toBe(false);
    for (const maximum of [-1, 1.5, NaN, Infinity])
      expect(
        validateRule({
          ...review,
          then: { ...review.then, max_rounds: maximum },
        }),
      ).toBe(false);
    for (const limit of [undefined, {}, { per_thread: 0 }])
      for (const maximum of [undefined, 0, 5])
        expect(
          validateRule({
            ...review,
            limit,
            then: { ...review.then, max_rounds: maximum },
          }),
        ).toBe(true);
    const schedule = fixture().rules[3];
    for (const cron of [
      "0 9 * *",
      "60 9 * * *",
      "0 25 * * *",
      "*/0 * * * *",
      "0 9 32 * *",
      "0 9 * 13 *",
    ])
      expect(
        validateRule({ ...schedule, when: { ...schedule.when, cron } }),
        cron,
      ).toBe(false);
    expect(
      validateRule({
        ...schedule,
        when: { ...schedule.when, cron: "*/15 8-18 * * 1,3,5" },
      }),
    ).toBe(true);
    expect(
      validateRule({
        ...schedule,
        when: { ...schedule.when, timezone: "Invalid/Zone" },
      }),
    ).toBe(false);
    expect(
      validateRule({
        ...schedule,
        then: { action: "post", channel: "papers", text: " " },
      }),
    ).toBe(false);
  });
});

describe("layout and runtime overlays", () => {
  it("round-trips member, channel and clock moves through the onChange payload", () => {
    const workflow = fixture();
    const nodes = graph(workflow).nodes;
    const onChange = vi.fn<(workflow: Workflow) => void>();
    updateCanvasNodes(
      workflow,
      nodes,
      [
        {
          type: "position",
          id: "member:executor",
          position: { x: 25, y: -30 },
          dragging: false,
        },
        {
          type: "position",
          id: "channel:lab",
          position: { x: 450, y: 200 },
          dragging: false,
        },
        {
          type: "position",
          id: "trigger:schedule",
          position: { x: 40, y: 500 },
          dragging: false,
        },
      ],
      onChange,
    );
    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0][0];
    expect(next.layout.members.executor).toEqual({ x: 25, y: -30 });
    expect(next.layout.channels.lab).toEqual({ x: 450, y: 200 });
    expect(next.rules[3].position).toEqual({ x: 40, y: 500 });
    expect(next.rules[0]).toEqual(workflow.rules[0]);
    expect(next.version).toBe(workflow.version);
    expect(
      graph(next).nodes.find((node) => node.id === "member:executor")?.position,
    ).toEqual({ x: 25, y: -30 });
    expect(workflow.layout.members.executor).toEqual({ x: 0, y: 0 });
  });

  it("preserves off-canvas layout and ignores invalid coordinates", () => {
    const workflow = fixture();
    const node = graph(workflow).nodes[0];
    const next = layoutFromNodes(workflow, [
      { ...node, position: { x: NaN, y: 0 } },
    ]);
    expect(next).toEqual(workflow);
  });

  it("keeps selection and an in-progress drag local until a completed position change", () => {
    const workflow = fixture();
    const onChange = vi.fn();
    const next = updateCanvasNodes(
      workflow,
      graph(workflow).nodes,
      [
        { type: "select", id: "member:executor", selected: true },
        {
          type: "position",
          id: "member:executor",
          position: { x: 70, y: 90 },
          dragging: true,
        },
      ],
      onChange,
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(
      next.find((node) => node.id === "member:executor")?.position,
    ).toEqual({ x: 70, y: 90 });
    updateCanvasNodes(
      workflow,
      next,
      [
        {
          type: "position",
          id: "member:executor",
          position: { x: 70, y: 90 },
          dragging: false,
        },
      ],
      onChange,
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        layout: expect.objectContaining({
          members: expect.objectContaining({ executor: { x: 70, y: 90 } }),
        }),
      }),
    );
  });

  it("overlays member status and expires fired edges without changing rules", () => {
    const now = Date.parse("2026-10-23T09:00:00Z");
    const runtime = {
      members: { executor: "working" as const, reviewer: "waiting" as const },
      fired: [
        { rule: "review", at: new Date(now - 100).toISOString() },
        { rule: "wait", at: new Date(now - 1600).toISOString() },
        { rule: "schedule", at: "invalid" },
        { rule: "future", at: new Date(now + 100).toISOString() },
      ],
    };
    const nodes = workflowToFlow(fixture(), members, channels, runtime).nodes;
    expect(
      nodes.find((node) => node.id === "member:executor")?.data.status,
    ).toBe("working");
    expect(
      nodes.find((node) => node.id === "member:reviewer")?.data.status,
    ).toBe("waiting");
    expect(recentFired(runtime, now)).toEqual(new Set(["review"]));
    expect(recentFired(runtime, now + 2000)).toEqual(new Set());
  });
});

describe("localized list and shared editor", () => {
  for (const locale of ["en", "zh"] as const) {
    const t = createTranslator(locale).t;
    const render = (child: ReturnType<typeof createElement>) =>
      renderToStaticMarkup(
        createElement(I18nProvider, { locale, children: child }),
      );
    for (const maximum of [undefined, 0])
      it(`${locale} renders missing/zero (${maximum}) limits as unlimited`, () => {
        const rule = {
          ...fixture().rules[0],
          limit: maximum === undefined ? undefined : { per_thread: maximum },
          then: { ...fixture().rules[0].then, max_rounds: maximum },
        };
        expect(ruleSummary(rule, members, channels, t)).not.toContain(
          t("team.unlimited"),
        );
        const editor = render(
          createElement(RuleEditor, {
            rule,
            members,
            channels,
            onSave: vi.fn(),
            onClose: vi.fn(),
          }),
        );
        const limits = editor.match(/<input[^>]*type="number"[^>]*>/g)!;
        expect(limits).toHaveLength(2);
        for (const input of limits) {
          expect(input).toContain(`placeholder="${t("team.unlimited")}"`);
          expect(input).toContain('value=""');
          expect(input).toContain('min="0"');
          expect(input).not.toContain("required");
        }
      });
    it(`${locale} displays names and provides the review editor fields`, () => {
      const workflow = fixture();
      const summary = ruleSummary(workflow.rules[0], members, channels, t);
      expect(summary).toContain("Alex");
      expect(summary).toContain("Morgan");
      expect(summary).toContain("Lab");
      expect(summary).toBe(
        locale === "en"
          ? "When Lab · Alex · Message received · Result → Morgan · Review"
          : "当 Lab · Alex · 收到消息 · 结果 时 → Morgan · 评审",
      );
      const html = render(
        createElement(WorkflowRules, {
          workflow,
          members,
          channels,
          onChange: vi.fn(),
          onEdit: vi.fn(),
        }),
      );
      expect(html).toContain(summary);
      expect(html).toContain('role="switch"');
      const editor = render(
        createElement(RuleEditor, {
          rule: workflow.rules[0],
          members,
          channels,
          onSave: vi.fn(),
          onClose: vi.fn(),
        }),
      );
      for (const key of [
        "event",
        "fromMember",
        "member",
        "action",
        "instruction",
        "onFail",
        "rounds",
        "limit",
      ] as const)
        expect(editor).toContain(t(`teamWorkflow.${key}`));
      expect(editor).not.toContain("description=");
    });

    it(`${locale} localizes every contract and legacy action without including instructions`, () => {
      for (const action of [
        "wake",
        "review",
        "wait_for_owner",
        "post",
        "conclusion",
        "retrospective",
        "child_research",
      ] as const) {
        const rule = {
          ...fixture().rules[0],
          then: {
            ...fixture().rules[0].then,
            action: action as WorkflowRule["then"]["action"],
            instruction:
              "结论: 总结实验结论\naction: conclusion\naction: retrospective",
            text: "Full channel post",
            channel: "papers",
          },
        };
        const summary = ruleSummary(rule, members, channels, t);
        expect(summary).toContain(t(`teamWorkflow.action.${action}`));
        expect(summary).not.toMatch(
          /action:|instruction:|conclusion|retrospective|\n/,
        );
        expect(summary).not.toContain(rule.then.text);
        expect(summary).not.toContain(
          t("teamWorkflow.returnTo", { name: "Alex", count: 3 }),
        );
        if (action === "post") expect(summary).toContain("Papers");
        if (action === "wait_for_owner")
          expect(summary).toContain(t("teamWorkflow.me"));
      }
    });

    it(`${locale} ignores unknown fields and enum values`, () => {
      const rule = fixture().rules[0];
      const summary = ruleSummary(rule, members, channels, t);
      const extended = {
        ...rule,
        unknown: "private metadata",
        when: { ...rule.when, unknown: "private trigger" },
        then: { ...rule.then, unknown: "private action" },
      };
      expect(ruleSummary(extended, members, channels, t)).toBe(summary);
      const future = {
        ...extended,
        when: { ...extended.when, event: "future_event", kind: "future_kind" },
        then: { ...extended.then, action: "future_action" },
      } as unknown as WorkflowRule;
      expect(ruleSummary(future, members, channels, t)).toBe(
        t("teamWorkflow.summary", { source: "Lab · Alex", action: "" }),
      );
    });

    it(`${locale} keeps the complete instruction in the editor only`, () => {
      const rule = fixture().rules[0];
      rule.then.instruction = "Detailed instruction\naction: retrospective";
      const before = structuredClone(rule);
      const list = render(
        createElement(WorkflowRules, {
          workflow: { ...fixture(), rules: [rule] },
          members,
          channels,
          onChange: vi.fn(),
          onEdit: vi.fn(),
        }),
      );
      expect(list).not.toContain("Detailed instruction");
      expect(list).not.toContain("action:");
      const editor = render(
        createElement(RuleEditor, {
          rule,
          members,
          channels,
          onSave: vi.fn(),
          onClose: vi.fn(),
        }),
      );
      expect(editor).toContain(rule.then.instruction);
      expect(rule).toEqual(before);
    });
  }
});
