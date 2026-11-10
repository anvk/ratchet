import type { WorkflowRunStatus } from "@ratchet/engine/constants";
import { RUN_STATUS_LABELS } from "../constants/statuses";

const COLORS: Record<WorkflowRunStatus, string> = {
  queued: "bg-grey-soft text-grey",
  running: "bg-blue-soft text-blue",
  succeeded: "bg-green-soft text-green",
  failed: "bg-red-soft text-red",
};

export function StatusBadge({ status }: { status: WorkflowRunStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.25 py-px text-xs/normal font-medium ${COLORS[status]}`}
    >
      <span
        className={`size-1.75 rounded-full bg-current ${status === "running" ? "animate-pulse-soft motion-reduce:animate-none" : ""}`}
        aria-hidden
      />
      {RUN_STATUS_LABELS[status]}
    </span>
  );
}
