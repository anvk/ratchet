import { createHash } from "node:crypto";
import { sql } from "kysely";
import { InvalidScheduleError } from "../../workflowEngine.errors.ts";
import { db, type Tx } from "./db/index.ts";
import {
  ancestors,
  canRedrive,
  dependents,
  resolveNeeds,
  retryDelayMs,
} from "../../workflowEngine.utils.ts";
import { nextFireAfter } from "../../workflowEngine.cron.ts";
import type { FailureReason } from "../../workflowEngine.constants.ts";
import type {
  Claim,
  ClaimOrder,
  EventFields,
  FinalFailure,
  ScheduledRun,
  StepDefaults,
  WorkflowDefinition,
  WorkflowStore,
} from "../../workflowEngine.types.ts";

// Every state change calls this inside its own transaction, so the history
// can never disagree with the current state.
async function emit({
  trx,
  runId,
  type,
  stepName,
  attempt,
  workerId,
  detail,
}: { trx: Tx; runId: string; type: string } & EventFields) {
  await trx
    .insertInto("events")
    .values({
      run_id: runId,
      step_name: stepName ?? null,
      type,
      attempt: attempt ?? null,
      worker_id: workerId ?? null,
      detail: detail === undefined ? null : JSON.stringify(detail),
    })
    .execute();
}

const planHashes = new WeakMap<WorkflowDefinition, string>();

/**
 * Hashes the parts of a workflow kept in the plan tables, and the `version` its
 * author gave it, so an edit to either creates a new row in workflows.
 * Remembered per definition, since workers ask on every claim.
 */
function planHash(definition: WorkflowDefinition): string {
  let hash = planHashes.get(definition);
  if (!hash) {
    hash = hashPlan(definition);
    planHashes.set(definition, hash);
  }
  return hash;
}

/** The hash behind planHash. */
function hashPlan(definition: WorkflowDefinition): string {
  const links = resolveNeeds(definition.steps);
  const plan = {
    name: definition.name,
    version: definition.version,
    steps: definition.steps.map(({ name, leaseMs, maxAttempts, backoffMs }, i) => ({
      name,
      needs: links[i].needs,
      leaseMs,
      maxAttempts,
      backoffMs,
    })),
  };
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 12);
}

/** Copies workflows into the plan tables. Workflows already saved are left alone. */
async function syncWorkflows(workflows: WorkflowDefinition[]) {
  for (const definition of workflows) {
    await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto("workflows")
        .values({
          name: definition.name,
          version: definition.version,
          plan_hash: planHash(definition),
        })
        .onConflict((oc) => oc.columns(["name", "plan_hash"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!created) return;

      const links = resolveNeeds(definition.steps);
      await trx
        .insertInto("steps")
        .values(
          definition.steps.map((step, position) => ({
            workflow_id: created.id,
            name: step.name,
            position,
            needs: links[position].needs,
            lease_ms: step.leaseMs ?? null,
            max_attempts: step.maxAttempts ?? null,
            backoff_ms: step.backoffMs ?? null,
          })),
        )
        .execute();
    });
  }
}

/**
 * Takes the lock of one concurrency group until the transaction ends. Counting
 * a group's slots and giving them away happens under it, so two transactions
 * can never both see the same free slot. It needs no row to exist. Lock order:
 * schedule, then run, then group, then steps. Call it before admitWaitingRuns.
 */
async function lockGroup({ trx, key }: { trx: Tx; key: string }) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
}

/** How many runs of a group hold a slot: admitted and not finished. Call it with the group locked. */
async function slotsInUse({ trx, key }: { trx: Tx; key: string }): Promise<number> {
  const { count } = await trx
    .selectFrom("workflow_runs")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("concurrency_key", "=", key)
    .where("admitted_at", "is not", null)
    .where("finished_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(count);
}

/**
 * Gives free slots in a group to its waiting runs, oldest first, for as long as
 * there are both. Admitting a run readies its steps that need nothing (or whose
 * needs have succeeded, for a redriven run). It locks the run it admits as it
 * picks it, and skips one that is locked by another transaction: a waiting run
 * is only locked while it is being cancelled, and that transaction may be
 * waiting for the group lock this one holds. Runs this transaction already
 * holds are not skipped. Call it with the group locked.
 */
async function admitWaitingRuns({ trx, key }: { trx: Tx; key: string }) {
  for (;;) {
    const next = await trx
      .selectFrom("workflow_runs")
      .select(["id", "concurrency_limit"])
      .where("concurrency_key", "=", key)
      .where("admitted_at", "is", null)
      .where("finished_at", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .limit(1)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!next) return;
    if ((await slotsInUse({ trx, key })) >= next.concurrency_limit!) return;

    await trx
      .updateTable("workflow_runs")
      // Not now(), for the same reason as in startRun.
      .set({ admitted_at: sql<Date>`clock_timestamp()` })
      .where("id", "=", next.id)
      .execute();
    await emit({ trx, runId: next.id, type: "run_admitted" });
    await readyUnblockedSteps({ trx, runId: next.id });
  }
}

/** Records that a run in a group is waiting, if admitWaitingRuns left it without a slot. */
async function emitWaitingIfNotAdmitted({ trx, runId }: { trx: Tx; runId: string }) {
  const run = await trx
    .selectFrom("workflow_runs")
    .select("admitted_at")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  if (run.admitted_at === null) await emit({ trx, runId, type: "run_waiting" });
}

/**
 * Creates a run and its step runs, with every step that needs nothing ready to
 * claim, and returns the run's id. The workflow must already be saved by syncWorkflows.
 * A run in a group with no free slot is created waiting, with every step pending,
 * until admitWaitingRuns gives it a slot.
 */
async function startRun({
  definition,
  input = {},
  idempotencyKey,
  concurrency,
}: {
  definition: WorkflowDefinition;
  input?: unknown;
  idempotencyKey?: string;
  concurrency?: { key: string; limit: number };
}): Promise<string> {
  return db
    .transaction()
    .execute((trx) => insertRun({ trx, definition, input, idempotencyKey, concurrency }));
}

/**
 * The body of startRun, inside the caller's transaction, so a schedule can start
 * its run in the same transaction that moves it to its next tick. With
 * `schedule`, the run also records which schedule and tick started it. Takes the
 * group's lock before inserting, so the caller may hold a schedule's lock (the
 * outermost) but never a run's or a group's.
 */
async function insertRun({
  trx,
  definition,
  input = {},
  idempotencyKey,
  concurrency,
  schedule,
}: {
  trx: Tx;
  definition: WorkflowDefinition;
  input?: unknown;
  idempotencyKey?: string;
  concurrency?: { key: string; limit: number };
  schedule?: { id: string; name: string; scheduledFor: Date };
}): Promise<string> {
  const workflow = await trx
    .selectFrom("workflows")
    .select("id")
    .where("name", "=", definition.name)
    .where("plan_hash", "=", planHash(definition))
    .executeTakeFirstOrThrow();

  const steps = await trx
    .selectFrom("steps")
    .select(["id", "name", "position", "needs"])
    .where("workflow_id", "=", workflow.id)
    .orderBy("position")
    .execute();

  // The group lock comes before the insert, so the new run is counted and
  // admitted under the same lock as everything else in its group.
  if (concurrency) await lockGroup({ trx, key: concurrency.key });

  const run = await trx
    .insertInto("workflow_runs")
    .values({
      workflow_id: workflow.id,
      workflow_version: definition.version,
      input: JSON.stringify(input),
      idempotency_key: idempotencyKey ?? null,
      concurrency_key: concurrency?.key ?? null,
      concurrency_limit: concurrency?.limit ?? null,
      // Not now(), which is the transaction's start time and can be earlier
      // than the moment the run was actually admitted. A run in a group is
      // admitted below, once it has been counted.
      admitted_at: concurrency ? null : sql<Date>`clock_timestamp()`,
      schedule_id: schedule?.id ?? null,
      scheduled_for: schedule?.scheduledFor ?? null,
    })
    // Handles two identical requests racing: the loser waits, then does nothing.
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .returning("id")
    .executeTakeFirst();

  if (!run) {
    // Only a repeated key can conflict, so idempotencyKey is always set here.
    const existing = await trx
      .selectFrom("workflow_runs")
      .select("id")
      .where("idempotency_key", "=", idempotencyKey!)
      .executeTakeFirstOrThrow();
    return existing.id;
  }

  await emit({
    trx,
    runId: run.id,
    type: "run_queued",
    detail: schedule && { schedule: schedule.name, scheduledFor: schedule.scheduledFor },
  });

  // In a group, every step starts pending: admission readies the first ones.
  const ready = (step: { needs: string[] }) => !concurrency && step.needs.length === 0;
  await trx
    .insertInto("step_runs")
    .values(
      steps.map((step) => ({
        run_id: run.id,
        step_id: step.id,
        name: step.name,
        position: step.position,
        needs: step.needs,
        status: ready(step) ? ("ready" as const) : ("pending" as const),
        ready_at: ready(step) ? sql<Date>`now()` : null,
      })),
    )
    .execute();
  for (const step of steps.filter(ready)) {
    await emit({ trx, runId: run.id, type: "step_ready", stepName: step.name });
  }

  if (concurrency) {
    await admitWaitingRuns({ trx, key: concurrency.key });
    await emitWaitingIfNotAdmitted({ trx, runId: run.id });
  }

  return run.id;
}

/** A timestamp this many milliseconds from now, by the database's clock. */
const fromNow = (ms: number) => sql<Date>`now() + (${ms}::int * interval '1 millisecond')`;

/**
 * Gives a ready step to this worker: marks it running with a lease, starts the
 * run if this is its first step, and gathers what the step needs to run.
 */
async function takeStep({
  trx,
  stepRunId,
  workerId,
  defaults,
}: {
  trx: Tx;
  stepRunId: string;
  workerId: string;
  defaults: StepDefaults;
}): Promise<Claim> {
  // A step added at runtime has no plan row, so it gets the default.
  const plan = await trx
    .selectFrom("step_runs as sr")
    .leftJoin("steps as s", "s.id", "sr.step_id")
    .select("s.lease_ms")
    .where("sr.id", "=", stepRunId)
    .executeTakeFirstOrThrow();
  const leaseMs = plan.lease_ms ?? defaults.leaseMs;

  const step = await trx
    .updateTable("step_runs")
    .set((eb) => ({
      status: "running",
      attempt: eb("attempt", "+", 1),
      worker_id: workerId,
      started_at: sql<Date>`now()`,
      lease_expires_at: fromNow(leaseMs),
    }))
    .where("id", "=", stepRunId)
    .returning(["id", "run_id", "name", "position", "attempt"])
    .executeTakeFirstOrThrow();

  // This is the one place a step's lock comes before its run's, so it must
  // never wait for the run. The only thing that locks a run with claimable
  // steps before it has started is a cancel, which finishes the run itself, so
  // skipping the update then loses nothing. A lock this transaction already
  // holds doesn't count as locked, so a claim made inside completeStep still
  // starts nothing it shouldn't.
  const started = await trx
    .updateTable("workflow_runs")
    .set({ status: "running", started_at: sql<Date>`now()` })
    .where("id", "in", (eb) =>
      eb
        .selectFrom("workflow_runs")
        .select("id")
        .where("id", "=", step.run_id)
        .where("status", "=", "queued")
        .forUpdate()
        .skipLocked(),
    )
    .returning("id")
    .executeTakeFirst();
  if (started) await emit({ trx, runId: step.run_id, type: "run_started" });

  await emit({
    trx,
    runId: step.run_id,
    type: "step_claimed",
    stepName: step.name,
    attempt: step.attempt,
    workerId,
  });

  const run = await trx
    .selectFrom("workflow_runs as r")
    .innerJoin("workflows as w", "w.id", "r.workflow_id")
    .select(["w.name as workflow", "r.input"])
    .where("r.id", "=", step.run_id)
    .executeTakeFirstOrThrow();

  // Only what this step depends on: a step running alongside may or may not
  // have finished, so reading its output would depend on timing.
  const runSteps = await trx
    .selectFrom("step_runs")
    .select(["name", "needs", "output"])
    .where("run_id", "=", step.run_id)
    .execute();
  const ancestorNames = ancestors(runSteps, step.name);
  const ancestorSteps = runSteps.filter((s) => ancestorNames.has(s.name));

  return {
    stepRunId: step.id,
    stepName: step.name,
    position: step.position,
    attempt: step.attempt,
    leaseMs,
    workerId,
    runId: step.run_id,
    workflow: run.workflow,
    input: run.input,
    outputs: Object.fromEntries(ancestorSteps.map((s) => [s.name, s.output])),
  };
}

/**
 * Atomically claims a ready step, or returns null if there is none. `sticky`
 * picks like `fair` here; its difference is in completeStep.
 *
 * SKIP LOCKED gives each competing worker a different row, with no waiting.
 * The row lock only lasts for this transaction, not while the step runs, so a
 * worker dying mid-step leaves it `running`.
 */
async function claimStep({
  workerId,
  workflows,
  order,
  defaults,
}: {
  workerId: string;
  workflows: WorkflowDefinition[];
  order: ClaimOrder;
  defaults: StepDefaults;
}): Promise<Claim | null> {
  if (workflows.length === 0) return null;

  return db.transaction().execute(async (trx) => {
    let query = trx
      .selectFrom("step_runs as sr")
      .innerJoin("workflow_runs as r", "r.id", "sr.run_id")
      .innerJoin("workflows as w", "w.id", "r.workflow_id")
      .select("sr.id")
      .where("sr.status", "=", "ready")
      // A step waiting to retry is ready, but not until its backoff is over.
      .where("sr.ready_at", "<=", sql<Date>`now()`)
      // The hash includes the name, so it picks out one version of one
      // workflow: a worker never runs a step it has different code for.
      .where("w.plan_hash", "in", workflows.map(planHash));
    if (order === "oldest-run-first") query = query.orderBy("r.created_at").orderBy("r.id");
    const next = await query
      .orderBy("sr.ready_at")
      .orderBy("sr.id")
      .limit(1)
      // Locks only the step, so workers on the same run don't block each other.
      .forUpdate("sr")
      .skipLocked()
      .executeTakeFirst();
    if (!next) return null;

    return takeStep({ trx, stepRunId: next.id, workerId, defaults });
  });
}

// Finishes a step only if this worker's attempt still owns it.
async function finishOwnedStep({
  trx,
  claim,
  status,
  output,
  error,
  failureReason,
}: {
  trx: Tx;
  claim: Claim;
  status: "succeeded" | "failed";
  output?: unknown;
  error?: string;
  failureReason?: FailureReason;
}): Promise<boolean> {
  const result = await trx
    .updateTable("step_runs")
    .set({
      status,
      output: output === undefined ? null : JSON.stringify(output),
      error: error ?? null,
      failure_reason: failureReason ?? null,
      finished_at: sql<Date>`now()`,
      lease_expires_at: null,
    })
    .where("id", "=", claim.stepRunId)
    .where("status", "=", "running")
    .where("worker_id", "=", claim.workerId)
    .where("attempt", "=", claim.attempt)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/**
 * Locks a run's row until the transaction ends. Every change to a started run's
 * steps takes this lock first, so two steps of one run finishing at the same
 * moment take turns, and the second one sees the first as finished. The order
 * everywhere is the run's lock, then its group's lock (lockGroup), then its
 * steps' locks (a schedule's row lock, taken by fireDueSchedules, comes before
 * all of them), so two transactions can never end up waiting on each other.
 * Cancelling a run takes it too, in its own query (see cancelRun).
 */
async function lockRun({ trx, runId }: { trx: Tx; runId: string }) {
  await trx
    .selectFrom("workflow_runs")
    .select("id")
    .where("id", "=", runId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

/**
 * Readies every pending step of a run whose needs have all succeeded, and
 * returns them in order. With `finishedStep`, only steps that need that step,
 * since nothing else can have changed. Call it with the run locked.
 */
async function readyUnblockedSteps({
  trx,
  runId,
  finishedStep,
}: {
  trx: Tx;
  runId: string;
  finishedStep?: string;
}) {
  let query = trx
    .updateTable("step_runs as sr")
    .set({ status: "ready", ready_at: sql<Date>`now()` })
    .where("sr.run_id", "=", runId)
    .where("sr.status", "=", "pending")
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("step_runs as d")
            .select("d.id")
            .whereRef("d.run_id", "=", "sr.run_id")
            .where(sql<boolean>`d.name = ANY(sr.needs)`)
            .where("d.status", "!=", "succeeded"),
        ),
      ),
    );
  if (finishedStep) query = query.where(sql<boolean>`${finishedStep} = ANY(sr.needs)`);
  const ready = await query.returning(["sr.id", "sr.name", "sr.position"]).execute();
  for (const step of ready.sort((a, b) => a.position - b.position)) {
    await emit({ trx, runId, type: "step_ready", stepName: step.name });
  }
  return ready;
}

/**
 * Records a step's success, then readies every step whose needs have now all
 * succeeded, or finishes the run if every step has. With claimNext, the first
 * newly ready step goes straight to the same worker.
 */
async function completeStep({
  claim,
  output,
  claimNext,
  defaults,
}: {
  claim: Claim;
  output: unknown;
  claimNext: boolean;
  defaults: StepDefaults;
}): Promise<{ completed: boolean; next: Claim | null }> {
  return db.transaction().execute(async (trx) => {
    await lockRun({ trx, runId: claim.runId });
    if (!(await finishOwnedStep({ trx, claim, status: "succeeded", output }))) {
      return { completed: false, next: null };
    }
    await emit({
      trx,
      runId: claim.runId,
      type: "step_succeeded",
      stepName: claim.stepName,
      attempt: claim.attempt,
      workerId: claim.workerId,
    });

    // The join. Without the run lock, two steps finishing together would each
    // see the other as still running, and neither would ready a step that needs both.
    const ready = await readyUnblockedSteps({
      trx,
      runId: claim.runId,
      finishedStep: claim.stepName,
    });
    if (ready.length > 0) {
      if (!claimNext) return { completed: true, next: null };
      // Still inside this transaction, so no other worker ever sees it ready.
      // Any others stay ready for other workers.
      return {
        completed: true,
        next: await takeStep({
          trx,
          stepRunId: ready[0].id,
          workerId: claim.workerId,
          defaults,
        }),
      };
    }

    await finishRunIfDone({ trx, runId: claim.runId });
    return { completed: true, next: null };
  });
}

/**
 * A step's own retry settings from its plan, or the defaults, and how many of
 * its attempts came before the run was last redriven, which don't count.
 */
async function retryPolicy({
  trx,
  stepRunId,
  defaults,
}: {
  trx: Tx;
  stepRunId: string;
  defaults: StepDefaults;
}) {
  const plan = await trx
    .selectFrom("step_runs as sr")
    .leftJoin("steps as s", "s.id", "sr.step_id")
    .select(["s.max_attempts", "s.backoff_ms", "sr.prior_attempts"])
    .where("sr.id", "=", stepRunId)
    .executeTakeFirstOrThrow();
  return {
    maxAttempts: plan.max_attempts ?? defaults.maxAttempts,
    backoffMs: plan.backoff_ms ?? defaults.backoffMs,
    priorAttempts: plan.prior_attempts,
  };
}

/**
 * Finishes a run once nothing in it can move: no step is pending, ready or
 * running. It succeeded if every step did; otherwise it failed, with the
 * reason of the step that failed first. A run in a group gives its slot to the
 * oldest waiting run. Call it with the run locked.
 */
async function finishRunIfDone({ trx, runId }: { trx: Tx; runId: string }) {
  const steps = await trx
    .selectFrom("step_runs")
    .select(["name", "status", "error", "failure_reason", "finished_at", "position"])
    .where("run_id", "=", runId)
    .execute();
  if (steps.some((s) => ["pending", "ready", "running"].includes(s.status))) return;

  const failed = steps
    .filter((s) => s.status === "failed")
    .sort((a, b) => a.finished_at!.getTime() - b.finished_at!.getTime() || a.position - b.position);
  const firstFailed = failed[0];
  const finished = await trx
    .updateTable("workflow_runs")
    .set(
      firstFailed
        ? {
            status: "failed",
            failure_reason: firstFailed.failure_reason,
            finished_at: sql<Date>`now()`,
          }
        : { status: "succeeded", finished_at: sql<Date>`now()` },
    )
    .where("id", "=", runId)
    .returning("concurrency_key")
    .executeTakeFirstOrThrow();
  if (firstFailed) {
    await emit({
      trx,
      runId,
      type: "run_failed",
      detail: {
        step: firstFailed.name,
        error: firstFailed.error,
        failureReason: firstFailed.failure_reason,
      },
    });
  } else {
    await emit({ trx, runId, type: "run_succeeded" });
  }

  await giveUpSlot({ trx, key: finished.concurrency_key });
}

/**
 * Lets the waiting runs of a group take the slot a run has just given up, if it
 * was in a group (a null key does nothing). Call it with the run locked.
 */
async function giveUpSlot({ trx, key }: { trx: Tx; key: string | null }) {
  if (key === null) return;
  await lockGroup({ trx, key });
  await admitWaitingRuns({ trx, key });
}

/**
 * Follows up a step that has just been marked failed for good. Steps that
 * depend on it can never run, so they're skipped; every other step carries on,
 * so a run does all the work it still can. The run finishes once nothing is
 * left to move. Call it with the run locked.
 */
async function recordFinalFailure({
  trx,
  runId,
  stepName,
  attempt,
  workerId,
  error,
  failureReason,
}: {
  trx: Tx;
  runId: string;
  stepName: string;
  attempt: number;
  workerId?: string;
  error: string;
  failureReason: FailureReason;
}) {
  await emit({
    trx,
    runId,
    type: "step_failed",
    stepName,
    attempt,
    workerId,
    detail: { error, failureReason },
  });

  const runSteps = await trx
    .selectFrom("step_runs")
    .select(["name", "needs"])
    .where("run_id", "=", runId)
    .execute();
  const blocked = [...dependents(runSteps, stepName)];
  if (blocked.length > 0) {
    // Only pending ones: a step can't start before everything it depends on succeeds.
    const skipped = await trx
      .updateTable("step_runs")
      .set({ status: "skipped", finished_at: sql<Date>`now()` })
      .where("run_id", "=", runId)
      .where("name", "in", blocked)
      .where("status", "=", "pending")
      .returning(["name", "position"])
      .execute();
    skipped.sort((a, b) => a.position - b.position);
    for (const step of skipped)
      await emit({ trx, runId, type: "step_skipped", stepName: step.name });
  }

  await finishRunIfDone({ trx, runId });
}

/**
 * Records a step's failure. A failure that isn't final, with attempts left,
 * makes the step ready again once its backoff has passed; anything else fails
 * the step for good (see recordFinalFailure). Returns recorded: false if this
 * worker no longer owns the step.
 */
async function failStep({
  claim,
  error,
  final,
  defaults,
}: {
  claim: Claim;
  error: string;
  final: FinalFailure | null;
  defaults: StepDefaults;
}): Promise<{ recorded: boolean; retryInMs: number | null; failureReason: FailureReason | null }> {
  return db.transaction().execute(async (trx) => {
    await lockRun({ trx, runId: claim.runId });
    const policy = await retryPolicy({ trx, stepRunId: claim.stepRunId, defaults });

    const attemptsUsed = claim.attempt - policy.priorAttempts;
    if (!final && attemptsUsed < policy.maxAttempts) {
      const retryInMs = retryDelayMs({
        attempt: attemptsUsed,
        backoffMs: policy.backoffMs,
        maxBackoffMs: defaults.maxBackoffMs,
      });
      // The same ownership check as finishOwnedStep, since the step stays open.
      const result = await trx
        .updateTable("step_runs")
        .set({
          status: "ready",
          ready_at: fromNow(retryInMs),
          error,
          worker_id: null,
          started_at: null,
          lease_expires_at: null,
        })
        .where("id", "=", claim.stepRunId)
        .where("status", "=", "running")
        .where("worker_id", "=", claim.workerId)
        .where("attempt", "=", claim.attempt)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) {
        return { recorded: false, retryInMs: null, failureReason: null };
      }
      await emit({
        trx,
        runId: claim.runId,
        type: "step_retry_scheduled",
        stepName: claim.stepName,
        attempt: claim.attempt,
        workerId: claim.workerId,
        detail: { error, retryInMs },
      });
      return { recorded: true, retryInMs, failureReason: null };
    }

    const failureReason = final ?? "attempts_exhausted";
    if (!(await finishOwnedStep({ trx, claim, status: "failed", error, failureReason }))) {
      return { recorded: false, retryInMs: null, failureReason: null };
    }
    await recordFinalFailure({
      trx,
      runId: claim.runId,
      stepName: claim.stepName,
      attempt: claim.attempt,
      workerId: claim.workerId,
      error,
      failureReason,
    });
    return { recorded: true, retryInMs: null, failureReason };
  });
}

/** Renews a claim's lease, but only if this worker's attempt still owns the step. */
async function extendLease(claim: Claim): Promise<boolean> {
  const result = await db
    .updateTable("step_runs")
    .set({ lease_expires_at: fromNow(claim.leaseMs) })
    .where("id", "=", claim.stepRunId)
    .where("status", "=", "running")
    .where("worker_id", "=", claim.workerId)
    .where("attempt", "=", claim.attempt)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/**
 * Makes running steps whose lease has expired ready again, or fails their run if
 * they have no attempts left. The attempt stays as it is, so the next claim bumps
 * it and the old worker's late result no longer matches.
 *
 * Expired steps are found without locking, then handled one by one, each in its
 * own transaction that locks the run before the step, like every other change.
 * Several orchestrators can sweep at once: whoever comes second finds the step
 * no longer expired and leaves it.
 */
async function sweepExpiredLeases({ defaults }: { defaults: StepDefaults }): Promise<number> {
  const expired = await db
    .selectFrom("step_runs")
    .select(["id", "run_id"])
    .where("status", "=", "running")
    .where("lease_expires_at", "<", sql<Date>`now()`)
    .limit(100)
    .execute();

  let swept = 0;
  for (const candidate of expired) {
    const handled = await db.transaction().execute(async (trx) => {
      await lockRun({ trx, runId: candidate.run_id });
      // Checked again under the lock: its worker may have finished or renewed
      // it since, or another orchestrator may have swept it.
      const step = await trx
        .selectFrom("step_runs")
        .select(["id", "run_id", "name", "attempt", "worker_id"])
        .where("id", "=", candidate.id)
        .where("status", "=", "running")
        .where("lease_expires_at", "<", sql<Date>`now()`)
        .forUpdate()
        .executeTakeFirst();
      if (!step) return false;

      const workerId = step.worker_id ?? undefined;
      await emit({
        trx,
        runId: step.run_id,
        type: "step_lease_expired",
        stepName: step.name,
        attempt: step.attempt,
        workerId,
      });

      const { maxAttempts, priorAttempts } = await retryPolicy({
        trx,
        stepRunId: step.id,
        defaults,
      });
      const attemptsUsed = step.attempt - priorAttempts;
      if (attemptsUsed >= maxAttempts) {
        // A step that keeps losing its worker (crashing it, say) stops here.
        const error = `Lost its worker on attempt ${attemptsUsed} of ${maxAttempts}`;
        await trx
          .updateTable("step_runs")
          .set({
            status: "failed",
            error,
            failure_reason: "lost_worker",
            finished_at: sql<Date>`now()`,
            lease_expires_at: null,
          })
          .where("id", "=", step.id)
          .execute();
        await recordFinalFailure({
          trx,
          runId: step.run_id,
          stepName: step.name,
          attempt: step.attempt,
          workerId,
          error,
          failureReason: "lost_worker",
        });
        return true;
      }

      await trx
        .updateTable("step_runs")
        .set({
          status: "ready",
          ready_at: sql<Date>`now()`,
          worker_id: null,
          started_at: null,
          lease_expires_at: null,
        })
        .where("id", "=", step.id)
        .execute();
      await emit({ trx, runId: step.run_id, type: "step_ready", stepName: step.name });
      return true;
    });
    if (handled) swept++;
  }
  return swept;
}

/**
 * Resumes a run that was cancelled or that failed for a redrivable reason:
 * every step that didn't succeed (a cancelled run's failed and skipped steps
 * too) goes back to pending with fresh attempts, and those whose needs have
 * succeeded become ready. Succeeded steps keep their outputs and never run
 * again. A run in a group takes a slot again like a new run: if the group is
 * full, it waits, and its steps become ready only when it is admitted. Returns
 * false, changing nothing, if the run can't be redriven.
 */
async function redriveRun({ runId }: { runId: string }): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await lockRun({ trx, runId });
    const run = await trx
      .selectFrom("workflow_runs")
      .select(["status", "failure_reason", "concurrency_key"])
      .where("id", "=", runId)
      .executeTakeFirst();
    if (!run || !canRedrive(run.status, run.failure_reason)) return false;

    await trx
      .updateTable("step_runs")
      .set((eb) => ({
        status: "pending",
        prior_attempts: eb.ref("attempt"),
        error: null,
        failure_reason: null,
        worker_id: null,
        ready_at: null,
        started_at: null,
        finished_at: null,
        lease_expires_at: null,
      }))
      .where("run_id", "=", runId)
      .where("status", "!=", "succeeded")
      .execute();
    if (run.concurrency_key === null) {
      await trx
        .updateTable("workflow_runs")
        .set({ status: "running", failure_reason: null, finished_at: null })
        .where("id", "=", runId)
        .execute();
      await emit({ trx, runId, type: "run_redriven" });
      await readyUnblockedSteps({ trx, runId });
      return true;
    }

    // It gave its slot back when it failed, so it needs one again. Admission
    // readies its steps, and a worker's first claim makes it running.
    await trx
      .updateTable("workflow_runs")
      .set({ status: "queued", failure_reason: null, finished_at: null, admitted_at: null })
      .where("id", "=", runId)
      .execute();
    await emit({ trx, runId, type: "run_redriven" });
    await lockGroup({ trx, key: run.concurrency_key });
    await admitWaitingRuns({ trx, key: run.concurrency_key });
    await emitWaitingIfNotAdmitted({ trx, runId });
    return true;
  });
}

/**
 * Stops a run that hasn't finished: steps that haven't started are skipped, a
 * running step fails with reason `cancelled`, and the run becomes `cancelled`
 * (with no failure reason) and gives its slot to the oldest waiting run.
 * Returns false, changing nothing, if the run doesn't exist or has finished.
 *
 * It takes the run's lock first, like everything that changes a run's steps,
 * so it can't interleave with a step finishing, failing or being swept. The
 * one thing that takes a step's lock before its run's is a run's first claim
 * (see takeStep), which never waits for the run, so the two can't deadlock.
 */
async function cancelRun({ runId }: { runId: string }): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    // Lock and read in one query: lockRun throws when the row is missing.
    // FOR NO KEY UPDATE, not FOR UPDATE. It still conflicts with lockRun's FOR
    // UPDATE, so every other change to the run's steps waits for the cancel, and
    // with the SKIP LOCKED in takeStep. But it doesn't conflict with the FOR KEY
    // SHARE that inserting an event takes on the run through its foreign key,
    // which is what a claim does while it holds a step.
    const run = await trx
      .selectFrom("workflow_runs")
      .select(["finished_at", "concurrency_key"])
      .where("id", "=", runId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!run || run.finished_at !== null) return false;

    // One statement, deciding per row, never "skip the unstarted" and then "fail
    // the running": a step could go from ready to running between the two and
    // be left running in a finished run. When this has to wait for a step that
    // a claim holds, Postgres re-reads the row once the claim commits and
    // applies both the WHERE and the CASEs to the new version, so a step
    // claimed in the meantime is correctly failed. In a SET, `status` on the
    // right is the row's old value, which the CASEs rely on.
    const steps = await trx
      .updateTable("step_runs")
      .set({
        status: sql`CASE WHEN status = 'running' THEN 'failed'::step_run_status ELSE 'skipped'::step_run_status END`,
        error: sql`CASE WHEN status = 'running' THEN 'Run cancelled' ELSE error END`,
        failure_reason: sql`CASE WHEN status = 'running' THEN 'cancelled'::failure_reason ELSE NULL END`,
        finished_at: sql<Date>`now()`,
        lease_expires_at: null,
      })
      .where("run_id", "=", runId)
      .where("status", "in", ["pending", "ready", "running"])
      .returning(["name", "position", "status", "attempt", "worker_id"])
      .execute();
    steps.sort((a, b) => a.position - b.position);
    for (const step of steps) {
      if (step.status === "failed") {
        await emit({
          trx,
          runId,
          type: "step_failed",
          stepName: step.name,
          attempt: step.attempt,
          workerId: step.worker_id ?? undefined,
          detail: { error: "Run cancelled", failureReason: "cancelled" },
        });
      } else {
        await emit({ trx, runId, type: "step_skipped", stepName: step.name });
      }
    }

    await trx
      .updateTable("workflow_runs")
      .set({ status: "cancelled", finished_at: sql<Date>`now()` })
      .where("id", "=", runId)
      .execute();
    await emit({ trx, runId, type: "run_cancelled" });

    await giveUpSlot({ trx, key: run.concurrency_key });
    return true;
  });
}

/**
 * The database's clock right now, not as of the transaction's start, which can
 * be earlier than a row lock was won. Schedules are timed by it, never by the
 * process's.
 */
async function databaseNow(trx: Tx): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx);
  return rows[0].now;
}

/** Throws unless `at` is after `now`: a moment that has passed can't be scheduled. */
function assertAfterNow({ at, now }: { at: Date; now: Date }) {
  if (at <= now)
    throw new InvalidScheduleError(`A schedule's \`at\` (${at.toISOString()}) isn't in the future`);
}

/**
 * Saves a schedule, or returns false if the workflow already has one with this
 * name. One transaction, so the database's now, which the first tick or the
 * check of `at` is counted from, is the same one the row is created at.
 */
async function createSchedule({
  workflow,
  name,
  cron,
  at,
  input,
}: {
  workflow: string;
  name: string;
  cron?: string;
  at?: Date;
  input: unknown;
}): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const now = await databaseNow(trx);
    if (at !== undefined) assertAfterNow({ at, now });
    const created = await trx
      .insertInto("schedules")
      .values({
        workflow,
        name,
        cron: cron ?? null,
        input: JSON.stringify(input),
        next_fire_at: cron !== undefined ? nextFireAfter({ cron, after: now }) : at!,
      })
      .onConflict((oc) => oc.columns(["workflow", "name"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    return created !== undefined;
  });
}

/**
 * Changes a schedule, or returns false if it doesn't exist or is a one-time
 * schedule that has fired. Locks the schedule's row first, so an edit and a
 * firing take turns, and the cron it compares with is the one that is saved.
 * Lock order: only the schedule's row, nothing else.
 */
async function updateSchedule({
  workflow,
  name,
  cron,
  at,
  input,
}: {
  workflow: string;
  name: string;
  cron?: string;
  at?: Date;
  input?: unknown;
}): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("schedules")
      .select(["id", "cron", "next_fire_at"])
      .where("workflow", "=", workflow)
      .where("name", "=", name)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return false;

    if (cron !== undefined && row.cron === null) {
      throw new InvalidScheduleError(
        `Schedule ${workflow}/${name} fires once, so it has no cron to change`,
      );
    }
    if (at !== undefined && row.cron !== null) {
      throw new InvalidScheduleError(
        `Schedule ${workflow}/${name} repeats, so it has no \`at\` to change`,
      );
    }
    if (at !== undefined && row.next_fire_at === null) return false;

    const now = await databaseNow(trx);
    if (at !== undefined) assertAfterNow({ at, now });
    const changes = {
      ...(cron !== undefined && cron !== row.cron
        ? { cron, next_fire_at: nextFireAfter({ cron, after: now }) }
        : {}),
      ...(at !== undefined ? { next_fire_at: at } : {}),
      ...(input !== undefined ? { input: JSON.stringify(input) } : {}),
    };
    // Giving the cron it already has changes nothing, and an UPDATE needs something to set.
    if (Object.keys(changes).length > 0) {
      await trx.updateTable("schedules").set(changes).where("id", "=", row.id).execute();
    }
    return true;
  });
}

/** Removes a schedule, or returns false if it doesn't exist. Only the schedule's row changes: its runs stay and keep its id as their schedule_id. */
async function deleteSchedule({
  workflow,
  name,
}: {
  workflow: string;
  name: string;
}): Promise<boolean> {
  const deleted = await db
    .deleteFrom("schedules")
    .where("workflow", "=", workflow)
    .where("name", "=", name)
    .returning("id")
    .executeTakeFirst();
  return deleted !== undefined;
}

/**
 * Pauses or resumes a schedule, or returns false if it doesn't exist or is
 * already in that state. Pausing is one statement. Resuming locks the row, then
 * clears paused_at and, for a repeating schedule, moves next_fire_at to the
 * first tick after now, so the ticks skipped while paused start no runs. A
 * one-time schedule keeps its moment.
 */
async function setSchedulePaused({
  workflow,
  name,
  paused,
}: {
  workflow: string;
  name: string;
  paused: boolean;
}): Promise<boolean> {
  if (paused) {
    const updated = await db
      .updateTable("schedules")
      .set({ paused_at: sql<Date>`now()` })
      .where("workflow", "=", workflow)
      .where("name", "=", name)
      .where("paused_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    return updated !== undefined;
  }
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("schedules")
      .select(["id", "cron", "paused_at"])
      .where("workflow", "=", workflow)
      .where("name", "=", name)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.paused_at === null) return false;

    await trx
      .updateTable("schedules")
      .set({
        paused_at: null,
        ...(row.cron !== null
          ? { next_fire_at: nextFireAfter({ cron: row.cron, after: await databaseNow(trx) }) }
          : {}),
      })
      .where("id", "=", row.id)
      .execute();
    return true;
  });
}

/** The most due schedules one fireDueSchedules call handles, so one call can't run forever. */
const MAX_FIRES_PER_CALL = 100;

/**
 * The oldest run this schedule started that hasn't finished, if there is one.
 * A finished run that was redriven is unfinished again.
 */
function unfinishedRunOf({ trx, scheduleId }: { trx: Tx; scheduleId: string }) {
  return trx
    .selectFrom("workflow_runs")
    .select("id")
    .where("schedule_id", "=", scheduleId)
    .where("finished_at", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .limit(1)
    .executeTakeFirst();
}

/**
 * Starts a run for each due, unpaused schedule of the given workflows and moves
 * it to its next tick, and returns how many runs it started. A schedule of any
 * other workflow is not looked at.
 *
 * Each firing is one transaction: lock the due schedule's row, start the run,
 * and move next_fire_at forward (to null for a one-time schedule, which has no
 * more ticks). They commit together, so a schedule is never left due after its
 * run started, or advanced without its run. `scheduledRunFor` supplies the run's code
 * and concurrency group from the row's input.
 *
 * A tick that finds a run the schedule started still unfinished starts no run.
 * It writes a schedule_tick_skipped event on that run, which is the one thing
 * the skipped tick has to do with, and the schedule still moves forward. The
 * check takes no lock on the run: the schedule's row lock means no other firing
 * can be starting one, and a run that finishes a moment later only means a
 * tick was skipped that needn't have been.
 *
 * The lock is FOR UPDATE SKIP LOCKED, like claimStep's: an orchestrator that
 * finds the row locked by another doesn't wait for it, it moves on, and by the
 * time it looks again the row is no longer due. So a tick starts one run however
 * many orchestrators run, and an edit holding the row makes a firing skip it
 * rather than wait. If that were ever wrong, the second insert would break the
 * unique (schedule_id, scheduled_for) on workflow_runs and fail loudly; nothing
 * here catches it.
 *
 * A schedule far behind (no orchestrator was running) fires once, for its old
 * tick, and resumes from the first tick after now: no backlog of runs. "Now" is
 * the database's, read in the same statement that finds the due row.
 *
 * Lock order: the schedule's row lock is the outermost, before the group lock
 * and the run's and steps' locks that starting a run takes. The skipped tick's
 * event takes only the key-share lock every event takes on its run. Nothing
 * holding a run or group lock ever asks for a schedule row.
 */
async function fireDueSchedules({
  workflows,
  scheduledRunFor,
}: {
  workflows: WorkflowDefinition[];
  scheduledRunFor: (schedule: { workflow: string; name: string; input: unknown }) => ScheduledRun;
}): Promise<number> {
  if (workflows.length === 0) return 0;
  const names = workflows.map((workflow) => workflow.name);

  let started = 0;
  for (let i = 0; i < MAX_FIRES_PER_CALL; i++) {
    const fired = await db.transaction().execute(async (trx) => {
      const due = await trx
        .selectFrom("schedules")
        .select([
          "id",
          "workflow",
          "name",
          "cron",
          "input",
          "next_fire_at",
          sql<Date>`now()`.as("now"),
        ])
        .where("workflow", "in", names)
        .where("paused_at", "is", null)
        .where("next_fire_at", "<=", sql<Date>`now()`)
        .orderBy("next_fire_at")
        .orderBy("id")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!due) return null;

      // Due rows have a next_fire_at: the query above compares it.
      const scheduledFor = due.next_fire_at!;
      const unfinished = await unfinishedRunOf({ trx, scheduleId: due.id });
      if (unfinished) {
        await emit({
          trx,
          runId: unfinished.id,
          type: "schedule_tick_skipped",
          detail: { schedule: due.name, scheduledFor },
        });
      } else {
        const { definition, concurrency } = scheduledRunFor({
          workflow: due.workflow,
          name: due.name,
          input: due.input,
        });
        await insertRun({
          trx,
          definition,
          input: due.input,
          concurrency,
          schedule: { id: due.id, name: due.name, scheduledFor },
        });
      }

      const after = new Date(Math.max(scheduledFor.getTime(), due.now.getTime()));
      await trx
        .updateTable("schedules")
        .set({
          next_fire_at: due.cron === null ? null : nextFireAfter({ cron: due.cron, after }),
          ...(unfinished ? {} : { last_fired_at: due.now }),
        })
        .where("id", "=", due.id)
        .execute();
      return unfinished ? "skipped" : "started";
    });
    if (!fired) break;
    if (fired === "started") started++;
  }
  return started;
}

export function createPostgresStore(): WorkflowStore {
  return {
    syncWorkflows,
    startRun,
    claimStep,
    completeStep,
    extendLease,
    sweepExpiredLeases,
    failStep,
    redriveRun,
    cancelRun,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    setSchedulePaused,
    fireDueSchedules,
    close: () => db.destroy(),
  };
}
