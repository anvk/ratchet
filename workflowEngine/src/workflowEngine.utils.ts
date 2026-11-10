// Safe to import in a browser: this file only imports constants and types. The
// client uses it through "@ratchet/engine/utils".

import { FINISHED_RUN_STATUSES, type WorkflowRunStatus } from "./workflowEngine.constants.ts";

/** Throws if a name appears more than once. `what` labels the error message. */
export function assertUnique(names: string[], what: string) {
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) throw new Error(`Duplicate ${what}: ${duplicate}`);
}

/** Whether a run has stopped for good, either way. */
export function isRunFinished(status: WorkflowRunStatus) {
  return FINISHED_RUN_STATUSES.includes(status);
}
