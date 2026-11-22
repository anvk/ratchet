import type { FailureReason } from "./workflowEngine.constants.ts";

/**
 * Thrown by a step to fail for good, without retries: for a decision, such as
 * "insufficient funds", rather than a glitch that might pass, such as a timeout.
 * Any other error is retried while the step has attempts left.
 */
export class NonRetryableError extends Error {
  override name = "NonRetryableError";
}

/**
 * Thrown into a workflow function, where it asked for the step, when that step
 * has failed for good. The function may catch it and carry on. `reason` says
 * why the step failed, and the message is the step's own error.
 */
export class StepFailedError extends Error {
  override name = "StepFailedError";
  readonly step: string;
  readonly reason: FailureReason;

  constructor({ step, reason, message }: { step: string; reason: FailureReason; message: string }) {
    super(message);
    this.step = step;
    this.reason = reason;
  }
}

/** Thrown for a name that isn't one of the engine's workflows, by startRun (no run is created) and by every `engine.schedules` method. */
export class UnknownWorkflowError extends Error {
  override name = "UnknownWorkflowError";
  readonly workflow: string;

  constructor(workflow: string) {
    super(`Unknown workflow: ${workflow}`);
    this.workflow = workflow;
  }
}

/**
 * Thrown by `engine.schedules` when a request can't be a schedule: a cron that
 * doesn't parse or never fires, an `at` that is invalid or has passed, both or
 * neither of `cron` and `at`, an empty name, an empty update, or an update that
 * would turn a repeating schedule into a one-time one or back. Nothing changes.
 */
export class InvalidScheduleError extends Error {
  override name = "InvalidScheduleError";
}
