import type { WorkflowRunStatus } from "@ratchet/engine/constants";
import { RUN_STATUS_LABELS, RUN_STATUS_TONES } from "../constants/statuses";
import { Pill } from "./Pill";

/** A run's status as a coloured pill, pulsing while it runs. */
export function StatusBadge({ status }: { status: WorkflowRunStatus }) {
  return (
    <Pill tone={RUN_STATUS_TONES[status]} dot pulse={status === "running"}>
      {RUN_STATUS_LABELS[status]}
    </Pill>
  );
}
