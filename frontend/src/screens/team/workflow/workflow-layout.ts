import type { XYPosition } from "@xyflow/react";
import type { Workflow, WorkflowEdge, WorkflowNode } from "./workflow-model";

type Box = XYPosition & { width: number; height: number };
export interface EdgeCurve {
  // One or more cubic segments, sharing the last point of each segment.
  points: XYPosition[];
  label: XYPosition;
  sourceHandle: string;
  targetHandle: string;
}

// Canvas geometry only; measured node sizes take precedence over these estimates.
export function nodeBox(node: WorkflowNode): Box {
  return {
    ...node.position,
    width: node.measured?.width ?? 168,
    height: node.measured?.height ?? 44,
  };
}

const overlaps = (a: Box, b: Box, gap = 0) =>
  a.x < b.x + b.width + gap &&
  a.x + a.width + gap > b.x &&
  a.y < b.y + b.height + gap &&
  a.y + a.height + gap > b.y;
const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function savedNodeIds(workflow: Workflow): Set<string> {
  return new Set([
    ...Object.keys(workflow.layout.members).map((id) => `member:${id}`),
    ...Object.keys(workflow.layout.channels).map((id) => `channel:${id}`),
    ...workflow.rules
      .filter((rule) => rule.position)
      .map((rule) => `trigger:${rule.id}`),
  ]);
}

/** Break feedback cycles deterministically; return/wait edges do not push sources right. */
export function layoutWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  fixed = new Set<string>(),
): WorkflowNode[] {
  const sorted = [...nodes].sort(byId);
  const source = (node: WorkflowNode) =>
    node.data.kind === "owner" ||
    node.data.human ||
    node.data.kind === "trigger" ||
    (node.data.kind === "channel" &&
      !edges.some((edge) => edge.target === node.id));
  const disconnected = (node: WorkflowNode) =>
    !edges.some((edge) => edge.source === node.id || edge.target === node.id);
  const ranks = new Map(
    sorted.map((node) => [
      node.id,
      source(node) || disconnected(node)
        ? 0
        : node.data.kind === "channel"
          ? 1
          : 2,
    ]),
  );
  const forward = edges
    .filter(
      (edge) =>
        edge.source !== edge.target &&
        edge.data?.kind !== "return" &&
        sorted.some((node) => node.id === edge.target && !source(node)),
    )
    .sort(byId);
  const remaining = new Set(sorted.map((node) => node.id));
  const order: WorkflowNode[] = [];
  while (remaining.size) {
    const pending = sorted.filter((node) => remaining.has(node.id));
    const next =
      pending.find(
        (node) =>
          !forward.some(
            (edge) => edge.target === node.id && remaining.has(edge.source),
          ),
      ) ?? pending[0];
    remaining.delete(next.id);
    order.push(next);
    for (const edge of forward)
      if (edge.source === next.id && remaining.has(edge.target))
        ranks.set(
          edge.target,
          Math.max(ranks.get(edge.target)!, ranks.get(next.id)! + 1),
        );
  }
  const layers = [...new Set(ranks.values())]
    .sort((a, b) => a - b)
    .map((rank) => order.filter((node) => ranks.get(node.id) === rank));
  const centers = new Map<string, number>();
  const heights = layers.map((layer) =>
    layer.reduce((height, node) => height + nodeBox(node).height + 32, -32),
  );
  const totalHeight = Math.max(0, ...heights);
  const placed = sorted.filter((node) => fixed.has(node.id)).map(nodeBox);
  const positions = new Map<string, XYPosition>();
  let x = 0;
  layers.forEach((layer, index) => {
    // Align layer exits so a short trigger cannot curve through a wider sibling.
    const layerWidth = Math.max(...layer.map((node) => nodeBox(node).width));
    const center = (node: WorkflowNode) => {
      const parents = forward
        .filter((edge) => edge.target === node.id)
        .map((edge) => centers.get(edge.source))
        .filter((y) => y !== undefined);
      return parents.length
        ? parents.reduce((sum, y) => sum + y, 0) / parents.length
        : totalHeight / 2;
    };
    layer.sort((a, b) => {
      const owner = (node: WorkflowNode) =>
        Number(node.data.kind === "owner" || !!node.data.human);
      return (
        Number(disconnected(b)) - Number(disconnected(a)) ||
        owner(a) - owner(b) ||
        center(a) - center(b) ||
        byId(a, b)
      );
    });
    let y = (totalHeight - heights[index]) / 2;
    for (const node of layer) {
      const box = {
        ...nodeBox(node),
        x: x + layerWidth - nodeBox(node).width,
        y,
      };
      if (fixed.has(node.id)) {
        positions.set(node.id, node.position);
        centers.set(node.id, node.position.y + box.height / 2);
      } else {
        while (placed.some((other) => overlaps(box, other, 32)))
          box.y += box.height + 32;
        positions.set(node.id, { x: box.x, y: box.y });
        centers.set(node.id, box.y + box.height / 2);
        placed.push(box);
      }
      y = Math.max(y, box.y) + box.height + 32;
    }
    x += layerWidth + 120;
  });
  return nodes.map((node) => ({ ...node, position: positions.get(node.id)! }));
}

/** Forward edges connect directly; feedback arches stay below both nodes. */
export function curveWorkflowEdges(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Map<string, EdgeCurve> {
  const boxes = new Map(nodes.map((node) => [node.id, nodeBox(node)]));
  const pairCounts = new Map<string, number>();
  const curves = new Map<string, EdgeCurve>();
  for (const edge of [...edges].sort(byId)) {
    const from = boxes.get(edge.source),
      to = boxes.get(edge.target);
    if (!from || !to) continue;
    let points: EdgeCurve["points"];
    let label: XYPosition;
    let sourceHandle = "out",
      targetHandle = "in";
    if (edge.source === edge.target) {
      // Three quarter-circle cubics around the bottom-right corner, radius 14.
      const x = from.x + from.width,
        y = from.y + from.height,
        radius = 14,
        control = (radius * (4 * (Math.SQRT2 - 1))) / 3;
      points = [
        { x, y: y - radius },
        { x: x + control, y: y - radius },
        { x: x + radius, y: y - control },
        { x: x + radius, y },
        { x: x + radius, y: y + control },
        { x: x + control, y: y + radius },
        { x, y: y + radius },
        { x: x - control, y: y + radius },
        { x: x - radius, y: y + control },
        { x: x - radius, y },
      ];
      label = { x, y: y + radius };
      sourceHandle = "loop-out";
      targetHandle = "loop-in";
    } else if (
      from.x > to.x ||
      (from.x === to.x && edge.source > edge.target)
    ) {
      const pair = JSON.stringify([edge.source, edge.target]);
      const index = (pairCounts.get(pair) ?? 0) + 1;
      pairCounts.set(pair, index);
      const start = { x: from.x + from.width / 2, y: from.y + from.height };
      const end = { x: to.x + to.width / 2, y: to.y + to.height };
      const bottom = Math.max(start.y, end.y) + 28 + 14 * index;
      label = { x: (start.x + end.x) / 2, y: bottom };
      // Two joined cubics put the horizontal tangent and label at the true low point,
      // including when the two nodes are at different heights.
      points = [
        start,
        { x: start.x, y: bottom },
        { x: (start.x + label.x) / 2, y: bottom },
        label,
        { x: (end.x + label.x) / 2, y: bottom },
        { x: end.x, y: bottom },
        end,
      ];
      sourceHandle = "back-out";
      targetHandle = "back-in";
    } else {
      const start = { x: from.x + from.width, y: from.y + from.height / 2 };
      const end = { x: to.x, y: to.y + to.height / 2 };
      const reach = Math.max(0, (end.x - start.x) / 2);
      points = [
        start,
        { x: start.x + reach, y: start.y },
        { x: end.x - reach, y: end.y },
        end,
      ];
      label = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    }
    curves.set(edge.id, { points, label, sourceHandle, targetHandle });
  }
  return curves;
}

export function curvePath(points: EdgeCurve["points"]): string {
  const [start] = points;
  let path = `M ${start.x} ${start.y}`;
  for (let index = 1; index < points.length; index += 3) {
    const [first, second, end] = points.slice(index, index + 3);
    path += ` C ${first.x} ${first.y} ${second.x} ${second.y} ${end.x} ${end.y}`;
  }
  return path;
}

// The curves are monotone between their extrema, which are explicit in points.
export function workflowBounds(
  nodes: WorkflowNode[],
  curves: Iterable<EdgeCurve> = [],
): Box {
  const points = nodes.flatMap((node) => {
    const box = nodeBox(node);
    return [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
    ];
  });
  for (const curve of curves) points.push(...curve.points);
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...points.map((point) => point.x));
  const y = Math.min(...points.map((point) => point.y));
  return {
    x,
    y,
    width: Math.max(...points.map((point) => point.x)) - x,
    height: Math.max(...points.map((point) => point.y)) - y,
  };
}

export const WORKFLOW_MIN_ZOOM = 0.85;

/** Center a graph that fits at 1:1; otherwise fit from the left with a 24px inset. */
export function workflowViewport(
  nodes: WorkflowNode[],
  width: number,
  height: number,
  curves: Iterable<EdgeCurve> = [],
) {
  if (!nodes.length) return { x: 0, y: 0, zoom: 1 };
  const bounds = workflowBounds(nodes, curves);
  const padding = 24;
  const fits =
    bounds.width <= width - padding * 2 &&
    bounds.height <= height - padding * 2;
  const zoom = fits
    ? 1
    : Math.max(
        WORKFLOW_MIN_ZOOM,
        Math.min(
          1,
          (width - padding * 2) / bounds.width,
          (height - padding * 2) / bounds.height,
        ),
      );
  return {
    x: fits
      ? (width - bounds.width) / 2 - bounds.x
      : padding - Math.min(...nodes.map((node) => node.position.x)) * zoom,
    y:
      bounds.height * zoom > height - padding * 2
        ? padding - bounds.y * zoom
        : (height - bounds.height * zoom) / 2 - bounds.y * zoom,
    zoom,
  };
}
