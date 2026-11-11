import { Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import type { Step } from "@ratchet/api/types";
import { stepDepths } from "@ratchet/engine/utils";
import { STEP_STATUS_LABELS, type StepDisplayStatus } from "../constants/statuses";
import { stepDisplayStatus } from "../utils/steps";

const ICONS: Record<StepDisplayStatus, string> = {
  pending: "○",
  ready: "○",
  retrying: "↻",
  running: "◌",
  succeeded: "✓",
  failed: "✕",
  skipped: "–",
};

const COLORS: Record<StepDisplayStatus, string> = {
  pending: "border-grey bg-grey-soft text-grey",
  ready: "border-grey bg-grey-soft text-grey",
  retrying: "border-amber bg-amber-soft text-amber",
  running: "border-blue bg-blue-soft text-blue animate-pulse-soft motion-reduce:animate-none",
  succeeded: "border-green bg-green-soft text-green",
  failed: "border-red bg-red-soft text-red",
  skipped: "border-grey border-dashed bg-grey-soft text-grey",
};

/** Space between columns and between cards stacked in one column, in pixels. */
const COLUMN_WIDTH = 260;
const ROW_HEIGHT = 90;

type StepNode = Node<{ step: Step; selected: boolean }, "step">;

function StepCard({ data: { step, selected } }: NodeProps<StepNode>) {
  const status = stepDisplayStatus(step);
  return (
    <div
      className={`w-52.5 cursor-pointer rounded-lg border-[1.5px] px-3 py-2.5 transition-colors duration-250 ${COLORS[status]} ${selected ? "outline-2 outline-offset-2 outline-accent" : ""}`}
      title={step.description ?? undefined}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flex items-center gap-1.75 font-semibold">
        <span className="w-3.5 text-center" aria-hidden>
          {ICONS[status]}
        </span>
        <span className={step.status === "skipped" ? "line-through" : ""}>{step.title}</span>
      </div>
      <div className="mt-0.5 text-xs/normal">
        {STEP_STATUS_LABELS[status]}
        {step.worker_id ? ` · ${step.worker_id}` : ""}
        {/* A step runs again after a retryable error or a lost lease. */}
        {step.attempt > 1 ? ` · attempt ${step.attempt}` : ""}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { step: StepCard };

export function FlowDiagram({
  steps,
  selected,
  onSelect,
}: {
  steps: Step[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  // One column per depth, so steps that can run side by side are stacked,
  // centred on the same line as the steps before and after them.
  const depths = stepDepths(steps);
  const columns = new Map<number, Step[]>();
  for (const step of steps) {
    const depth = depths.get(step.name) ?? 0;
    columns.set(depth, [...(columns.get(depth) ?? []), step]);
  }
  const nodes: StepNode[] = [...columns].flatMap(([depth, column]) =>
    column.map((step, row) => ({
      id: step.name,
      type: "step",
      position: { x: depth * COLUMN_WIDTH, y: (row - (column.length - 1) / 2) * ROW_HEIGHT },
      data: { step, selected: step.name === selected },
    })),
  );

  const edges: Edge[] = steps.flatMap((step) =>
    step.needs.map((need) => ({
      id: `${need}-${step.name}`,
      source: need,
      target: step.name,
      animated: step.status === "running",
    })),
  );

  return (
    <div className="h-60 rounded-lg border border-line bg-surface">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.08 }}
        minZoom={0.25}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnScroll={false}
        zoomOnScroll={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => onSelect(node.id)}
      />
    </div>
  );
}
