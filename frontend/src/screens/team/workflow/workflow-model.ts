import {
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import type { MessageKey, Translator } from "../../../i18n/i18n";
import {
  layoutWorkflow,
  savedNodeIds,
  type EdgeCurve,
} from "./workflow-layout";

// References and payloads follow docs/design/agent-team-contract.md.
export interface WorkflowMember {
  avatar?: string;
  avatar_url?: string | null;
  avatar_seed?: string;
  id: string;
  name: string;
  kind: "human" | "agent";
  role: string;
  enabled?: boolean;
  subscriptions?: string[];
}
export interface WorkflowChannel {
  id: string;
  name: string;
  kind: "channel" | "dm";
}
export const RULE_EVENTS = [
  "message",
  "mention",
  "job_finished",
  "plan_approved",
  "conclusion_proposed",
  "review_failed",
  "accepted",
  "changes_requested",
  "schedule",
] as const;
export const RULE_ACTIONS = [
  "wake",
  "review",
  "wait_for_owner",
  "post",
] as const;
// Legacy step actions can also appear in imported workflow data.
const ACTION_LABELS: Record<string, MessageKey> = {
  wake: "teamWorkflow.action.wake",
  review: "teamWorkflow.action.review",
  wait_for_owner: "teamWorkflow.action.wait_for_owner",
  post: "teamWorkflow.action.post",
  conclusion: "teamWorkflow.action.conclusion",
  retrospective: "teamWorkflow.action.retrospective",
  child_research: "teamWorkflow.action.child_research",
};
export const MESSAGE_KINDS = [
  "text",
  "result",
  "plan",
  "conclusion",
  "draft",
  "review",
] as const;
export interface WorkflowRule {
  id: string;
  enabled: boolean;
  when: {
    event: (typeof RULE_EVENTS)[number];
    channel?: string;
    from_role?: string;
    from_member?: string;
    kind?: (typeof MESSAGE_KINDS)[number];
    cron?: string;
    timezone?: string;
  };
  then: {
    action: (typeof RULE_ACTIONS)[number];
    member?: string;
    subscribers?: boolean;
    role?: string;
    instruction?: string;
    on_fail?: string;
    max_rounds?: number;
    channel?: string;
    text?: string;
  };
  limit?: { per_thread?: number };
  position?: XYPosition;
}
export interface Workflow {
  id: string;
  name: string;
  builtin: boolean;
  version: number;
  rules: WorkflowRule[];
  layout: {
    members: Record<string, XYPosition>;
    channels: Record<string, XYPosition>;
  };
}
export interface WorkflowRuntime {
  members: Record<string, "idle" | "working" | "waiting">;
  fired: { rule: string; at: string }[];
}
export interface WorkflowDataProps {
  workflow: Workflow;
  members: WorkflowMember[];
  channels: WorkflowChannel[];
  onChange(workflow: Workflow): void;
  readOnly?: boolean;
}
export type WorkflowNodeTarget = { kind: "member" | "channel"; id: string };
export type WorkflowNode = Node<
  {
    kind: "member" | "channel" | "trigger" | "owner" | "author";
    ref: string;
    name: string;
    status?: WorkflowRuntime["members"][string];
    event?: WorkflowRule["when"]["event"];
    human?: boolean;
    member?: WorkflowMember;
    when?: WorkflowRule["when"];
  },
  "workflow"
>;
type WorkflowEdgeKind =
  | WorkflowRule["then"]["action"]
  | "return"
  | "subscription"
  | "schedule";
export type WorkflowEdge = Edge<{
  rule: string;
  kind: WorkflowEdgeKind;
  rules?: { rule: string; kind: WorkflowEdgeKind }[];
  curve?: EdgeCurve;
}>;

export const nodeId = (kind: WorkflowNode["data"]["kind"], id: string) =>
  `${kind}:${id}`;
export const memberFor = (
  members: WorkflowMember[],
  id?: string,
  role?: string,
) =>
  (id ? members.find((member) => member.id === id) : undefined) ??
  (role ? members.find((member) => member.role === role) : undefined);

export function ruleSummary(
  rule: WorkflowRule,
  members: WorkflowMember[],
  channels: WorkflowChannel[],
  t: Translator["t"],
) {
  const memberName = (id?: string, role?: string) =>
    (id === "$author"
      ? t("teamWorkflow.originalAuthor")
      : memberFor(members, id, role)?.name) ??
    id ??
    role ??
    t("teamWorkflow.anyMember");
  const channelName = (id?: string) =>
    channels.find((channel) => channel.id === id)?.name ?? id;
  const source = [
    channelName(rule.when.channel),
    rule.when.from_member || rule.when.from_role
      ? memberName(rule.when.from_member, rule.when.from_role)
      : "",
    RULE_EVENTS.includes(rule.when.event)
      ? t(`teamWorkflow.event.${rule.when.event}`)
      : "",
    rule.when.kind && MESSAGE_KINDS.includes(rule.when.kind)
      ? t(`teamWorkflow.kind.${rule.when.kind}`)
      : "",
    rule.when.event === "schedule"
      ? `${rule.when.cron ?? ""} ${rule.when.timezone ?? ""}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const actionLabel = Object.hasOwn(ACTION_LABELS, rule.then.action)
    ? t(ACTION_LABELS[rule.then.action])
    : "";
  const target = !actionLabel
    ? ""
    : rule.then.action === "post"
      ? channelName(rule.then.channel)
      : rule.then.action === "wait_for_owner"
        ? t("teamWorkflow.me")
        : rule.then.subscribers
          ? t("members.subscribers")
          : memberName(rule.then.member, rule.then.role);
  const action = [target, actionLabel].filter(Boolean).join(" · ");
  return t("teamWorkflow.summary", { source, action });
}

export function newRule(id: string): WorkflowRule {
  return {
    id,
    enabled: true,
    when: { event: "message" },
    then: { action: "wake" },
    limit: { per_thread: 0 },
  };
}

export function saveRule(workflow: Workflow, rule: WorkflowRule): Workflow {
  const found = workflow.rules.some((item) => item.id === rule.id);
  return {
    ...workflow,
    rules: found
      ? workflow.rules.map((item) => (item.id === rule.id ? rule : item))
      : [...workflow.rules, rule],
  };
}

export function moveRule(workflow: Workflow, id: string, to: number): Workflow {
  const from = workflow.rules.findIndex((rule) => rule.id === id);
  if (from < 0 || to < 0 || to >= workflow.rules.length || from === to)
    return workflow;
  const rules = [...workflow.rules];
  rules.splice(to, 0, rules.splice(from, 1)[0]);
  return { ...workflow, rules };
}

/** Edges carry identity, never a second editable copy of a rule. */
export function edgeToRule(
  edge: WorkflowEdge,
  workflow: Workflow,
): WorkflowRule | undefined {
  return workflow.rules.find((rule) => rule.id === edge.data?.rule);
}

/** Group only the canvas projection; persisted rule identities and order stay intact. */
export function mergeWorkflowEdges(edges: WorkflowEdge[]): WorkflowEdge[] {
  const groups = new Map<string, WorkflowEdge>();
  for (const edge of edges) {
    if (!edge.data) continue;
    const key = JSON.stringify([edge.source, edge.target]);
    const entries = edge.data.rules ?? [
      { rule: edge.data.rule, kind: edge.data.kind },
    ];
    const existing = groups.get(key);
    if (existing) existing.data!.rules!.push(...entries);
    else
      groups.set(key, { ...edge, data: { ...edge.data, rules: [...entries] } });
  }
  return [...groups.values()];
}

export function edgeRules(
  edge: WorkflowEdge,
  workflow: Workflow,
): WorkflowRule[] {
  const ids = new Set(
    (edge.data?.rules ?? (edge.data ? [edge.data] : [])).map(
      (entry) => entry.rule,
    ),
  );
  return workflow.rules.filter((rule) => ids.has(rule.id));
}

export function workflowEdgeLabel(
  edge: WorkflowEdge,
  t: Translator["t"],
): string {
  const counts = new Map<WorkflowEdgeKind, number>();
  for (const { kind } of edge.data?.rules ?? (edge.data ? [edge.data] : []))
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts]
    .map(([kind, count]) => {
      const label = t(
        kind === "return"
          ? "teamWorkflow.return"
          : kind === "subscription"
            ? "teamWorkflow.subscription"
            : kind === "schedule"
              ? "teamWorkflow.event.schedule"
              : `teamWorkflow.action.${kind}`,
      );
      return count === 1
        ? label
        : t("teamWorkflow.edgeCount", { label, count });
    })
    .join(" · ");
}

export function workflowToFlow(
  workflow: Workflow,
  members: WorkflowMember[],
  channels: WorkflowChannel[],
  runtime?: WorkflowRuntime,
) {
  const nodes = new Map<string, WorkflowNode>();
  const edges: WorkflowEdge[] = [];
  const add = (
    kind: WorkflowNode["data"]["kind"],
    ref: string,
    name: string,
    position?: XYPosition,
    event?: WorkflowRule["when"]["event"],
  ) => {
    const id = nodeId(kind, ref);
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        type: "workflow",
        position: position ?? { x: 0, y: 0 },
        data: {
          kind,
          ref,
          name,
          event,
          member:
            kind === "member"
              ? members.find((item) => item.id === ref)
              : undefined,
          human:
            kind === "member" &&
            members.some((item) => item.id === ref && item.kind === "human"),
          status:
            kind === "member" ? (runtime?.members[ref] ?? "idle") : undefined,
        },
        ariaLabel: name,
        focusable: true,
        draggable: kind !== "owner" && kind !== "author",
      });
    return id;
  };
  const member = (id?: string, role?: string) => {
    const value = memberFor(members, id, role);
    const ref = value?.id ?? id;
    return ref
      ? add("member", ref, value?.name ?? ref, workflow.layout.members[ref])
      : undefined;
  };
  const channel = (id: string) =>
    add(
      "channel",
      id,
      channels.find((item) => item.id === id)?.name ?? id,
      workflow.layout.channels[id],
    );
  for (const id of Object.keys(workflow.layout.members)) member(id);
  for (const id of Object.keys(workflow.layout.channels)) channel(id);
  for (const rule of workflow.rules) {
    const source =
      rule.when.event === "schedule"
        ? add(
            "trigger",
            rule.id,
            rule.when.cron ?? "",
            rule.position,
            "schedule",
          )
        : (member(rule.when.from_member, rule.when.from_role) ??
          (rule.when.channel
            ? channel(rule.when.channel)
            : add("trigger", rule.id, "", rule.position, rule.when.event)));
    // A channel filter remains visible even when an author is the source.
    if (rule.when.channel) channel(rule.when.channel);
    if (nodes.get(source)?.data.kind === "trigger")
      nodes.get(source)!.data.when = rule.when;
    let target: string | undefined;
    if (rule.then.action === "post") {
      if (rule.then.channel) target = channel(rule.then.channel);
    } else if (rule.then.action === "wait_for_owner") {
      const owner =
        members.find(
          (item) => item.role === "owner" && item.kind === "human",
        ) ?? members.find((item) => item.kind === "human");
      target = owner ? member(owner.id) : add("owner", "owner", "");
    } else if (rule.then.subscribers) {
      for (const subscriber of members.filter(
        (m) =>
          m.kind === "agent" &&
          m.enabled !== false &&
          (rule.when.channel
            ? m.subscriptions?.includes(rule.when.channel)
            : !!m.subscriptions?.length),
      )) {
        const subscriberTarget = member(subscriber.id);
        if (subscriberTarget)
          edges.push({
            id: `subscriber:${rule.id}:${subscriber.id}`,
            source,
            target: subscriberTarget,
            sourceHandle: "out",
            targetHandle: "in",
            type: "workflow",
            data: { rule: rule.id, kind: "subscription" },
            focusable: true,
            reconnectable: false,
          });
      }
      continue;
    } else
      target =
        rule.then.member === "$author"
          ? add("author", "$author", "")
          : member(rule.then.member, rule.then.role);
    // Incomplete rules still have an editable event node, without inventing references.
    if (!target) {
      add("trigger", rule.id, "", rule.position, rule.when.event);
      continue;
    }
    const kind =
      rule.when.event === "schedule"
        ? "schedule"
        : rule.then.action === "wake" &&
            rule.when.event === "message" &&
            rule.when.channel &&
            !rule.when.from_member &&
            !rule.when.from_role
          ? "subscription"
          : rule.then.action;
    edges.push({
      id: `rule:${rule.id}`,
      source,
      target,
      sourceHandle: "out",
      targetHandle: "in",
      type: "workflow",
      data: { rule: rule.id, kind },
      focusable: true,
      reconnectable: false,
    });
    if (rule.then.action === "review" && rule.then.on_fail) {
      const back = member(rule.then.on_fail, rule.then.on_fail);
      if (back)
        edges.push({
          id: `return:${rule.id}`,
          source: target,
          target: back,
          sourceHandle: "back-out",
          targetHandle: "back-in",
          type: "workflow",
          data: { rule: rule.id, kind: "return" },
          focusable: true,
          reconnectable: false,
        });
    }
  }
  return {
    nodes: layoutWorkflow([...nodes.values()], edges, savedNodeIds(workflow)),
    edges,
  };
}

/** A connection seeds the shared editor; only Save adds it to the workflow. */
export function connectionToRule(
  connection: Connection,
  nodes: WorkflowNode[],
  id: string,
): WorkflowRule | undefined {
  const source = nodes.find((node) => node.id === connection.source)?.data;
  const target = nodes.find((node) => node.id === connection.target)?.data;
  if (!source || !target || target.kind === "trigger") return undefined;
  const rule = newRule(id);
  if (source.kind === "member") rule.when.from_member = source.ref;
  if (source.kind === "channel") rule.when.channel = source.ref;
  if (source.kind === "trigger") {
    rule.when = { ...source.when, event: source.event ?? "message" };
  }
  if (target.kind === "channel")
    rule.then = { action: "post", channel: target.ref };
  else if (target.kind === "owner" || target.human)
    rule.then = { action: "wait_for_owner" };
  else if (target.kind === "author") rule.then.member = "$author";
  else rule.then.member = target.ref;
  return rule;
}

/** Preserve off-canvas positions and all rule fields when persisting a move. */
export function layoutFromNodes(
  workflow: Workflow,
  nodes: WorkflowNode[],
): Workflow {
  const layout = {
    members: { ...workflow.layout.members },
    channels: { ...workflow.layout.channels },
  };
  const positions = new Map<string, XYPosition>();
  for (const { data, position } of nodes) {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    if (data.kind === "member") layout.members[data.ref] = { ...position };
    if (data.kind === "channel") layout.channels[data.ref] = { ...position };
    if (data.kind === "trigger") positions.set(data.ref, { ...position });
  }
  return {
    ...workflow,
    layout,
    rules: workflow.rules.map((rule) =>
      positions.has(rule.id)
        ? { ...rule, position: positions.get(rule.id)! }
        : rule,
    ),
  };
}

export function updateCanvasNodes(
  workflow: Workflow,
  nodes: WorkflowNode[],
  changes: NodeChange<WorkflowNode>[],
  onChange: WorkflowDataProps["onChange"],
): WorkflowNode[] {
  const next = applyNodeChanges(changes, nodes);
  if (
    changes.some(
      (change) =>
        change.type === "position" && change.position && !change.dragging,
    )
  )
    onChange(
      layoutFromNodes(
        workflow,
        next.filter((node) =>
          changes.some(
            (change) =>
              change.type === "position" &&
              change.id === node.id &&
              change.position &&
              !change.dragging,
          ),
        ),
      ),
    );
  return next;
}

export function validateRule(rule: WorkflowRule): boolean {
  if (
    rule.then.member === "$author" &&
    !["accepted", "changes_requested"].includes(rule.when.event)
  )
    return false;
  const perThread = rule.limit?.per_thread ?? 0;
  if (!Number.isSafeInteger(perThread) || perThread < 0) return false;
  if (rule.when.event === "schedule") {
    if (!validCron(rule.when.cron ?? "") || !rule.when.timezone) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: rule.when.timezone });
    } catch {
      return false;
    }
  }
  if (rule.then.action === "wake" || rule.then.action === "review") {
    if (
      Number(!!rule.then.member) +
        Number(!!rule.then.role?.trim()) +
        Number(!!rule.then.subscribers) !==
      1
    )
      return false;
    if (
      rule.then.subscribers &&
      (rule.then.action !== "wake" || rule.when.event !== "message")
    )
      return false;
  }
  if (
    rule.then.action === "review" &&
    (!rule.then.on_fail ||
      !Number.isSafeInteger(rule.then.max_rounds ?? 0) ||
      (rule.then.max_rounds ?? 0) < 0)
  )
    return false;
  return (
    rule.then.action !== "post" ||
    !!(rule.then.channel && rule.then.text?.trim())
  );
}

function validCron(value: string) {
  const fields = value.trim().split(/\s+/);
  return (
    fields.length === 5 &&
    fields.every((field, index) =>
      field.split(",").every((part) => {
        const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
        if (!match || (match[2] && Number(match[2]) < 1)) return false;
        if (match[1] === "*") return true;
        const [start, end = start] = match[1].split("-").map(Number);
        return (
          start >= [0, 0, 1, 1, 0][index] &&
          end <= [59, 23, 31, 12, 7][index] &&
          start <= end
        );
      }),
    )
  );
}

export function recentFired(
  runtime: WorkflowRuntime | undefined,
  now: number,
): Set<string> {
  return new Set(
    (runtime?.fired ?? [])
      .filter(({ at }) => {
        const age = now - Date.parse(at);
        return age >= 0 && age < 1600;
      })
      .map(({ rule }) => rule),
  );
}
