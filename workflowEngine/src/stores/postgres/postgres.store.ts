import { createHash } from "node:crypto";
import { sql } from "kysely";
import { db, type Tx } from "./db/index.ts";
import {
  ancestors,
  canRedrive,
  dependents,
  resolveNeeds,
  retryDelayMs,
} from "../../workflowEngine.utils.ts";
import type { FailureReason } from "../../workflowEngine.constants.ts";
import type {
  Claim,
  ClaimOrder,
  EventFields,
  FinalFailure,
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

const planVersions = new WeakMap<WorkflowDefinition, string>();

/**
 * Hashes the parts of a workflow kept in the plan tables, so any edit creates a
 * new version. Remembered per definition, since workers ask on every claim.
 */
function planVersion(definition: WorkflowDefinition): string {
  let version = planVersions.get(definition);
  if (!version) {
    version = hashPlan(definition);
    planVersions.set(definition, version);
  }
  return version;
}

/** The hash behind planVersion. */
function hashPlan(definition: WorkflowDefinition): string {
  const links = resolveNeeds(definition.steps);
  const plan = {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    steps: definition.steps.map(
      ({ name, title, description, leaseMs, maxAttempts, backoffMs }, i) => ({
        name,
        title,
        description,
        needs: links[i].needs,
        leaseMs,
        maxAttempts,
        backoffMs,
      }),
    ),
  };
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 12);
}

/** Copies workflows into the plan tables. Unchanged workflows are left alone. */
async function syncWorkflows(workflows: WorkflowDefinition[]) {
  for (const definition of workflows) {
    await db.transaction().execute(async (trx) => {
      const version = planVersion(definition);
      const created = await trx
        .insertInto("workflows")
        .values({
          name: definition.name,
          version,
          title: definition.title,
          description: definition.description,
        })
        .onConflict((oc) => oc.columns(["name", "version"]).doNothing())
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
            title: step.title,
            description: step.description,
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
 * Creates a run and its step runs, with every step that needs nothing ready to
 * claim, and returns the run's id. The workflow must already be saved by syncWorkflows.
 */
async function startRun({
  definition,
  input = {},
  idempotencyKey,
}: {
  definition: WorkflowDefinition;
  input?: unknown;
  idempotencyKey?: string;
}): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const workflow = await trx
      .selectFrom("workflows")
      .select("id")
      .where("name", "=", definition.name)
      .where("version", "=", planVersion(definition))
      .executeTakeFirstOrThrow();

    const steps = await trx
      .selectFrom("steps")
      .select(["id", "name", "position", "needs"])
      .where("workflow_id", "=", workflow.id)
      .orderBy("position")
      .execute();

    const run = await trx
      .insertInto("workflow_runs")
      .values({
        workflow_id: workflow.id,
        input: JSON.stringify(input),
        idempotency_key: idempotencyKey ?? null,
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

    await emit({ trx, runId: run.id, type: "run_queued" });

    await trx
      .insertInto("step_runs")
      .values(
        steps.map((step) => ({
          run_id: run.id,
          step_id: step.id,
          name: step.name,
          position: step.position,
          needs: step.needs,
          status: step.needs.length === 0 ? ("ready" as const) : ("pending" as const),
          ready_at: step.needs.length === 0 ? sql<Date>`now()` : null,
        })),
      )
      .execute();
    for (const step of steps.filter((s) => s.needs.length === 0)) {
      await emit({ trx, runId: run.id, type: "step_ready", stepName: step.name });
    }

    return run.id;
  });
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

  // The one place a step's lock comes before its run's: only a run's first
  // claim changes the run here, and nothing else locks a run before it starts.
  const started = await trx
    .updateTable("workflow_runs")
    .set({ status: "running", started_at: sql<Date>`now()` })
    .where("id", "=", step.run_id)
    .where("status", "=", "queued")
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
      // The version is a hash that includes the name, so it picks out one
      // workflow version: a worker never runs a step it has different code for.
      .where("w.version", "in", workflows.map(planVersion));
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
 * moment take turns, and the second one sees the first as finished. Taking the
 * run's lock before any of its steps' locks, everywhere, also means two
 * transactions can never end up waiting on each other.
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
 * reason of the step that failed first. Call it with the run locked.
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
  if (failed.length === 0) {
    await trx
      .updateTable("workflow_runs")
      .set({ status: "succeeded", finished_at: sql<Date>`now()` })
      .where("id", "=", runId)
      .execute();
    await emit({ trx, runId, type: "run_succeeded" });
    return;
  }

  const firstFailed = failed[0];
  await trx
    .updateTable("workflow_runs")
    .set({
      status: "failed",
      failure_reason: firstFailed.failure_reason,
      finished_at: sql<Date>`now()`,
    })
    .where("id", "=", runId)
    .execute();
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
 * Resumes a run that failed for a redrivable reason: every step that didn't
 * succeed goes back to pending with fresh attempts, and those whose needs have
 * succeeded become ready. Succeeded steps keep their outputs and never run
 * again. Returns false, changing nothing, if the run can't be redriven.
 */
async function redriveRun({ runId }: { runId: string }): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await lockRun({ trx, runId });
    const run = await trx
      .selectFrom("workflow_runs")
      .select(["status", "failure_reason"])
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
    await trx
      .updateTable("workflow_runs")
      .set({ status: "running", failure_reason: null, finished_at: null })
      .where("id", "=", runId)
      .execute();
    await emit({ trx, runId, type: "run_redriven" });
    await readyUnblockedSteps({ trx, runId });
    return true;
  });
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
    close: () => db.destroy(),
  };
}
