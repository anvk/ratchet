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

/**
 * A ready-made input the dashboard offers when starting a workflow. Not part of
 * the engine: the app serving the API passes presets in, by workflow name.
 */
export interface Preset<Input extends object = object> {
  label: string;
  input: Input;
}

/**
 * The display text the dashboard shows for a workflow and its steps. Not part of
 * the engine: the app serving the API passes labels in, by workflow name.
 */
export interface WorkflowLabels {
  title: string;
  description: string;
  /** By step name. */
  steps: Record<string, { title: string; description: string }>;
}

/**
 * A workflow that can be started, from the registry. Titles and descriptions
 * come from the app's labels; without them the title is made from the name and
 * the description is null. `GET /workflows`
 */
export interface WorkflowInfo {
  name: string;
  title: string;
  description: string | null;
  /** Empty if the app gave none for this workflow. */
  presets: Preset[];
  /**
   * The steps the app's labels name for this workflow. A workflow is code, so
   * this is not a list of what a run will do: a run asks for steps as it goes.
   */
  steps: { name: string; title: string; description: string | null }[];
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
  /** How many steps the run has asked for so far. It grows as the run goes. */
  steps_total: number;
  steps_done: number;
  /**
   * The name of the schedule that started the run. Null for a run started by a
   * call, or if its schedule has been deleted.
   */
  schedule: string | null;
  /** The time the schedule was due, for a run a schedule started. Null otherwise. */
  scheduled_for: string | null;
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

/** A schedule of a workflow, with when it next fires. */
export interface ScheduleInfo {
  /** The workflow's name. */
  workflow: string;
  /** The workflow's display title from the app's labels, or one made from its name. */
  workflow_title: string;
  /** The schedule's name, which is unique among the workflow's schedules. */
  name: string;
  /** Five fields, in UTC. Null for a schedule that fires once. */
  cron: string | null;
  /** Null once a schedule that fires once has fired. */
  next_fire_at: string | null;
  /** Null until it has fired once. */
  last_fired_at: string | null;
  /** What each of its runs starts with. */
  input: unknown;
  /** When it was paused. Null unless paused. */
  paused_at: string | null;
}

/** The schedule a change was made to, returned by the routes that change one. */
export interface ScheduleRef {
  workflow: string;
  name: string;
}

/**
 * `POST /schedules` with `{ workflow, name, cron or at, input? }` creates a
 * schedule and returns `201` with its `{ workflow, name }`. `cron` repeats it;
 * `at`, an ISO date, fires it once. `400` for an unknown workflow, a cron that
 * doesn't parse or never fires, an `at` that has passed, or both or neither of
 * `cron` and `at`; `409` if the workflow already has a schedule with this name.
 *
 * `PATCH /schedules/:workflow/:name` with `{ cron?, at?, input? }` changes a
 * schedule. `400` as above, or for an empty body or one that would switch the
 * schedule between repeating and firing once; `404` if there is no such
 * schedule, or it fires once and already has.
 *
 * `DELETE /schedules/:workflow/:name` removes a schedule, keeping the runs it
 * started. `404` if it doesn't exist.
 *
 * `POST /schedules/:workflow/:name/pause` and `.../resume` return the schedule's
 * `{ workflow, name }`. `404` if it doesn't exist; `409` if it is already
 * paused, or isn't paused.
 */

/** `GET /schedules`, ordered by workflow, then name. */
export interface SchedulesResponse {
  schedules: ScheduleInfo[];
}

/** A step of a run, with the title and description from the app's labels, or a title made from its name. */
export interface Step {
  name: string;
  title: string;
  /** Null if the app's labels have none for this step. */
  description: string | null;
  /** The order in which the workflow asked for its steps. */
  position: number;
  /**
   * The steps this one came straight after: the workflow needed their results
   * before it asked for this one. Steps with the same ones ran side by side.
   */
  asked_after: string[];
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
    /** The `version` the workflow's definition had when the run started. */
    workflow_version: string;
    /** What the workflow returned. Null unless the run succeeded. */
    output: unknown;
    workflow_description: string | null;
  };
  steps: Step[];
}

/**
 * `POST /runs/:id/redrive` resumes a cancelled or failed run from the steps
 * that didn't succeed, and returns `{ id }` like starting a run. `404` if the
 * run doesn't exist, `409` unless the run was cancelled or failed for a reason
 * in REDRIVABLE_FAILURE_REASONS.
 */

/**
 * `POST /runs/:id/cancel` stops a run that hasn't finished and returns `{ id }`.
 * `404` if the run doesn't exist, `409` if it has already finished. A cancelled
 * run has status `cancelled`, and can be redriven.
 */

/**
 * One entry in a run's history. `type` is one of `run_queued`, `run_waiting`, `run_admitted`, `run_started`,
 * `run_succeeded`, `run_failed`, `run_cancelled`, `step_ready`, `step_claimed`, `step_succeeded`,
 * `step_failed`, `step_skipped`, `step_lease_expired`, `run_redriven`,
 * `step_retry_scheduled` or `schedule_tick_skipped` (a tick of the run's
 * schedule that started nothing because this run was still going).
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
