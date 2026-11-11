import type { Step } from "@ratchet/api/types";
import type { StepDisplayStatus } from "../constants/statuses";

/**
 * How a step's status reads in the dashboard. A step waiting to retry is
 * `ready` in the database, but it has already run at least once, which a
 * first-time `ready` step hasn't, so it shows as "retrying".
 */
export function stepDisplayStatus(step: Pick<Step, "status" | "attempt">): StepDisplayStatus {
  return step.status === "ready" && step.attempt > 0 ? "retrying" : step.status;
}

/**
 * How far each step is from the start: 0 for a step that needs nothing, else
 * one more than the furthest step it needs. Steps at the same depth can run
 * side by side, so the diagram lays them out in one column.
 */
export function stepDepths(steps: Pick<Step, "name" | "needs">[]): Map<string, number> {
  const depths = new Map<string, number>();
  const depthOf = (step: Pick<Step, "name" | "needs">): number => {
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
