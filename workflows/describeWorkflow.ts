import type { WorkflowLabels } from "@ratchet/api/types";
import { defineWorkflow, type StepDefinition, type WorkflowDefinition } from "@ratchet/engine";

/** The text the dashboard shows for a workflow or one of its steps. */
type Labelled = { title: string; description: string };

/** A workflow definition whose workflow and steps also carry a title and description. */
export type DescribedWorkflow<Input> = Omit<WorkflowDefinition<Input>, "steps"> &
  Labelled & { steps: (StepDefinition<Input> & Labelled)[] };

/**
 * Defines a workflow for the engine and collects the text the dashboard shows
 * for it: the workflow's and each step's title and description. The definition
 * handed to the engine carries neither.
 */
export function describeWorkflow<Input = unknown>({
  title,
  description,
  steps,
  ...workflow
}: DescribedWorkflow<Input>): { definition: WorkflowDefinition<Input>; labels: WorkflowLabels } {
  const stepLabels: WorkflowLabels["steps"] = {};
  const engineSteps = steps.map(({ title, description, ...step }) => {
    stepLabels[step.name] = { title, description };
    return step;
  });
  return {
    definition: defineWorkflow<Input>({ ...workflow, steps: engineSteps }),
    labels: { title, description, steps: stepLabels },
  };
}
