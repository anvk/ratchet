// Safe to import in a browser: this file only imports types. The client uses
// it through "@ratchet/engine/constants".

import type { WorkflowRunStatus } from "./stores/postgres/db/schema.gen.ts";
import type { WorkflowEngineSettings } from "./workflowEngine.types.ts";

export type { StepRunStatus, WorkflowRunStatus } from "./stores/postgres/db/schema.gen.ts";

// A Record rather than an array: adding a status to the database enum becomes
// a compile error here until it is listed.
const workflowRunStatuses: Record<WorkflowRunStatus, true> = {
  queued: true,
  running: true,
  succeeded: true,
  failed: true,
};

export const WORKFLOW_RUN_STATUSES = Object.keys(workflowRunStatuses) as WorkflowRunStatus[];

/** Statuses a run never leaves. */
export const FINISHED_RUN_STATUSES: readonly WorkflowRunStatus[] = ["succeeded", "failed"];

export const DEFAULT_ENGINE_SETTINGS: WorkflowEngineSettings = {
  pollMs: 250,
  errorBackoffMs: 1000,
  closeTimeoutMs: 30_000,
  claimOrder: "sticky",
};
