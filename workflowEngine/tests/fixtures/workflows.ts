import { setTimeout as sleep } from "node:timers/promises";
import { defineWorkflow, NonRetryableError, type WorkflowFunction } from "../../src/index.ts";

interface PipelineInput {
  /** Name of the step that should throw. */
  failAt?: string;
}

/** Three steps, each adding one to the previous step's output. */
export const pipeline = defineWorkflow<PipelineInput>({
  name: "pipeline",
  version: "1",
  async run(ctx) {
    /** A step that fails for good if input.failAt names it, and otherwise adds one to `to`. */
    const add = (name: string, to: number) =>
      ctx.step(name, (step) => {
        if (ctx.input.failAt === name) throw new NonRetryableError(`${name} failed`);
        return { total: to + 1, idempotencyKey: step.idempotencyKey };
      });
    const first = await add("first", 0);
    const second = await add("second", first.total);
    return add("third", second.total);
  },
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
  version: "1",
  async run(ctx) {
    await ctx.step(
      "work",
      async (step) => {
        if (step.attempt === 1) {
          if (ctx.input.waitMs) await sleep(ctx.input.waitMs);
          if (ctx.input.blockMs) {
            const until = Date.now() + ctx.input.blockMs;
            while (Date.now() < until) {
              // Busy, so timers (and heartbeats) can't fire.
            }
          }
        }
        return { attempt: step.attempt, leaseLost: step.abortSignal.aborted };
      },
      { leaseMs: 300 },
    );
    await ctx.step("done", () => null);
  },
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
  version: "1",
  async run(ctx) {
    await ctx.step("prepare", () => ({ prepared: true }));
    await ctx.step(
      "call",
      (step) => {
        if (ctx.input.final) throw new NonRetryableError("Declined");
        if (step.attempt <= (ctx.input.failures ?? 0)) {
          throw new Error(`Timed out on attempt ${step.attempt}`);
        }
        return { attempt: step.attempt };
      },
      { maxAttempts: 4, backoffMs: 50 },
    );
    await ctx.step("after", () => null);
  },
});

/** A step that blocks its worker past its lease on every attempt, like one that keeps crashing it. */
export const doomed = defineWorkflow({
  name: "doomed",
  version: "1",
  async run(ctx) {
    await ctx.step(
      "hog",
      () => {
        const until = Date.now() + 700;
        while (Date.now() < until) {
          // Busy, so no heartbeat can run.
        }
        return null;
      },
      { leaseMs: 200, maxAttempts: 2 },
    );
  },
});

interface DiamondInput {
  /** How long each branch takes, so the two finish at about the same moment. */
  branchMs?: number;
  /** A branch that fails for good, after branchMs. */
  failBranch?: "left" | "right";
  /** How long the other branch takes when one fails, so it's still running. */
  survivorMs?: number;
  /** Catch a branch's failure and carry on without the join, instead of failing the run. */
  catchFailure?: boolean;
}

/**
 * start, then left and right side by side, then join once both are done. tail
 * only waits for right. Each step reports the steps whose results it was given.
 */
export const diamond = defineWorkflow<DiamondInput>({
  name: "diamond",
  version: "1",
  async run(ctx) {
    await ctx.step("start", () => ({ n: 1 }));
    /** A branch: waits (stopping early if it is stopped), then reports what it was given. */
    const branch = (name: "left" | "right") =>
      ctx.step(name, async (step) => {
        const { failBranch, branchMs = 50, survivorMs } = ctx.input;
        const ms = failBranch && failBranch !== name ? (survivorMs ?? branchMs) : branchMs;
        await sleep(ms, undefined, { signal: step.abortSignal });
        if (failBranch === name) throw new NonRetryableError(`${name} failed`);
        return { seen: ["start"] };
      });
    const left = branch("left");
    const right = branch("right");
    const tail = right.then(() => ctx.step("tail", () => ({ seen: ["right", "start"] })));
    const join = Promise.all([left, right]).then(() =>
      ctx.step("join", () => ({ seen: ["left", "right", "start"] })),
    );
    if (!ctx.input.catchFailure) return Promise.all([join, tail]);
    const [joined, tailed] = await Promise.allSettled([join, tail]);
    return { joined: joined.status, tailed: tailed.status };
  },
});

interface GroupInput {
  /** The concurrency group; a run without one belongs to no group. */
  group?: string;
  /** How long the step takes. */
  ms?: number;
  /** Fail for good, in a way that can't be redriven. */
  decline?: boolean;
  /** Fail the first attempt only, so the run can be redriven and then succeeds. */
  failFirst?: boolean;
}

/** The code of the grouped workflows: one step that waits, then succeeds or fails as the input says. */
const groupRun: WorkflowFunction<GroupInput> = (ctx) =>
  ctx.step(
    "work",
    async (step) => {
      await sleep(ctx.input.ms ?? 50);
      if (ctx.input.decline) throw new NonRetryableError("Declined");
      if (ctx.input.failFirst && step.attempt === 1) throw new Error("Failed the first attempt");
      return { done: true };
    },
    { maxAttempts: 1 },
  );

/** Runs of one group go one at a time. */
export const exclusive = defineWorkflow<GroupInput>({
  name: "exclusive",
  version: "1",
  concurrency: { key: (input) => input.group ?? null, limit: 1 },
  run: groupRun,
});

/** Runs of one group go two at a time. */
export const paired = defineWorkflow<GroupInput>({
  name: "paired",
  version: "1",
  concurrency: { key: (input) => input.group ?? null, limit: 2 },
  run: groupRun,
});

interface StallingInput {
  /** How many attempts hang until they time out before one succeeds. */
  hangAttempts?: number;
}

/** One step with a time limit, whose first attempts can hang until they are timed out. */
export const stalling = defineWorkflow<StallingInput>({
  name: "stalling",
  version: "1",
  run: (ctx) =>
    ctx.step(
      "call",
      async (step) => {
        if (step.attempt <= (ctx.input.hangAttempts ?? 0)) {
          await new Promise<void>((resolve) =>
            step.abortSignal.addEventListener("abort", () => resolve(), { once: true }),
          );
          throw new Error("Stopped");
        }
        return { attempt: step.attempt };
      },
      { timeoutMs: 300, maxAttempts: 3, backoffMs: 10 },
    ),
});

interface CancellableInput {
  /** How long the step takes when it ignores the signal. */
  ms?: number;
  /** Wait for the abort signal instead (or 10 seconds), so only a cancel releases the worker early. */
  untilSignal?: boolean;
}

/** A short-leased step that can be cancelled while it runs, then a step that returns at once. */
export const cancellable = defineWorkflow<CancellableInput>({
  name: "cancellable",
  version: "1",
  async run(ctx) {
    await ctx.step(
      "work",
      async (step) => {
        if (ctx.input.untilSignal) {
          await sleep(10_000, undefined, { signal: step.abortSignal }).catch(() => {});
        } else {
          await sleep(ctx.input.ms ?? 50);
        }
        return { done: true };
      },
      { leaseMs: 300, maxAttempts: 1 },
    );
    await ctx.step("after", () => null);
  },
});

/** One quick step returning its input, for the schedule tests to start on a schedule. */
export const scheduled = defineWorkflow<{ from?: string }>({
  name: "scheduled",
  version: "1",
  run: (ctx) => ctx.step("only", () => ctx.input),
});

interface ScheduledExclusiveInput {
  /** How long the step takes. */
  ms?: number;
}

/** A workflow for the schedule tests whose runs go one at a time. */
export const scheduledExclusive = defineWorkflow<ScheduledExclusiveInput>({
  name: "scheduled-exclusive",
  version: "1",
  concurrency: { key: () => "scheduled-exclusive", limit: 1 },
  run: (ctx) =>
    ctx.step("only", async () => {
      await sleep(ctx.input.ms ?? 50);
      return { done: true };
    }),
});

export const workflows = [
  pipeline,
  slow,
  flaky,
  doomed,
  diamond,
  exclusive,
  paired,
  stalling,
  cancellable,
];

/**
 * Workflows the schedule tests create schedules for, kept apart from `workflows`
 * so an orchestrator built from the default list never fires them. Workers and
 * the harness load both.
 */
export const scheduledWorkflows = [scheduled, scheduledExclusive];
