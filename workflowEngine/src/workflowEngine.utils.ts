// Safe to import in a browser: this file only imports constants and types. The
// client uses it through "@ratchet/engine/utils".

import {
  FINISHED_RUN_STATUSES,
  REDRIVABLE_FAILURE_REASONS,
  type FailureReason,
  type WorkflowRunStatus,
} from "./workflowEngine.constants.ts";
import type { StepDefaults, WorkflowEngineSettings } from "./workflowEngine.types.ts";

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
export function stepDefaults(settings: WorkflowEngineSettings): StepDefaults {
  const { leaseMs, maxAttempts, backoffMs, maxBackoffMs } = settings;
  return { leaseMs, maxAttempts, backoffMs, maxBackoffMs };
}

/** Whether a run failed in a way that redriving it could fix. */
export function canRedrive(status: WorkflowRunStatus, failureReason: FailureReason | null) {
  return (
    status === "failed" &&
    failureReason !== null &&
    REDRIVABLE_FAILURE_REASONS.includes(failureReason)
  );
}

/** Whether a run has stopped for good, either way. */
export function isRunFinished(status: WorkflowRunStatus) {
  return FINISHED_RUN_STATUSES.includes(status);
}

/** A step's name and what it needs, as far as the order of steps goes. */
export interface StepLink {
  name: string;
  needs: string[];
}

/**
 * Each step's needs, in the order given: its own `needs`, or else the step
 * listed before it, so a list of steps without needs runs in order.
 */
export function resolveNeeds(steps: { name: string; needs?: string[] }[]): StepLink[] {
  return steps.map((step, i) => ({
    name: step.name,
    needs: step.needs ?? (i === 0 ? [] : [steps[i - 1].name]),
  }));
}

/**
 * Every step a step depends on, directly or through other steps. All of them
 * have succeeded by the time it runs, so their outputs are safe to read.
 */
export function ancestors(steps: StepLink[], name: string): Set<string> {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const found = new Set<string>();
  const visit = (stepName: string) => {
    for (const need of byName.get(stepName)?.needs ?? []) {
      if (found.has(need)) continue;
      found.add(need);
      visit(need);
    }
  };
  visit(name);
  return found;
}

/**
 * How far each step is from the start: 0 for a step that needs nothing, else
 * one more than the furthest step it needs. Steps at the same depth can run
 * side by side, so the dashboard lays them out in one column.
 */
export function stepDepths(steps: StepLink[]): Map<string, number> {
  const depths = new Map<string, number>();
  const depthOf = (step: StepLink): number => {
    const known = depths.get(step.name);
    if (known !== undefined) return known;
    const needed = step.needs.map((n) => steps.find((s) => s.name === n));
    const depth = Math.max(-1, ...needed.map((s) => (s ? depthOf(s) : -1))) + 1;
    depths.set(step.name, depth);
    return depth;
  };
  for (const step of steps) depthOf(step);
  return depths;
}
