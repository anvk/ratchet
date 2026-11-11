import type { FailureReason, StepRunStatus, WorkflowRunStatus } from "@ratchet/engine/constants";
import type { PillTone } from "../components/Pill";

// How statuses read in the dashboard. Records rather than arrays, so a new
// status in the database enum is a compile error here until it has a label.

/** Labels for run statuses, as in the tabs and status badges. */
export const RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Passed",
  failed: "Failed",
};

/**
 * A step's status as the dashboard shows it: the database's status, plus
 * "retrying" for a ready step that has already run. See stepDisplayStatus.
 */
export type StepDisplayStatus = StepRunStatus | "retrying";

/** Labels for step statuses, as on the diagram and in the step details. */
export const STEP_STATUS_LABELS: Record<StepDisplayStatus, string> = {
  pending: "Pending",
  ready: "Ready",
  retrying: "Retrying",
  running: "Running",
  succeeded: "Passed",
  failed: "Failed",
  skipped: "Skipped",
};

/** Why a step or run failed, shown next to its Failed badge. */
export const FAILURE_REASON_LABELS: Record<FailureReason, string> = {
  non_retryable: "Not retryable",
  attempts_exhausted: "Out of attempts",
  lost_worker: "Kept losing its worker",
  unknown_step: "No worker knows this step",
};

/** Pill colours for run statuses. */
export const RUN_STATUS_TONES: Record<WorkflowRunStatus, PillTone> = {
  queued: "grey",
  running: "blue",
  succeeded: "green",
  failed: "red",
};

/** Pill colours for step statuses, matching the step cards on the diagram. */
export const STEP_STATUS_TONES: Record<StepDisplayStatus, PillTone> = {
  pending: "grey",
  ready: "grey",
  retrying: "amber",
  running: "blue",
  succeeded: "green",
  failed: "red",
  skipped: "grey",
};
