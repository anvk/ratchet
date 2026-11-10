import { setTimeout as sleep } from "node:timers/promises";
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

interface SlowInput {
  /** How long the first attempt waits, without blocking the event loop. */
  waitMs?: number;
  /** How long the first attempt blocks the event loop, so no heartbeat can run. */
  blockMs?: number;
}

/**
 * A step with a short lease whose first attempt is slow, in one of two ways.
 * Later attempts finish at once, so a test can tell which attempt won.
 */
export const slow = defineWorkflow<SlowInput>({
  name: "slow",
  title: "Slow",
  description: "A short-leased step whose first attempt takes a while.",
  steps: [
    {
      name: "work",
      title: "Work",
      description: "Slow on the first attempt.",
      leaseMs: 300,
      async run(ctx) {
        if (ctx.attempt === 1) {
          if (ctx.input.waitMs) await sleep(ctx.input.waitMs);
          if (ctx.input.blockMs) {
            const until = Date.now() + ctx.input.blockMs;
            while (Date.now() < until) {
              // Busy, so timers (and heartbeats) can't fire.
            }
          }
        }
        return { attempt: ctx.attempt, leaseLost: ctx.signal.aborted };
      },
    },
    { name: "done", title: "Done", description: "Runs after work.", run: async () => null },
  ],
});

export const workflows = [pipeline, slow];
