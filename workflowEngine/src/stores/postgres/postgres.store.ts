import { createHash } from "node:crypto";
import { sql } from "kysely";
import { db, type Tx } from "./db/index.ts";
import type {
  Claim,
  ClaimOrder,
  EventFields,
  WorkflowDefinition,
  WorkflowStore,
} from "../../workflowEngine.types.ts";

// Every state change calls this inside its own transaction, so the history
// can never disagree with the current state.
async function emit({
  trx,
  runId,
  type,
  step,
  attempt,
  workerId,
  detail,
}: { trx: Tx; runId: string; type: string } & EventFields) {
  await trx
    .insertInto("events")
    .values({
      run_id: runId,
      step_name: step ?? null,
      type,
      attempt: attempt ?? null,
      worker_id: workerId ?? null,
      detail: detail === undefined ? null : JSON.stringify(detail),
    })
    .execute();
}

/** Hashes the parts of a workflow kept in the plan tables, so any edit creates a new version. */
function planVersion(definition: WorkflowDefinition): string {
  const plan = {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    steps: definition.steps.map(({ name, title, description }) => ({ name, title, description })),
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

      await trx
        .insertInto("steps")
        .values(
          definition.steps.map((step, position) => ({
            workflow_id: created.id,
            name: step.name,
            title: step.title,
            description: step.description,
            position,
          })),
        )
        .execute();
    });
  }
}

/**
 * Creates a run and its step runs, with the first step ready to claim, and
 * returns the run's id. The workflow must already be saved by syncWorkflows.
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
      .select(["id", "name", "position"])
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
        steps.map((step, i) => ({
          run_id: run.id,
          step_id: step.id,
          name: step.name,
          position: step.position,
          status: i === 0 ? ("ready" as const) : ("pending" as const),
          ready_at: i === 0 ? sql<Date>`now()` : null,
        })),
      )
      .execute();
    await emit({ trx, runId: run.id, type: "step_ready", step: steps[0].name });

    return run.id;
  });
}

/**
 * Gives a ready step to this worker: marks it running, starts the run if this
 * is its first step, and gathers what the step needs to run.
 */
async function takeStep({
  trx,
  stepRunId,
  workerId,
}: {
  trx: Tx;
  stepRunId: string;
  workerId: string;
}): Promise<Claim> {
  const step = await trx
    .updateTable("step_runs")
    .set((eb) => ({
      status: "running",
      attempt: eb("attempt", "+", 1),
      worker_id: workerId,
      started_at: sql<Date>`now()`,
    }))
    .where("id", "=", stepRunId)
    .returning(["id", "run_id", "name", "position", "attempt"])
    .executeTakeFirstOrThrow();

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
    step: step.name,
    attempt: step.attempt,
    workerId,
  });

  const run = await trx
    .selectFrom("workflow_runs as r")
    .innerJoin("workflows as w", "w.id", "r.workflow_id")
    .select(["w.name as workflow", "r.input"])
    .where("r.id", "=", step.run_id)
    .executeTakeFirstOrThrow();

  const earlier = await trx
    .selectFrom("step_runs")
    .select(["name", "output"])
    .where("run_id", "=", step.run_id)
    .where("status", "=", "succeeded")
    .execute();

  return {
    stepRunId: step.id,
    stepName: step.name,
    position: step.position,
    attempt: step.attempt,
    workerId,
    runId: step.run_id,
    workflow: run.workflow,
    input: run.input,
    outputs: Object.fromEntries(earlier.map((s) => [s.name, s.output])),
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
  workflowNames,
  order,
}: {
  workerId: string;
  workflowNames: string[];
  order: ClaimOrder;
}): Promise<Claim | null> {
  if (workflowNames.length === 0) return null;

  return db.transaction().execute(async (trx) => {
    let query = trx
      .selectFrom("step_runs as sr")
      .innerJoin("workflow_runs as r", "r.id", "sr.run_id")
      .innerJoin("workflows as w", "w.id", "r.workflow_id")
      .select("sr.id")
      .where("sr.status", "=", "ready")
      .where("w.name", "in", workflowNames);
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

    return takeStep({ trx, stepRunId: next.id, workerId });
  });
}

// Finishes a step only if this worker's attempt still owns it.
async function finishOwnedStep({
  trx,
  claim,
  status,
  output,
  error,
}: {
  trx: Tx;
  claim: Claim;
  status: "succeeded" | "failed";
  output?: unknown;
  error?: string;
}): Promise<boolean> {
  const result = await trx
    .updateTable("step_runs")
    .set({
      status,
      output: output === undefined ? null : JSON.stringify(output),
      error: error ?? null,
      finished_at: sql<Date>`now()`,
    })
    .where("id", "=", claim.stepRunId)
    .where("status", "=", "running")
    .where("worker_id", "=", claim.workerId)
    .where("attempt", "=", claim.attempt)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/**
 * Records a step's success, then readies the next step or finishes the run.
 * With claimNext, the next step goes straight to the same worker.
 */
async function completeStep({
  claim,
  output,
  claimNext,
}: {
  claim: Claim;
  output: unknown;
  claimNext: boolean;
}): Promise<{ completed: boolean; next: Claim | null }> {
  return db.transaction().execute(async (trx) => {
    if (!(await finishOwnedStep({ trx, claim, status: "succeeded", output }))) {
      return { completed: false, next: null };
    }
    await emit({
      trx,
      runId: claim.runId,
      type: "step_succeeded",
      step: claim.stepName,
      attempt: claim.attempt,
      workerId: claim.workerId,
    });

    const next = await trx
      .updateTable("step_runs")
      .set({ status: "ready", ready_at: sql<Date>`now()` })
      .where("run_id", "=", claim.runId)
      .where("position", "=", claim.position + 1)
      .where("status", "=", "pending")
      .returning(["id", "name"])
      .executeTakeFirst();
    if (next) {
      await emit({ trx, runId: claim.runId, type: "step_ready", step: next.name });
      if (!claimNext) return { completed: true, next: null };
      // Still inside this transaction, so no other worker ever sees it ready.
      return {
        completed: true,
        next: await takeStep({ trx, stepRunId: next.id, workerId: claim.workerId }),
      };
    }

    await trx
      .updateTable("workflow_runs")
      .set({ status: "succeeded", finished_at: sql<Date>`now()` })
      .where("id", "=", claim.runId)
      .execute();
    await emit({ trx, runId: claim.runId, type: "run_succeeded" });
    return { completed: true, next: null };
  });
}

/**
 * Records a step's failure, skips the remaining steps and fails the run.
 * Returns false if this worker no longer owns the step.
 */
async function failStep(claim: Claim, error: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    if (!(await finishOwnedStep({ trx, claim, status: "failed", error }))) return false;
    await emit({
      trx,
      runId: claim.runId,
      type: "step_failed",
      step: claim.stepName,
      attempt: claim.attempt,
      workerId: claim.workerId,
      detail: { error },
    });

    const skipped = await trx
      .updateTable("step_runs")
      .set({ status: "skipped", finished_at: sql<Date>`now()` })
      .where("run_id", "=", claim.runId)
      .where("status", "=", "pending")
      .returning(["name", "position"])
      .execute();
    skipped.sort((a, b) => a.position - b.position);
    for (const step of skipped)
      await emit({ trx, runId: claim.runId, type: "step_skipped", step: step.name });

    await trx
      .updateTable("workflow_runs")
      .set({ status: "failed", finished_at: sql<Date>`now()` })
      .where("id", "=", claim.runId)
      .execute();
    await emit({
      trx,
      runId: claim.runId,
      type: "run_failed",
      detail: { step: claim.stepName, error },
    });
    return true;
  });
}

/**
 * The WorkflowStore backed by Postgres. Reads DATABASE_URL when imported, and
 * every store in a process shares one connection pool, so close() closes it for all.
 */
export function createPostgresStore(): WorkflowStore {
  return {
    syncWorkflows,
    startRun,
    claimStep,
    completeStep,
    failStep,
    close: () => db.destroy(),
  };
}
