import { Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import type { StepRunStatus } from "@ratchet/engine/constants";
import type { Step } from "@ratchet/api/types";
import { STEP_STATUS_LABELS } from "../constants/statuses";

const ICONS: Record<StepRunStatus, string> = {
  pending: "○",
  ready: "○",
  running: "◌",
  succeeded: "✓",
  failed: "✕",
  skipped: "–",
};

const COLORS: Record<StepRunStatus, string> = {
  pending: "border-grey bg-grey-soft text-grey",
  ready: "border-grey bg-grey-soft text-grey",
  running: "border-blue bg-blue-soft text-blue animate-pulse-soft motion-reduce:animate-none",
  succeeded: "border-green bg-green-soft text-green",
  failed: "border-red bg-red-soft text-red",
  skipped: "border-grey border-dashed bg-grey-soft text-grey",
};

type StepNode = Node<{ step: Step; selected: boolean }, "step">;

function StepCard({ data: { step, selected } }: NodeProps<StepNode>) {
  return (
    <div
      className={`w-52.5 cursor-pointer rounded-lg border-[1.5px] px-3 py-2.5 transition-colors duration-250 ${COLORS[step.status]} ${selected ? "outline-2 outline-offset-2 outline-accent" : ""}`}
      title={step.description ?? undefined}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flex items-center gap-1.75 font-semibold">
        <span className="w-3.5 text-center" aria-hidden>
          {ICONS[step.status]}
        </span>
        <span className={step.status === "skipped" ? "line-through" : ""}>{step.title}</span>
      </div>
      <div className="mt-0.5 text-xs/normal">
        {STEP_STATUS_LABELS[step.status]}
        {step.worker_id ? ` · ${step.worker_id}` : ""}
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
  // Steps run in order, so they're laid out in a row by position.
  const nodes: StepNode[] = steps.map((step) => ({
    id: step.name,
    type: "step",
    position: { x: step.position * 260, y: 0 },
    data: { step, selected: step.name === selected },
  }));

  const edges: Edge[] = steps.slice(1).map((step, i) => ({
    id: `${steps[i].name}-${step.name}`,
    source: steps[i].name,
    target: step.name,
    animated: step.status === "running",
  }));

  return (
    <div className="h-47.5 rounded-lg border border-line bg-surface">
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
