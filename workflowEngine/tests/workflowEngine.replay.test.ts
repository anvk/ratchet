// Replaying a workflow function is plain code over plain data, so these need no
// database or workers. The second half drives whole workflows to the end with a
// small in-memory stand-in for the engine.

import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { NonRetryableError, StepFailedError } from "../src/workflowEngine.errors.ts";
import {
  advance,
  locate,
  type Decision,
  type ReplayRequest,
  type SavedStep,
  type StepOptions,
  type StepRunContext,
  type WorkflowFunction,
} from "../src/workflowEngine.replay.ts";

/** A replay request for a function, with nothing saved unless given. */
function requestFor<Input>(
  run: WorkflowFunction<Input>,
  steps: Record<string, SavedStep> = {},
  input?: Input,
): ReplayRequest<Input> {
  return { run, runId: "run-1", input: input as Input, steps };
}

const succeeded = (output: unknown): SavedStep => ({ status: "succeeded", output });
const open: SavedStep = { status: "open" };
const failed = (error = "boom"): SavedStep => ({
  status: "failed",
  reason: "attempts_exhausted",
  error,
});

/** A step function that must never be called, for steps whose result is saved. */
const mustNotRun = () => {
  throw new Error("a saved step ran again");
};

test("a function that asks for nothing completes with what it returns", async () => {
  assert.deepEqual(await advance(requestFor(async () => "done")), {
    kind: "completed",
    output: "done",
  });
  // Not async at all.
  assert.deepEqual(await advance(requestFor(() => 42)), { kind: "completed", output: 42 });
});

test("a function parks on the first step it has no result for", async () => {
  const decision = await advance(
    requestFor(async (ctx) => {
      await ctx.step("first", mustNotRun, { maxAttempts: 5 });
      await ctx.step("second", mustNotRun);
    }),
  );

  assert.deepEqual(decision, {
    kind: "parked",
    requested: [{ name: "first", options: { maxAttempts: 5 }, after: [] }],
    waitingOn: ["first"],
  });
});

test("saved steps hand back their outputs without running, and the function goes on", async () => {
  const run: WorkflowFunction = async (ctx) => {
    const first = await ctx.step<number>("first", mustNotRun);
    const second = await ctx.step<number>("second", mustNotRun);
    return ctx.step("third", () => first + second);
  };

  assert.deepEqual(await advance(requestFor(run, { first: succeeded(1) })), {
    kind: "parked",
    requested: [{ name: "second", options: {}, after: ["first"] }],
    waitingOn: ["second"],
  });
  assert.deepEqual(await advance(requestFor(run, { first: succeeded(1), second: succeeded(2) })), {
    kind: "parked",
    requested: [{ name: "third", options: {}, after: ["second"] }],
    waitingOn: ["third"],
  });
  assert.deepEqual(
    await advance(
      requestFor(run, { first: succeeded(1), second: succeeded(2), third: succeeded(3) }),
    ),
    { kind: "completed", output: 3 },
  );
});

test("a step that is already open is waited on, not requested again", async () => {
  const decision = await advance(
    requestFor(async (ctx) => ctx.step("only", mustNotRun), { only: open }),
  );

  assert.deepEqual(decision, { kind: "parked", requested: [], waitingOn: ["only"] });
});

test("steps asked for together are requested together, and the function goes on only when all are saved", async () => {
  const run: WorkflowFunction = async (ctx) => {
    const [left, right] = await Promise.all([
      ctx.step<string>("left", mustNotRun),
      ctx.step<string>("right", mustNotRun),
    ]);
    return ctx.step("join", () => left + right);
  };

  assert.deepEqual(await advance(requestFor(run)), {
    kind: "parked",
    requested: [
      { name: "left", options: {}, after: [] },
      { name: "right", options: {}, after: [] },
    ],
    waitingOn: ["left", "right"],
  });
  // One of the two has finished: nothing new to do.
  assert.deepEqual(await advance(requestFor(run, { left: succeeded("l"), right: open })), {
    kind: "parked",
    requested: [],
    waitingOn: ["right"],
  });
  assert.deepEqual(
    await advance(requestFor(run, { left: succeeded("l"), right: succeeded("r") })),
    {
      kind: "parked",
      requested: [{ name: "join", options: {}, after: ["left", "right"] }],
      waitingOn: ["join"],
    },
  );
});

test("a step that failed for good throws where it was asked for, and uncaught it fails the run for the step's reason", async () => {
  const decision = await advance(
    requestFor(
      async (ctx) => {
        await ctx.step("charge", mustNotRun);
        await ctx.step("ship", mustNotRun);
      },
      { charge: { status: "failed", reason: "lost_worker", error: "Lost its worker" } },
    ),
  );

  assert.deepEqual(decision, {
    kind: "failed",
    reason: "lost_worker",
    error: "Lost its worker",
    step: "charge",
  });
});

test("a function can catch a step's failure and carry on", async () => {
  let caught: unknown;
  const run: WorkflowFunction = async (ctx) => {
    try {
      await ctx.step("charge", mustNotRun);
    } catch (err) {
      caught = err;
      await ctx.step("refund", mustNotRun);
      return "refunded";
    }
    return "charged";
  };

  assert.deepEqual(await advance(requestFor(run, { charge: failed("card declined") })), {
    kind: "parked",
    requested: [{ name: "refund", options: {}, after: ["charge"] }],
    waitingOn: ["refund"],
  });
  assert.ok(caught instanceof StepFailedError);
  assert.equal(caught.step, "charge");
  assert.equal(caught.reason, "attempts_exhausted");
  assert.equal(caught.message, "card declined");

  assert.deepEqual(await advance(requestFor(run, { charge: failed(), refund: succeeded(null) })), {
    kind: "completed",
    output: "refunded",
  });
});

test("a function's own error fails the run: non_retryable for a NonRetryableError, workflow_error for anything else", async () => {
  assert.deepEqual(
    await advance(
      requestFor(async () => {
        throw new NonRetryableError("Rejected by the reviewer");
      }),
    ),
    { kind: "failed", reason: "non_retryable", error: "Rejected by the reviewer" },
  );
  assert.deepEqual(
    await advance(
      requestFor(async () => {
        throw new TypeError("x is not a function");
      }),
    ),
    { kind: "failed", reason: "workflow_error", error: "x is not a function" },
  );
  // Thrown before any await, by a function that isn't async.
  assert.deepEqual(
    await advance(
      requestFor(() => {
        throw "not even an Error"; // oxlint-disable-line no-throw-literal
      }),
    ),
    { kind: "failed", reason: "workflow_error", error: "not even an Error" },
  );
});

test("a failed step that is asked for but not waited on is not an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const decision = await advance(
      requestFor(
        async (ctx) => {
          void ctx.step("ignored", mustNotRun);
          await ctx.step("awaited", mustNotRun);
        },
        { ignored: failed() },
      ),
    );
    await nextTurn();

    assert.equal(decision.kind, "parked");
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("a step name used twice fails the run, even if the function catches everything", async () => {
  const decision = await advance(
    requestFor(async (ctx) => {
      try {
        await Promise.all([ctx.step("same", mustNotRun), ctx.step("same", mustNotRun)]);
      } catch {
        // Swallowing must not hide the mistake.
      }
    }),
  );

  assert.deepEqual(decision, {
    kind: "failed",
    reason: "workflow_error",
    error: "A step name was used more than once: same",
  });
});

test("a function that doesn't ask again for a saved step fails the run as nondeterministic", async () => {
  // The run saved "old-name"; the code now calls the step something else.
  const decision = await advance(
    requestFor(async (ctx) => ctx.step("new-name", mustNotRun), { "old-name": succeeded(1) }),
  );

  assert.deepEqual(decision, {
    kind: "failed",
    reason: "nondeterministic",
    error: "The workflow didn't ask again for steps it asked for before: old-name",
  });
});

test("a function whose path depends on which step finished first is caught", async () => {
  const run: WorkflowFunction = async (ctx) => {
    const winner = await Promise.race([
      ctx.step<string>("fast", mustNotRun),
      ctx.step<string>("slow", mustNotRun),
    ]);
    return ctx.step(`after-${winner}`, mustNotRun);
  };

  // "slow" happened to finish first, so the run went on to after-slow.
  const first = await advance(requestFor(run, { fast: open, slow: succeeded("slow") }));
  assert.deepEqual(first, {
    kind: "parked",
    requested: [{ name: "after-slow", options: {}, after: ["slow"] }],
    waitingOn: ["fast", "after-slow"],
  });

  // With both saved, the race picks "fast": a different path from the one taken.
  const second = await advance(
    requestFor(run, { fast: succeeded("fast"), slow: succeeded("slow"), "after-slow": open }),
  );
  assert.equal(second.kind, "failed");
  assert.equal(second.kind === "failed" && second.reason, "nondeterministic");
});

test("a function waiting on something that isn't a step fails the run as nondeterministic", async () => {
  const decision = await advance(
    requestFor(
      async (ctx) => {
        await ctx.step("first", mustNotRun);
        await new Promise(() => {}); // stands for a timer or a request
      },
      { first: succeeded(1) },
    ),
  );

  assert.deepEqual(decision, {
    kind: "failed",
    reason: "nondeterministic",
    error: "The workflow is waiting on something that isn't a step",
  });
});

test("a step may be named like something every object has", async () => {
  const run: WorkflowFunction = async (ctx) => ctx.step("toString", mustNotRun);

  assert.deepEqual(await advance(requestFor(run)), {
    kind: "parked",
    requested: [{ name: "toString", options: {}, after: [] }],
    waitingOn: ["toString"],
  });
  assert.deepEqual(await advance(requestFor(run, { toString: succeeded("ok") })), {
    kind: "completed",
    output: "ok",
  });
});

test("locate finds a step's code behind saved steps, with the values those steps produced", async () => {
  const run: WorkflowFunction<{ factor: number }> = async (ctx) => {
    const base = await ctx.step<number>("base", mustNotRun);
    return ctx.step("scaled", () => base * ctx.input.factor, { timeoutMs: 500 });
  };
  const request = requestFor(run, { base: succeeded(21), scaled: open }, { factor: 2 });

  const found = await locate({ request, step: "scaled" });

  assert.deepEqual(found?.options, { timeoutMs: 500 });
  assert.equal(await found?.fn({} as StepRunContext), 42);
});

test("locate finds one of several steps asked for together", async () => {
  const run: WorkflowFunction = async (ctx) =>
    Promise.all([ctx.step("left", () => "l"), ctx.step("right", () => "r")]);
  const request = requestFor(run, { left: open, right: open });

  assert.equal(await (await locate({ request, step: "right" }))?.fn({} as StepRunContext), "r");
});

test("locate returns undefined for a step the function never reaches", async () => {
  const run: WorkflowFunction = async (ctx) => {
    await ctx.step("first", mustNotRun);
    await ctx.step("second", mustNotRun);
  };

  // Not reached yet: "first" has no result, so the function is still waiting there.
  assert.equal(
    await locate({ request: requestFor(run, { first: open }), step: "second" }),
    undefined,
  );
  // Not in this code at all.
  assert.equal(
    await locate({ request: requestFor(run, { first: succeeded(1) }), step: "third" }),
    undefined,
  );
});

test("a run with a thousand saved steps replays to the end", async () => {
  const run: WorkflowFunction = async (ctx) => {
    let total = 0;
    for (let i = 0; i < 1000; i++) total += await ctx.step<number>(`step-${i}`, mustNotRun);
    return total;
  };
  const steps = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [`step-${i}`, succeeded(1)]),
  );

  assert.deepEqual(await advance(requestFor(run, steps)), { kind: "completed", output: 1000 });
});

test("a step with options that make no sense fails the run", async () => {
  const decision = await advance(
    requestFor(async (ctx) => {
      await Promise.all([
        ctx.step("a", mustNotRun, { maxAttempts: 0 }),
        ctx.step("b", mustNotRun, { backoffMs: -1, leaseMs: 1.5 }),
        ctx.step("c", mustNotRun, { backoffMs: 0, timeoutMs: 1 }),
      ]);
    }),
  );

  assert.deepEqual(decision, {
    kind: "failed",
    reason: "workflow_error",
    error:
      "Step a needs a whole, positive maxAttempts; Step b needs a whole, positive leaseMs; Step b needs a whole backoffMs of 0 or more",
  });
});

test("a new step comes straight after only the steps the function needed before asking for it", async () => {
  // load, then charge and reserve side by side, then ship after both; and an
  // audit that only waits for the charge.
  const run: WorkflowFunction = async (ctx) => {
    await ctx.step("load", mustNotRun);
    const charge = ctx.step("charge", mustNotRun);
    const reserve = ctx.step("reserve", mustNotRun);
    const audit = charge.then(() => ctx.step("audit", mustNotRun));
    const ship = Promise.all([charge, reserve]).then(() => ctx.step("ship", mustNotRun));
    return Promise.all([audit, ship]);
  };
  /** What each newly asked-for step comes after, given what is saved. */
  const afterOf = async (steps: Record<string, SavedStep>, after?: Record<string, string[]>) => {
    const decision = await advance({ ...requestFor(run, steps), after });
    assert.equal(decision.kind, "parked");
    return Object.fromEntries(
      decision.kind === "parked" ? decision.requested.map((r) => [r.name, r.after]) : [],
    );
  };
  const done = succeeded(null);

  assert.deepEqual(await afterOf({}), { load: [] });
  assert.deepEqual(await afterOf({ load: done }), { charge: ["load"], reserve: ["load"] });
  // reserve happens to be done too, but the audit didn't wait for it.
  assert.deepEqual(await afterOf({ load: done, charge: done, reserve: done }), {
    audit: ["charge"],
    ship: ["charge", "reserve"],
  });
  // The audit finished first; shipping still doesn't come after it.
  assert.deepEqual(await afterOf({ load: done, charge: done, reserve: done, audit: done }), {
    ship: ["charge", "reserve"],
  });
  // Knowing what the saved steps came after changes nothing but the work done.
  assert.deepEqual(
    await afterOf(
      { load: done, charge: done, reserve: done, audit: done },
      { load: [], charge: ["load"], reserve: ["load"], audit: ["charge"] },
    ),
    { ship: ["charge", "reserve"] },
  );
});

test("a step after a failure the function caught comes straight after the step that failed", async () => {
  const run: WorkflowFunction = async (ctx) => {
    await ctx.step("load", mustNotRun);
    try {
      await ctx.step("charge", mustNotRun);
    } catch {
      await ctx.step("refund", mustNotRun);
    }
  };

  const decision = await advance(requestFor(run, { load: succeeded(1), charge: failed() }));

  assert.deepEqual(decision, {
    kind: "parked",
    requested: [{ name: "refund", options: {}, after: ["charge"] }],
    waitingOn: ["refund"],
  });
});

// ---------------------------------------------------------------------------
// Whole workflows, driven to the end.
//
// `drive` stands in for the engine: it advances the function, runs the steps it
// asks for (finding each one's code with `locate`, and retrying a step that
// throws, as a worker would), saves what they did, and advances again, until
// the function finishes. When it finishes, the run is over: any step still
// open is stopped.
// ---------------------------------------------------------------------------

interface Driven {
  decision: Exclude<Decision, { kind: "parked" }>;
  steps: Record<string, SavedStep>;
  /** Every time a step's code ran, as `name#attempt`, in order. */
  executions: string[];
  /** Steps that were still open when the function finished. */
  stopped: string[];
}

async function drive<Input>({
  run,
  input,
  pick = (openSteps) => [openSteps[0]],
}: {
  run: WorkflowFunction<Input>;
  input?: Input;
  /** Which open steps finish before the function is advanced again. Defaults to the oldest one. */
  pick?: (openSteps: string[]) => string[];
}): Promise<Driven> {
  const steps: Record<string, SavedStep> = {};
  const options = new Map<string, StepOptions>();
  const executions: string[] = [];
  const request = () => requestFor(run, steps, input);

  /** Runs one step as a worker would: find its code, then try it until it works or runs out of attempts. */
  async function execute(name: string): Promise<SavedStep> {
    const maxAttempts = options.get(name)?.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      const found = await locate({ request: request(), step: name });
      if (!found) return { status: "failed", reason: "unknown_step", error: `No step ${name}` };
      executions.push(`${name}#${attempt}`);
      try {
        const output = await found.fn({
          runId: "run-1",
          stepName: name,
          attempt,
          idempotencyKey: `run-1:${name}`,
          abortSignal: new AbortController().signal,
        });
        return { status: "succeeded", output };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (err instanceof NonRetryableError) {
          return { status: "failed", reason: "non_retryable", error };
        }
        if (attempt === maxAttempts) {
          return { status: "failed", reason: "attempts_exhausted", error };
        }
      }
    }
  }

  for (let round = 0; round < 10_000; round++) {
    const decision = await advance(request());
    const openSteps = () => Object.keys(steps).filter((name) => steps[name].status === "open");
    if (decision.kind !== "parked") {
      return { decision, steps, executions, stopped: openSteps() };
    }
    for (const asked of decision.requested) {
      steps[asked.name] = open;
      options.set(asked.name, asked.options);
    }
    // Run them all before saving any, so steps picked together finish together.
    const picked = pick(openSteps());
    const results = await Promise.all(picked.map((name) => execute(name)));
    picked.forEach((name, i) => (steps[name] = results[i]));
  }
  throw new Error("The workflow never finished");
}

/** Three steps in a row, each adding one to the last. A step named by `failAt` fails for good. */
const pipeline: WorkflowFunction<{ failAt?: string }> = async (ctx) => {
  const add = (name: string, to: number) =>
    ctx.step(name, () => {
      if (ctx.input.failAt === name) throw new NonRetryableError(`${name} failed`);
      return { total: to + 1 };
    });
  const first = await add("first", 0);
  const second = await add("second", first.total);
  return add("third", second.total);
};

test("steps in a row each get what the one before produced", async () => {
  const { decision, steps, executions } = await drive({ run: pipeline, input: {} });

  assert.deepEqual(decision, { kind: "completed", output: { total: 3 } });
  assert.deepEqual(steps, {
    first: succeeded({ total: 1 }),
    second: succeeded({ total: 2 }),
    third: succeeded({ total: 3 }),
  });
  assert.deepEqual(executions, ["first#1", "second#1", "third#1"]);
});

test("a step that fails for good fails the run, and the steps after it are never asked for", async () => {
  const { decision, steps, executions } = await drive({
    run: pipeline,
    input: { failAt: "second" },
  });

  assert.deepEqual(decision, {
    kind: "failed",
    reason: "non_retryable",
    error: "second failed",
    step: "second",
  });
  assert.deepEqual(Object.keys(steps), ["first", "second"]);
  assert.deepEqual(executions, ["first#1", "second#1"]);
});

/**
 * A start, two steps side by side, a join that needs both and a tail that only
 * needs the right one. A side named by `failSide` fails for good.
 */
const diamond: WorkflowFunction<{ failSide?: string }> = async (ctx) => {
  const start = await ctx.step("start", () => ({ n: 1 }));
  const side = (name: string) =>
    ctx.step(name, () => {
      if (ctx.input.failSide === name) throw new NonRetryableError(`${name} failed`);
      return `${name}:${start.n}`;
    });
  const left = side("left");
  const right = side("right");
  const tail = right.then((r) => ctx.step("tail", () => ({ after: [r] })));
  const join = Promise.all([left, right]).then(([l, r]) =>
    ctx.step("join", () => ({ after: [l, r] })),
  );
  return Promise.all([join, tail]);
};

test("a step that needs two others runs once, after both, whether they finish together or apart", async () => {
  const expected = {
    kind: "completed",
    output: [{ after: ["left:1", "right:1"] }, { after: ["right:1"] }],
  };

  const apart = await drive({ run: diamond, input: {} });
  assert.deepEqual(apart.decision, expected);
  assert.equal(apart.executions.filter((e) => e.startsWith("join")).length, 1);

  const together = await drive({ run: diamond, input: {}, pick: (openSteps) => openSteps });
  assert.deepEqual(together.decision, expected);
  assert.deepEqual(together.executions.slice(0, 3).sort(), ["left#1", "right#1", "start#1"]);
  assert.equal(together.executions.filter((e) => e.startsWith("join")).length, 1);
});

test("a step starts as soon as what it needs is done, without waiting for steps beside it", async () => {
  // "right" always finishes before "left".
  const { executions } = await drive({
    run: diamond,
    input: {},
    pick: (openSteps) => [openSteps.find((name) => name !== "left") ?? "left"],
  });

  assert.ok(
    executions.indexOf("tail#1") < executions.indexOf("left#1"),
    `tail should have run before left: ${executions.join(", ")}`,
  );
  assert.ok(executions.indexOf("join#1") > executions.indexOf("left#1"));
});

test("when the function throws, the run fails at once and a step still running is stopped", async () => {
  // "left" finishes (and fails) first; "right" is still open.
  const { decision, steps, executions, stopped } = await drive({
    run: diamond,
    input: { failSide: "left" },
  });

  assert.deepEqual(decision, {
    kind: "failed",
    reason: "non_retryable",
    error: "left failed",
    step: "left",
  });
  assert.deepEqual(stopped, ["right"]);
  assert.deepEqual(executions, ["start#1", "left#1"]);
  assert.equal("join" in steps, false);
  assert.equal("tail" in steps, false);
});

test("when the function returns, the run is over, and a step it started without waiting for never runs", async () => {
  const { decision, stopped, executions } = await drive({
    run: async (ctx) => {
      void ctx.step("not-awaited", () => "never needed");
      return "done";
    },
  });

  // It was never even requested: the function had finished by the time the engine looked.
  assert.deepEqual(decision, { kind: "completed", output: "done" });
  assert.deepEqual(stopped, []);
  assert.deepEqual(executions, []);
});

/** A step that throws on its first `failures` attempts, between two plain steps. */
const flaky: WorkflowFunction<{ failures: number; catchIt?: boolean }> = async (ctx) => {
  await ctx.step("before", () => null);
  const attempt = ctx.step(
    "flaky",
    (step) => {
      if (step.attempt <= ctx.input.failures) throw new Error(`attempt ${step.attempt} failed`);
      return { attempt: step.attempt };
    },
    { maxAttempts: 3 },
  );
  if (!ctx.input.catchIt) {
    const result = await attempt;
    await ctx.step("after", () => null);
    return result;
  }
  try {
    return await attempt;
  } catch {
    return ctx.step("undo", () => "undone");
  }
};

test("a step that throws is tried again, and steps that succeeded are not", async () => {
  const { decision, executions } = await drive({ run: flaky, input: { failures: 2 } });

  assert.deepEqual(decision, { kind: "completed", output: { attempt: 3 } });
  assert.deepEqual(executions, ["before#1", "flaky#1", "flaky#2", "flaky#3", "after#1"]);
});

test("a step that runs out of attempts fails the run, unless the function catches it and undoes the work", async () => {
  const uncaught = await drive({ run: flaky, input: { failures: 99 } });
  assert.deepEqual(uncaught.decision, {
    kind: "failed",
    reason: "attempts_exhausted",
    error: "attempt 3 failed",
    step: "flaky",
  });
  assert.equal("after" in uncaught.steps, false);

  const caught = await drive({ run: flaky, input: { failures: 99, catchIt: true } });
  assert.deepEqual(caught.decision, { kind: "completed", output: "undone" });
  assert.deepEqual(caught.executions.slice(-1), ["undo#1"]);
});

test("a function can loop and branch on what its steps return", async () => {
  // Tries vendors in turn until one answers.
  const run: WorkflowFunction<{ vendors: string[]; working: string }> = async (ctx) => {
    for (const vendor of ctx.input.vendors) {
      const answered = await ctx.step(`ask-${vendor}`, () => vendor === ctx.input.working);
      if (answered) return ctx.step("use", () => vendor);
    }
    throw new NonRetryableError("No vendor answered");
  };

  const found = await drive({ run, input: { vendors: ["a", "b", "c"], working: "b" } });
  assert.deepEqual(found.decision, { kind: "completed", output: "b" });
  assert.deepEqual(found.executions, ["ask-a#1", "ask-b#1", "use#1"]);

  const none = await drive({ run, input: { vendors: ["a", "b"], working: "z" } });
  assert.deepEqual(none.decision, {
    kind: "failed",
    reason: "non_retryable",
    error: "No vendor answered",
  });
});
