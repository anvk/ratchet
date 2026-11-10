import type { StepRunStatus } from "@ratchet/engine/constants";
import { STEP_STATUS_LABELS, STEP_STATUS_TONES } from "../constants/statuses";
import { Pill } from "./Pill";

/** A step's status as a coloured pill, pulsing while it runs. */
export function StepStatusBadge({ status }: { status: StepRunStatus }) {
  return (
    <Pill tone={STEP_STATUS_TONES[status]} dot pulse={status === "running"}>
      {STEP_STATUS_LABELS[status]}
    </Pill>
  );
}
