import { defineWorkflow } from "../../src/index.ts";

interface PipelineInput {
  /** Name of the step that should throw. */
  failAt?: string;
}

/** Builds a test step that throws if input.failAt names it, and otherwise returns a total. */
function step(name: string, value: (outputs: Record<string, { total: number }>) => number) {
  return {
    name,
    title: name,
    description: `Test step ${name}`,
    async run(ctx: { input: PipelineInput; outputs: Record<string, any>; idempotencyKey: string }) {
      if (ctx.input.failAt === name) throw new Error(`${name} failed`);
      return { total: value(ctx.outputs), idempotencyKey: ctx.idempotencyKey };
    },
  };
}

/** Three steps, each adding one to the previous step's output. */
export const pipeline = defineWorkflow<PipelineInput>({
  name: "pipeline",
  title: "Pipeline",
  description: "Three steps that pass a running total along.",
  steps: [
    step("first", () => 1),
    step("second", (outputs) => outputs.first.total + 1),
    step("third", (outputs) => outputs.second.total + 1),
  ],
});

export const workflows = [pipeline];
