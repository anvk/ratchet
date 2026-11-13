import type { WorkflowLabels } from "@ratchet/api/types";
import { defineWorkflow, type StepDefinition, type WorkflowDefinition } from "@ratchet/engine";

/**
 * Defines a workflow for the engine and collects the text the dashboard shows
 * for it: the workflow's and each step's title and description.
 */
export function describeWorkflow<Input = unknown>(
  workflow: WorkflowDefinition<Input> & { steps: StepDefinition<Input>[] },
): { definition: WorkflowDefinition<Input>; labels: WorkflowLabels } {
  return {
    definition: defineWorkflow<Input>(workflow),
    labels: {
      title: workflow.title,
      description: workflow.description,
      steps: Object.fromEntries(
        workflow.steps.map(({ name, title, description }) => [name, { title, description }]),
      ),
    },
  };
}
