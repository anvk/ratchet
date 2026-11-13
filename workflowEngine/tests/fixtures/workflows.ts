import { setTimeout as sleep } from "node:timers/promises";
import { defineWorkflow, NonRetryableError, type StepContext } from "../../src/index.ts";

interface PipelineInput {
  /** Name of the step that should throw. */
  failAt?: string;
}

/** Builds a test step that fails for good if input.failAt names it, and otherwise returns a total. */
function step(name: string, value: (outputs: Record<string, { total: number }>) => number) {
  return {
    name,
    async run(ctx: { input: PipelineInput; outputs: Record<string, any>; idempotencyKey: string }) {
      if (ctx.input.failAt === name) throw new NonRetryableError(`${name} failed`);
      return { total: value(ctx.outputs), idempotencyKey: ctx.idempotencyKey };
    },
  };
}

/** Three steps, each adding one to the previous step's output. */
export const pipeline = defineWorkflow<PipelineInput>({
  name: "pipeline",
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
  steps: [
    {
      name: "work",
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
    { name: "done", run: async () => null },
  ],
});

interface FlakyInput {
  /** How many attempts fail before one succeeds. */
  failures?: number;
  /** Fail with a NonRetryableError instead, which shouldn't be retried. */
  final?: boolean;
}

/** A step that fails its first few attempts, with quick retries, between two plain steps. */
export const flaky = defineWorkflow<FlakyInput>({
  name: "flaky",
  steps: [
    {
      name: "prepare",
      run: async () => ({ prepared: true }),
    },
    {
      name: "call",
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
      run: async () => null,
    },
  ],
});

/** A step that blocks its worker past its lease on every attempt, like one that keeps crashing it. */
export const doomed = defineWorkflow({
  name: "doomed",
  steps: [
    {
      name: "hog",
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

interface DiamondInput {
  /** How long each branch takes, so the two finish at about the same moment. */
  branchMs?: number;
  /** A branch that fails for good, after branchMs. */
  failBranch?: "left" | "right";
  /** How long the other branch takes when one fails, so it's still running. */
  survivorMs?: number;
}

/** A branch step: waits (stopping early if it loses its lease), then reports what it could see. */
function branch(name: "left" | "right") {
  return {
    name,
    needs: ["start"],
    async run(ctx: StepContext<DiamondInput>) {
      const { failBranch, branchMs = 50, survivorMs } = ctx.input;
      const ms = failBranch && failBranch !== name ? (survivorMs ?? branchMs) : branchMs;
      await sleep(ms, undefined, { signal: ctx.signal });
      if (failBranch === name) throw new NonRetryableError(`${name} failed`);
      return { seen: Object.keys(ctx.outputs).sort() };
    },
  };
}

/** start, then left and right side by side, then join once both are done. tail only needs right. */
export const diamond = defineWorkflow<DiamondInput>({
  name: "diamond",
  steps: [
    { name: "start", run: async () => ({ n: 1 }) },
    branch("left"),
    branch("right"),
    {
      name: "join",
      needs: ["left", "right"],
      run: async (ctx) => ({ seen: Object.keys(ctx.outputs).sort() }),
    },
    {
      name: "tail",
      needs: ["right"],
      run: async (ctx) => ({ seen: Object.keys(ctx.outputs).sort() }),
    },
  ],
});

export const workflows = [pipeline, slow, flaky, doomed, diamond];
