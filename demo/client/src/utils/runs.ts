import { FINISHED_RUN_STATUSES, type WorkflowRunStatus } from "@ratchet/engine/constants";

/** Whether a run has stopped for good, either way, so there's nothing left to poll for. */
export function isRunFinished(status: WorkflowRunStatus) {
  return FINISHED_RUN_STATUSES.includes(status);
}
