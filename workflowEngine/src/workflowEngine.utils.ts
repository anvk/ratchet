// Safe to import in a browser: this file only imports constants and types. The
// client uses it through "@ratchet/engine/utils".

import {
  REDRIVABLE_FAILURE_REASONS,
  type FailureReason,
  type WorkflowRunStatus,
} from "./workflowEngine.constants.ts";
import type { StepDefaults } from "./workflowEngine.types.ts";

/** Throws if a name appears more than once. `what` labels the error message. */
export function assertUnique(names: string[], what: string) {
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) throw new Error(`Duplicate ${what}: ${duplicate}`);
}

/**
 * How long to wait before running a step again after its `attempt`-th attempt
 * failed: backoffMs, doubling each time, capped at maxBackoffMs, then spread by
 * up to 20% either way so steps that failed together don't all retry together.
 */
export function retryDelayMs({
  attempt,
  backoffMs,
  maxBackoffMs,
  random = Math.random,
}: {
  attempt: number;
  backoffMs: number;
  maxBackoffMs: number;
  /** A number in [0, 1). Tests pass a fixed one. */
  random?: () => number;
}) {
  const base = Math.min(backoffMs * 2 ** (attempt - 1), maxBackoffMs);
  return Math.round(base * (0.8 + random() * 0.4));
}

/** The parts of an engine's settings that apply to steps which don't set their own. */
export function stepDefaults(settings: StepDefaults): StepDefaults {
  const { leaseMs, maxAttempts, backoffMs, maxBackoffMs } = settings;
  return { leaseMs, maxAttempts, backoffMs, maxBackoffMs };
}

/**
 * Whether a run can be resumed: one that was cancelled, or one that failed in a
 * way that redriving it could fix.
 */
export function canRedrive(status: WorkflowRunStatus, failureReason: FailureReason | null) {
  if (status === "cancelled") return true;
  return (
    status === "failed" &&
    failureReason !== null &&
    REDRIVABLE_FAILURE_REASONS.includes(failureReason)
  );
}
