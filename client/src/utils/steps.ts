import type { Step } from "@ratchet/api/types";
import type { StepDisplayStatus } from "../constants/statuses";

/**
 * How a step's status reads in the dashboard. A step waiting to retry is
 * `ready` in the database, but it has already run at least once, which a
 * first-time `ready` step hasn't, so it shows as "retrying".
 */
export function stepDisplayStatus(step: Pick<Step, "status" | "attempt">): StepDisplayStatus {
  return step.status === "ready" && step.attempt > 0 ? "retrying" : step.status;
}
