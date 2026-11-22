import type { WorkflowLabels } from "@ratchet/api/types";
import { defineWorkflow, type WorkflowDefinition } from "@ratchet/engine";

/** The text the dashboard shows for a workflow or one of its steps. */
type Labelled = { title: string; description: string };

/**
 * A workflow definition that also carries the text the dashboard shows: a title
 * and description for the workflow, and for each step its code asks for, by the
 * step's name.
 */
export type DescribedWorkflow<Input> = WorkflowDefinition<Input> &
  Labelled & { steps: Record<string, Labelled> };

/**
 * Defines a workflow for the engine and collects the text the dashboard shows
 * for it. The definition handed to the engine carries none of it. The engine
 * doesn't know these steps: they are labels for the names the workflow's code
 * uses, and a step with no label is shown by its name.
 */
export function describeWorkflow<Input = unknown>({
  title,
  description,
  steps,
  ...workflow
}: DescribedWorkflow<Input>): { definition: WorkflowDefinition<Input>; labels: WorkflowLabels } {
  return {
    definition: defineWorkflow<Input>(workflow),
    labels: { title, description, steps },
  };
}
