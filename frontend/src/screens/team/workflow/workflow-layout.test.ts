import { describe, expect, it } from "vitest";
import { createTranslator } from "../../../i18n/i18n";
import {
  researchWorkflowFixture,
  researchWorkflowMembers,
  workflowChannels,
  workflowFixture,
  workflowMembers,
} from "../../../ui-kit/workflow-fixture";
import {
  layoutFromNodes,
  mergeWorkflowEdges,
  edgeRules,
  workflowEdgeLabel,
  workflowToFlow,
  updateCanvasNodes,
  type WorkflowNode,
} from "./workflow-model";
import {
  layoutWorkflow,
  nodeBox,
  curvePath,
  curveWorkflowEdges,
  workflowViewport,
  savedNodeIds,
  workflowBounds,
} from "./workflow-layout";

const graph = () => {
  const workflow = structuredClone(workflowFixture);
  workflow.layout = { members: {}, channels: {} };
  delete workflow.rules[3].position;
  return {
    workflow,
    ...workflowToFlow(workflow, workflowMembers, workflowChannels),
  };
};
const intersects = (
  a: ReturnType<typeof nodeBox>,
  b: ReturnType<typeof nodeBox>,
) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;
const positions = (nodes: WorkflowNode[]) =>
  Object.fromEntries(nodes.map((node) => [node.id, node.position]));
const expectNoOverlap = (nodes: WorkflowNode[]) => {
  for (const [index, node] of nodes.entries())
    for (const other of nodes.slice(index + 1))
      expect(
        intersects(nodeBox(node), nodeBox(other)),
        `${node.id} / ${other.id}`,
      ).toBe(false);
};

describe("workflow layered layout", () => {
  it("is deterministic across input ordering and leaves space between layers", () => {
    const { nodes, edges } = graph();
    const before = structuredClone(nodes);
    const laidOut = layoutWorkflow(nodes, edges);
    expect(
      positions(layoutWorkflow([...nodes].reverse(), [...edges].reverse())),
    ).toEqual(positions(laidOut));
    for (const [index, node] of laidOut.entries())
      for (const other of laidOut.slice(index + 1))
        expect(
          intersects(nodeBox(node), nodeBox(other)),
          `${node.id} / ${other.id}`,
        ).toBe(false);
    const at = positions(laidOut);
    expect(at["member:owner"].x).toBe(at["trigger:schedule"].x);
    expect(at["trigger:schedule"].x).toBeLessThan(at["channel:papers"].x);
    expect(at["channel:papers"].x + 168 + 120).toBeLessThanOrEqual(
      at["member:executor"].x,
    );
    expect(at["member:executor"].x).toBeLessThan(at["member:reviewer"].x);
    expect(nodes).toEqual(before);
    expect(layoutWorkflow([], [])).toEqual([]);
  });

  it("handles cycles, self edges, disconnected nodes and measured sizes without overlap", () => {
    const { nodes, edges } = graph();
    const measured = nodes.map((node) => ({
      ...node,
      measured: { width: 400, height: 240 },
    }));
    const cyclic = [
      ...edges,
      {
        ...edges[0],
        id: "cycle",
        source: "member:reviewer",
        target: "channel:papers",
      },
      { ...edges[0], id: "self", target: edges[0].source },
    ];
    const laidOut = layoutWorkflow(measured, cyclic);
    for (const [index, node] of laidOut.entries())
      for (const other of laidOut.slice(index + 1))
        expect(intersects(nodeBox(node), nodeBox(other))).toBe(false);
    expect(layoutWorkflow(measured, cyclic)).toEqual(laidOut);
  });

  it("preserves saved coordinates, avoids pinned nodes and persists only completed moves", () => {
    const { workflow, nodes, edges } = graph();
    const pinned = { x: 492, y: 0 };
    workflow.layout.members.owner = pinned;
    const next = layoutWorkflow(
      nodes.map((node) =>
        node.id === "member:owner" ? { ...node, position: pinned } : node,
      ),
      edges,
      savedNodeIds(workflow),
    );
    expect(positions(next)["member:owner"]).toEqual(pinned);
    for (const other of next.filter((node) => node.id !== "member:owner"))
      expect(
        intersects({ ...pinned, width: 168, height: 44 }, nodeBox(other)),
      ).toBe(false);
    let saved = workflow;
    updateCanvasNodes(
      workflow,
      next,
      [
        {
          type: "position",
          id: "member:executor",
          position: { x: -40, y: 80 },
          dragging: false,
        },
      ],
      (value) => {
        saved = value;
      },
    );
    expect(saved.layout.members).toEqual({
      owner: pinned,
      executor: { x: -40, y: 80 },
    });
    expect(saved.layout.channels).toEqual({});
    expect(saved.rules[3].position).toBeUndefined();
    const arranged = layoutWorkflow(next, edges);
    expect(positions(arranged)["member:owner"]).not.toEqual(pinned);
    const roundTrip = workflowToFlow(
      layoutFromNodes(saved, arranged),
      workflowMembers,
      workflowChannels,
    );
    expect(positions(roundTrip.nodes)).toEqual(positions(arranged));
  });
});

describe("grouped workflow edges", () => {
  it("merges fifteen research rules into ten directed pairs without losing rules", () => {
    const workflow = structuredClone(researchWorkflowFixture);
    const { nodes, edges } = workflowToFlow(
      workflow,
      researchWorkflowMembers,
      workflowChannels,
    );
    expect(workflow.rules).toHaveLength(15);
    expect(nodes).toHaveLength(6);
    expect(edges).toHaveLength(16);
    const grouped = mergeWorkflowEdges(edges);
    expect(grouped).toHaveLength(10);
    expect(
      new Set(grouped.map((edge) => JSON.stringify([edge.source, edge.target])))
        .size,
    ).toBe(grouped.length);
    expect(
      new Set(
        grouped.flatMap((edge) =>
          edgeRules(edge, workflow).map((rule) => rule.id),
        ),
      ),
    ).toEqual(new Set(workflow.rules.map((rule) => rule.id)));
    const wake = grouped.find(
      (edge) =>
        edge.source === "member:owner" && edge.target === "member:executor",
    )!;
    expect(edgeRules(wake, workflow).map((rule) => rule.id)).toEqual([
      "research:approved-start",
      "research:reopen",
    ]);
    const labWake = grouped.find(
      (edge) =>
        edge.source === "channel:lab" && edge.target === "member:executor",
    )!;
    expect(edgeRules(labWake, workflow).map((rule) => rule.id)).toEqual([
      "research:lab:job_finished",
      "research:lab:plan_approved",
      "research:lab:review_failed",
    ]);
    for (const locale of ["zh", "en"] as const) {
      const t = createTranslator(locale).t;
      expect(workflowEdgeLabel(labWake, t)).toBe(
        locale === "zh" ? "唤醒 ×3" : "Wake ×3",
      );
      expect(workflowEdgeLabel(wake, t)).toBe(
        locale === "zh" ? "唤醒 ×2" : "Wake ×2",
      );
      const mixed = grouped.find(
        (edge) =>
          edge.source === "member:advisor" && edge.target === "member:executor",
      )!;
      expect(workflowEdgeLabel(mixed, t)).toBe(
        locale === "zh" ? "退回 · 唤醒" : "Return · Wake",
      );
    }
    expect(workflow).toEqual(researchWorkflowFixture);
    for (const measured of [undefined, { width: 400, height: 240 }]) {
      const arranged = layoutWorkflow(
        nodes.map((node) => ({ ...node, measured })),
        edges,
      );
      expectNoOverlap(arranged);
      for (const edge of grouped.filter((edge) => edge.source !== edge.target))
        expect(
          arranged.find((node) => node.id === edge.source)!.position.x,
        ).not.toBe(
          arranged.find((node) => node.id === edge.target)!.position.x,
        );
    }
  });

  it("ignores handles and rule origins when grouping, combines kinds and keeps both directions", () => {
    const { edges, workflow } = graph();
    const base = edges[0];
    const grouped = mergeWorkflowEdges([
      { ...base, id: "wake-1", data: { rule: "review", kind: "wake" } },
      {
        ...base,
        id: "wake-2",
        sourceHandle: "back-out",
        targetHandle: "back-in",
        data: { rule: "wait", kind: "wake" },
      },
      {
        ...base,
        id: "wake-3",
        sourceHandle: "loop-out",
        targetHandle: "loop-in",
        data: { rule: "subscribe", kind: "wake" },
      },
      { ...base, id: "back", source: base.target, target: base.source },
    ]);
    expect(grouped).toHaveLength(2);
    const t = createTranslator("zh").t;
    expect(workflowEdgeLabel(grouped[0], t)).toBe("唤醒 ×3");
    expect(edgeRules(grouped[0], workflow)).toHaveLength(3);
    expect(mergeWorkflowEdges(grouped)).toEqual(grouped);
    expect(
      workflowEdgeLabel(
        mergeWorkflowEdges([
          { ...base, data: { rule: "review", kind: "wake" } },
          { ...base, data: { rule: "wait", kind: "wait_for_owner" } },
        ])[0],
        t,
      ),
    ).toBe("唤醒 · 等我");
  });

  it("connects forward edges directly, returns below nodes and loops around the bottom-right corner", () => {
    const { nodes, edges } = workflowToFlow(
      researchWorkflowFixture,
      researchWorkflowMembers,
      workflowChannels,
    );
    const grouped = mergeWorkflowEdges(edges);
    const curves = curveWorkflowEdges(nodes, grouped);
    expect(curves.size).toBe(grouped.length);
    expect(
      curveWorkflowEdges([...nodes].reverse(), [...grouped].reverse()),
    ).toEqual(curves);
    for (const curve of curves.values()) {
      expect(curvePath(curve.points)).toMatch(/^M [-\d.]+ [-\d.]+ C /);
      expect(curvePath(curve.points)).not.toMatch(/ L | Q |NaN|Infinity/);
    }
    const ownerToAdvisor = curves.get(
      grouped.find(
        (edge) =>
          edge.source === "member:owner" && edge.target === "member:advisor",
      )!.id,
    )!;
    const advisorToOwner = curves.get(
      grouped.find(
        (edge) =>
          edge.source === "member:advisor" && edge.target === "member:owner",
      )!.id,
    )!;
    expect(ownerToAdvisor.label.y).toBeLessThan(advisorToOwner.label.y);
    const self = curves.get(
      grouped.find((edge) => edge.source === edge.target)!.id,
    )!;
    const distiller = nodes.find((node) => node.id === "member:distiller")!;
    expect(self.label).toEqual({
      x: distiller.position.x + 168,
      y: distiller.position.y + 44 + 14,
    });
    expect(self.points[0]).toEqual({
      x: distiller.position.x + 168,
      y: distiller.position.y + 44 - 14,
    });
    expect(Math.max(...self.points.map((point) => point.x))).toBe(
      distiller.position.x + 168 + 14,
    );
    expect(self.points.at(-1)).toEqual({
      x: distiller.position.x + 168 - 14,
      y: distiller.position.y + 44,
    });
    expect(self.sourceHandle).toBe("loop-out");
    expect(self.targetHandle).toBe("loop-in");
    expect(
      Math.max(...self.points.map((point) => point.x)) -
        Math.min(...self.points.map((point) => point.x)),
    ).toBeLessThan(nodeBox(distiller).width);
  });
});

describe("compact research layout", () => {
  it("fits six nodes and fifteen rules within 900 × 520, including feedback and the self-loop", () => {
    const graph = workflowToFlow(
      researchWorkflowFixture,
      researchWorkflowMembers,
      workflowChannels,
    );
    const nodes = layoutWorkflow(graph.nodes, graph.edges);
    const curves = curveWorkflowEdges(nodes, mergeWorkflowEdges(graph.edges));
    const bounds = workflowBounds(nodes, curves.values());
    expect(nodes).toHaveLength(6);
    expect(researchWorkflowFixture.rules).toHaveLength(15);
    expect(bounds.width).toBeLessThanOrEqual(900);
    expect(bounds.height).toBeLessThanOrEqual(520);
    expectNoOverlap(nodes);
    for (const node of nodes)
      expect(nodeBox(node)).toMatchObject({ width: 168, height: 44 });
    const left = nodes
      .filter((node) => node.position.x === 0)
      .sort((a, b) => a.position.y - b.position.y);
    expect(left.some((node) => node.id === "channel:lab")).toBe(true);
    expect(left.some((node) => node.data.human)).toBe(true);
    expect(left.some((node) => node.data.kind === "trigger")).toBe(true);
    for (let index = 1; index < left.length; index++)
      expect(left[index].position.y - left[index - 1].position.y).toBe(44 + 32);
    const layers = [...new Set(nodes.map((node) => node.position.x))].sort(
      (a, b) => a - b,
    );
    for (let index = 1; index < layers.length; index++)
      expect(layers[index] - layers[index - 1]).toBe(168 + 120);
    for (const curve of curves.values()) {
      if (curve.sourceHandle !== "back-out") continue;
      const baseline = Math.max(curve.points[0].y, curve.points.at(-1)!.y);
      expect(curve.label.y - baseline).toBe(42);
      expect(curve.label.y - baseline).toBeLessThanOrEqual(70);
    }
  });

  it("numbers feedback within each pair, independent of span and input order", () => {
    const { nodes, edges } = graph();
    const source = { ...nodes[0], id: "right", position: { x: 1800, y: 90 } };
    const target = { ...nodes[0], id: "left", position: { x: 0, y: 0 } };
    const feedback = ["one", "two", "three"].map((id) => ({
      ...edges[0],
      id,
      source: source.id,
      target: target.id,
    }));
    const curves = curveWorkflowEdges([source, target], feedback);
    expect(
      curveWorkflowEdges([target, source], [...feedback].reverse()),
    ).toEqual(curves);
    expect([...curves.values()].map((curve) => curve.label.y - 134)).toEqual([
      42, 56, 70,
    ]);
    const short = curveWorkflowEdges(
      [{ ...source, position: { ...source.position, x: 288 } }, target],
      feedback,
    );
    for (const [id, curve] of curves) {
      expect(curve.label.y).toBe(short.get(id)!.label.y);
      expect(curve.sourceHandle).toBe("back-out");
      expect(curve.targetHandle).toBe("back-in");
      expect(curve.label.y).toBe(
        Math.max(...curve.points.map((point) => point.y)),
      );
      expect(curve.points[0]).toEqual({ x: source.position.x + 84, y: 134 });
      expect(curve.points.at(-1)).toEqual({ x: 84, y: 44 });
    }
    const forward = curveWorkflowEdges(
      [source, target],
      [{ ...feedback[0], source: target.id, target: source.id }],
    ).get("one")!;
    expect(forward.points).toHaveLength(4);
    expect(forward.points[1].y).toBe(forward.points[0].y);
    expect(forward.points[2].y).toBe(forward.points[3].y);
    expect(forward.label).toEqual({ x: (168 + 1800) / 2, y: (22 + 112) / 2 });
  });
});

describe("readable workflow viewport", () => {
  it("centers the complete graph at zoom 1 when it fits, including the loop and feedback", () => {
    const { nodes, edges } = workflowToFlow(
      researchWorkflowFixture,
      researchWorkflowMembers,
      workflowChannels,
    );
    const curves = curveWorkflowEdges(nodes, mergeWorkflowEdges(edges));
    const bounds = workflowBounds(nodes, curves.values());
    const viewport = workflowViewport(nodes, 830, 600, curves.values());
    expect(viewport.zoom).toBe(1);
    expect(bounds.x + viewport.x + bounds.width / 2).toBe(415);
    expect(bounds.y + viewport.y + bounds.height / 2).toBe(300);
    expect(workflowViewport([], 480, 600)).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("scales to fit with a 24px left inset, clamping at 0.85 for overflow", () => {
    const { nodes } = workflowToFlow(
      researchWorkflowFixture,
      researchWorkflowMembers,
      workflowChannels,
    );
    const bounds = workflowBounds(nodes);
    const viewport = workflowViewport(nodes, 700, 600);
    expect(viewport.zoom).toBeCloseTo((700 - 48) / bounds.width);
    expect(viewport.zoom).toBeGreaterThan(0.85);
    expect(bounds.x * viewport.zoom + viewport.x).toBe(24);
    expect((bounds.x + bounds.width) * viewport.zoom + viewport.x).toBeCloseTo(
      676,
    );
    for (const width of [480, 600]) {
      const small = workflowViewport(nodes, width, 600);
      expect(small.zoom).toBe(0.85);
      expect(bounds.x * small.zoom + small.x).toBe(24);
      expect((bounds.x + bounds.width) * small.zoom + small.x).toBeGreaterThan(
        width - 24,
      );
    }
  });

  it("includes edge extents when the nodes alone would fit at zoom 1", () => {
    const { nodes, edges } = graph();
    const node = { ...nodes[0], position: { x: -40, y: 80 } };
    const curves = curveWorkflowEdges(
      [node],
      [{ ...edges[0], source: node.id, target: node.id }],
    );
    expect(workflowViewport([node], 216, 120).zoom).toBe(1);
    const viewport = workflowViewport([node], 216, 120, curves.values());
    expect(viewport.zoom).toBeCloseTo(168 / 182);
    const bounds = workflowBounds([node], curves.values());
    expect(bounds.x * viewport.zoom + viewport.x).toBe(24);
    expect((bounds.x + bounds.width) * viewport.zoom + viewport.x).toBeCloseTo(
      192,
    );
  });

  it("anchors to the actual leftmost saved layer and handles tall graphs", () => {
    const { nodes } = workflowToFlow(
      workflowFixture,
      workflowMembers,
      workflowChannels,
    );
    const bounds = workflowBounds(nodes);
    const centered = workflowViewport(nodes, 1400, 1000);
    expect(centered.zoom).toBe(1);
    expect(bounds.x + centered.x + bounds.width / 2).toBe(700);
    const viewport = workflowViewport(nodes, 480, 120);
    expect(viewport.zoom).toBe(0.85);
    expect(bounds.x * viewport.zoom + viewport.x).toBe(24);
    expect(bounds.y * viewport.zoom + viewport.y).toBe(24);
    // The saved owner is on the right: it must not replace the leftmost layer as anchor.
    const owner = nodes.find((node) => node.data.human)!;
    expect(owner.position.x * viewport.zoom + viewport.x).toBeGreaterThan(24);
  });
});
