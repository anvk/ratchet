import type { StepRunStatus, WorkflowRunStatus } from "@ratchet/engine/constants";
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

/** Labels for step statuses, as on the diagram and in the step details. */
export const STEP_STATUS_LABELS: Record<StepRunStatus, string> = {
  pending: "Pending",
  ready: "Ready",
  running: "Running",
  succeeded: "Passed",
  failed: "Failed",
  skipped: "Skipped",
};

/** Pill colours for run statuses. */
export const RUN_STATUS_TONES: Record<WorkflowRunStatus, PillTone> = {
  queued: "grey",
  running: "blue",
  succeeded: "green",
  failed: "red",
};

/** Pill colours for step statuses, matching the step cards on the diagram. */
export const STEP_STATUS_TONES: Record<StepRunStatus, PillTone> = {
  pending: "grey",
  ready: "grey",
  running: "blue",
  succeeded: "green",
  failed: "red",
  skipped: "grey",
};
