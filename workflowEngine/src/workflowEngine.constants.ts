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

/** The settings an engine uses for anything createWorkflowEngine isn't given. */
export const DEFAULT_ENGINE_SETTINGS: WorkflowEngineSettings = {
  /** Idle workers ask for work 4 times a second: quick to react, light on the database. */
  pollMs: 250,
  /** After an unexpected error, wait a second so a database outage isn't hammered. */
  errorBackoffMs: 1000,
  /** Graceful close waits up to 30s for running steps, like a typical deploy's grace period. */
  closeTimeoutMs: 30_000,
  /** A run stays on one worker from start to finish. */
  claimOrder: "sticky",
  /**
   * A worker that goes 30s without a heartbeat loses its step. Long enough for
   * a busy event loop or a slow database to recover, short enough that a
   * crashed worker's step is picked up within a minute.
   */
  leaseMs: 30_000,
  /** Expired leases are swept every second, so a lost step waits at most a second longer. */
  sweepIntervalMs: 1000,
};
