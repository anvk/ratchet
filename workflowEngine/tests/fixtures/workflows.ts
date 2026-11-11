import { setTimeout as sleep } from "node:timers/promises";
import { defineWorkflow, NonRetryableError } from "../../src/index.ts";

interface PipelineInput {
  /** Name of the step that should throw. */
  failAt?: string;
}

/** Builds a test step that fails for good if input.failAt names it, and otherwise returns a total. */
function step(name: string, value: (outputs: Record<string, { total: number }>) => number) {
  return {
    name,
    title: name,
    description: `Test step ${name}`,
    async run(ctx: { input: PipelineInput; outputs: Record<string, any>; idempotencyKey: string }) {
      if (ctx.input.failAt === name) throw new NonRetryableError(`${name} failed`);
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

interface FlakyInput {
  /** How many attempts fail before one succeeds. */
  failures?: number;
  /** Fail with a NonRetryableError instead, which shouldn't be retried. */
  final?: boolean;
}

/** A step that fails its first few attempts, with quick retries. */
export const flaky = defineWorkflow<FlakyInput>({
  name: "flaky",
  title: "Flaky",
  description: "Fails a set number of times, then succeeds.",
  steps: [
    {
      name: "call",
      title: "Call",
      description: "Like a call to an unreliable service.",
      maxAttempts: 4,
      backoffMs: 50,
      async run(ctx) {
        if (ctx.input.final) throw new NonRetryableError("Declined");
        if (ctx.attempt <= (ctx.input.failures ?? 0)) {
          throw new Error(`Timed out on attempt ${ctx.attempt}`);
        }
        return { attempt: ctx.attempt };
      },
    },
    {
      name: "after",
      title: "After",
      description: "Runs once call succeeds.",
      run: async () => null,
    },
  ],
});

/** A step that blocks its worker past its lease on every attempt, like one that keeps crashing it. */
export const doomed = defineWorkflow({
  name: "doomed",
  title: "Doomed",
  description: "Loses its lease every time.",
  steps: [
    {
      name: "hog",
      title: "Hog",
      description: "Blocks the event loop past its lease.",
      leaseMs: 200,
      maxAttempts: 2,
      async run() {
        const until = Date.now() + 700;
        while (Date.now() < until) {
          // Busy, so no heartbeat can run.
        }
        return null;
      },
    },
  ],
});

export const workflows = [pipeline, slow, flaky, doomed];
