// The JSON the HTTP API sends: snake_case fields, dates as ISO strings. The
// route handlers are checked against these types, and the client imports them
// through "@ratchet/api/types".
//
// Safe to import in a browser: this file only imports types.

import type { FailureReason, StepRunStatus, WorkflowRunStatus } from "@ratchet/engine/constants";

/** `400`, `404` and other errors. `issues` lists what was wrong with a malformed request. */
export interface ErrorResponse {
  error: string;
  issues?: unknown[];
}

/** A workflow that can be started, from the registry. `GET /workflows` */
export interface WorkflowInfo {
  name: string;
  title: string;
  description: string;
  presets: { label: string; input: object }[];
  steps: { name: string; title: string; description: string }[];
}

export interface WorkflowsResponse {
  workflows: WorkflowInfo[];
}

/**
 * `POST /runs` with `{ workflow, input?, idempotency_key? }`. Returns `201`, or
 * `400` for an unknown workflow. A repeated idempotency key starts nothing and
 * returns the existing run's id.
 */
export interface StartRunResponse {
  id: string;
}

/** A run in the runs list. */
export interface RunSummary {
  id: string;
  workflow: string;
  workflow_title: string;
  status: WorkflowRunStatus;
  /** Why the run failed, from the step that failed it. Null unless failed. */
  failure_reason: FailureReason | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  steps_total: number;
  steps_done: number;
}

/**
 * `GET /runs?status=&cursor=&limit=`, newest first. Pass `next_cursor` back as
 * `cursor` for the next page. `limit` is 1 to 200, default 50.
 */
export interface RunsResponse {
  runs: RunSummary[];
  next_cursor: string | null;
  /** Runs of each status, across all pages. */
  counts: Record<WorkflowRunStatus, number>;
}

/** A step of a run, with the title and description from the plan the run started with. */
export interface Step {
  name: string;
  title: string;
  /** Null for a step added at runtime, which has no plan row. */
  description: string | null;
  position: number;
  status: StepRunStatus;
  attempt: number;
  worker_id: string | null;
  output: unknown;
  error: string | null;
  /** Why the step failed. Null unless failed. */
  failure_reason: FailureReason | null;
  ready_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/** `GET /runs/:id`, with steps ordered by position. `404` if the run doesn't exist. */
export interface RunDetail {
  run: Omit<RunSummary, "steps_total" | "steps_done"> & {
    input: unknown;
    workflow_version: string;
    workflow_description: string;
  };
  steps: Step[];
}

/**
 * One entry in a run's history. `type` is one of `run_queued`, `run_started`,
 * `run_succeeded`, `run_failed`, `step_ready`, `step_claimed`, `step_succeeded`,
 * `step_failed`, `step_skipped`, `step_lease_expired` or `step_retry_scheduled`.
 */
export interface RunEvent {
  id: string;
  step_name: string | null;
  type: string;
  attempt: number | null;
  worker_id: string | null;
  detail: unknown;
  at: string;
}

/** `GET /runs/:id/events`, oldest first. */
export interface EventsResponse {
  events: RunEvent[];
}
