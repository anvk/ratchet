import type { WorkflowLabels } from "./api.types.ts";

/** A value after JSON serialization: dates become ISO strings. */
export type ToJson<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? ToJson<U>[]
    : T extends object
      ? { [K in keyof T]: ToJson<T[K]> }
      : T;

/**
 * Returns exactly what the client will receive. Assigning the result to a type
 * from api.types.ts makes TypeScript check the response against it.
 */
export function toJson<T>(value: T): ToJson<T> {
  return JSON.parse(JSON.stringify(value)) as ToJson<T>;
}

/**
 * Turns an identifier into display text: hyphens and underscores become spaces
 * and the first letter is upper-cased. "score-risk" becomes "Score risk".
 */
export function titleFromName(name: string): string {
  const spaced = name.replace(/[-_]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The title and description to show for a workflow: the app's labels if it gave
 * any, else a title made from the name and no description.
 */
export function workflowLabel({
  labels,
  workflow,
}: {
  labels: Record<string, WorkflowLabels> | undefined;
  workflow: string;
}): { title: string; description: string | null } {
  const found = labels?.[workflow];
  return found
    ? { title: found.title, description: found.description }
    : { title: titleFromName(workflow), description: null };
}

/**
 * The title and description to show for a step: the app's labels if it gave
 * any, else a title made from the step's name and no description.
 */
export function stepLabel({
  labels,
  workflow,
  step,
}: {
  labels: Record<string, WorkflowLabels> | undefined;
  workflow: string;
  step: string;
}): { title: string; description: string | null } {
  const found = labels?.[workflow]?.steps[step];
  return found
    ? { title: found.title, description: found.description }
    : { title: titleFromName(step), description: null };
}
