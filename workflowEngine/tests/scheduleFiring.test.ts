import { startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import { createWorkflowEngine, type ScheduledRun, type WorkflowDefinition } from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { scheduled, scheduledExclusive } from "./fixtures/workflows.ts";

// Real workers run the fixture workflows' steps. Nothing here waits for a real
// minute: a schedule is made due by moving its next_fire_at into the past.
const WORKFLOWS = [scheduled, scheduledExclusive];

/** An engine over the shared store, for creating schedules and running an orchestrator. */
const engine = createWorkflowEngine({
  workflows: WORKFLOWS,
  store: { ...store, close: async () => {} },
  settings: { sweepIntervalMs: 50 },
});

before(async () => {
  await startWorkers(2);
  await engine.schedules.create({
    workflow: scheduled.name,
    name: "tick",
    cron: "* * * * *",
    input: { from: "schedule" },
  });
  await engine.schedules.create({
    workflow: scheduledExclusive.name,
    name: "tick",
    cron: "* * * * *",
    input: { ms: 50 },
  });
});
after(() => stopWorkers());

// A schedule left due, or about to be, could be fired by a later test.
beforeEach(async () => {
  await db
    .updateTable("schedules")
    .set({ next_fire_at: sql<Date>`now() + interval '1 hour'` })
    .where("workflow", "in", [scheduled.name, scheduledExclusive.name])
    .execute();
});

/** The database's clock, which is what schedules are checked against. */
async function databaseNow(): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(db);
  return rows[0].now;
}

/** A saved schedule's row. */
const scheduleRow = (workflow: string, name = "tick") =>
  db
    .selectFrom("schedules")
    .selectAll()
    .where("workflow", "=", workflow)
    .where("name", "=", name)
    .executeTakeFirstOrThrow();

/**
 * Makes a schedule due by moving its next tick `minutesAgo` whole minutes into
 * the past, and returns that tick. A tick can only start one run, so tests that
 * fire the same schedule use ticks far enough apart not to collide.
 */
async function makeDue(workflow: string, minutesAgo = 1): Promise<Date> {
  const row = await db
    .updateTable("schedules")
    .set({
      next_fire_at: sql<Date>`date_trunc('minute', now()) - ${minutesAgo}::int * interval '1 minute'`,
    })
    .where("workflow", "=", workflow)
    .where("name", "=", "tick")
    .returning("next_fire_at")
    .executeTakeFirstOrThrow();
  return row.next_fire_at!;
}

/** Every run a workflow's "tick" schedule has started, oldest tick first. */
async function scheduledRuns(workflow: string) {
  return db
    .selectFrom("workflow_runs as r")
    .innerJoin("schedules as s", "s.id", "r.schedule_id")
    .select(["r.id", "r.input", "r.status", "r.admitted_at", "r.schedule_id", "r.scheduled_for"])
    .where("s.workflow", "=", workflow)
    .where("s.name", "=", "tick")
    .orderBy("r.scheduled_for")
    .execute();
}

/** A run's events of one type. */
const eventsOf = (runId: string, type: string) =>
  db
    .selectFrom("events")
    .select(["detail"])
    .where("run_id", "=", runId)
    .where("type", "=", type)
    .execute();

/** What the engine's `prepare` does: the workflow's code, and its concurrency group for the schedule's input. */
function prepare({ workflow, input }: { workflow: string; input: unknown }): ScheduledRun {
  const definition = WORKFLOWS.find((w) => w.name === workflow)!;
  const key = definition.concurrency?.key(input as never);
  return {
    definition,
    concurrency:
      definition.concurrency && key != null
        ? { key, limit: definition.concurrency.limit }
        : undefined,
  };
}

/** Fires what is due among the given workflows' schedules. */
const fire = (workflows: WorkflowDefinition[] = WORKFLOWS) =>
  store.fireDueSchedules({ workflows, prepare });

/** Waits until check returns something truthy, and returns it. */
async function waitFor<T>(check: () => Promise<T>, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error("Timed out waiting");
}

test("a due schedule starts one run", async () => {
  const dueAt = await makeDue(scheduled.name);

  assert.equal(await fire([scheduled]), 1);

  const runs = await scheduledRuns(scheduled.name);
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.deepEqual(run.input, { from: "schedule" });
  assert.notEqual(run.schedule_id, null);
  assert.deepEqual(run.scheduled_for, dueAt);

  const row = await scheduleRow(scheduled.name);
  assert.ok(row.next_fire_at! > (await databaseNow()), "it should wait for its next tick");
  assert.notEqual(row.last_fired_at, null);

  const [queued] = await eventsOf(run.id, "run_queued");
  assert.deepEqual(queued.detail, { schedule: "tick", scheduledFor: dueAt.toISOString() });

  await waitForFinish([run.id]);
  assert.equal((await scheduledRuns(scheduled.name))[0].status, "succeeded");
});

test("a schedule that isn't due starts nothing", async () => {
  const before = (await scheduledRuns(scheduled.name)).length;

  assert.equal(await fire([scheduled]), 0);

  assert.equal((await scheduledRuns(scheduled.name)).length, before);
});

test("a schedule fires once however many orchestrators try", async () => {
  for (let round = 1; round <= 20; round++) {
    const dueAt = await makeDue(scheduled.name, round + 10);
    const before = (await scheduledRuns(scheduled.name)).length;

    const results = await Promise.all(Array.from({ length: 20 }, () => fire([scheduled])));

    assert.equal(
      results.reduce((sum, started) => sum + started, 0),
      1,
      `round ${round}: one run should start`,
    );
    const runs = await scheduledRuns(scheduled.name);
    assert.equal(runs.length, before + 1);
    assert.equal(runs.filter((r) => r.scheduled_for?.getTime() === dueAt.getTime()).length, 1);
  }
  await waitForFinish((await scheduledRuns(scheduled.name)).map((r) => r.id));
});

test("missed ticks start one run", async () => {
  const oldTick = await makeDue(scheduled.name, 180);
  const before = (await scheduledRuns(scheduled.name)).length;

  assert.equal(await fire([scheduled]), 1);
  assert.equal(await fire([scheduled]), 0);

  const runs = await scheduledRuns(scheduled.name);
  assert.equal(runs.length, before + 1);
  assert.deepEqual(
    runs.find((r) => r.scheduled_for?.getTime() === oldTick.getTime())?.scheduled_for,
    oldTick,
  );
  assert.ok((await scheduleRow(scheduled.name)).next_fire_at! > (await databaseNow()));
  await waitForFinish(runs.map((r) => r.id));
});

test("a scheduled run waits for its concurrency group like any other", async () => {
  const { concurrency } = prepare({ workflow: scheduledExclusive.name, input: { ms: 1500 } });
  const holder = await store.startRun({
    definition: scheduledExclusive,
    input: { ms: 1500 },
    concurrency,
  });
  await makeDue(scheduledExclusive.name);

  assert.equal(await fire([scheduledExclusive]), 1);

  const [run] = await scheduledRuns(scheduledExclusive.name);
  assert.equal(run.admitted_at, null);
  assert.equal((await eventsOf(run.id, "run_waiting")).length, 1);

  await waitForFinish([holder, run.id]);
  const [finished] = await scheduledRuns(scheduledExclusive.name);
  assert.equal(finished.status, "succeeded");
  assert.notEqual(finished.admitted_at, null);
});

test("a schedule of a workflow the orchestrator doesn't have is left alone", async () => {
  const dueAt = await makeDue(scheduledExclusive.name);
  const before = await scheduleRow(scheduledExclusive.name);
  const runsBefore = (await scheduledRuns(scheduledExclusive.name)).length;
  const prepared: string[] = [];

  assert.equal(
    await store.fireDueSchedules({
      workflows: [scheduled],
      prepare: (schedule) => {
        prepared.push(schedule.workflow);
        return prepare(schedule);
      },
    }),
    0,
  );

  assert.deepEqual(prepared, []);
  assert.equal((await scheduledRuns(scheduledExclusive.name)).length, runsBefore);
  assert.deepEqual((await scheduleRow(scheduledExclusive.name)).next_fire_at, dueAt);
  assert.deepEqual(
    (await scheduleRow(scheduledExclusive.name)).last_fired_at,
    before.last_fired_at,
  );
});

test("the orchestrator starts a due schedule's run", async () => {
  const orchestratorEngine = createWorkflowEngine({
    workflows: [scheduled],
    store: { ...store, close: async () => {} },
    settings: { sweepIntervalMs: 50 },
  });
  const orchestrator = orchestratorEngine.runOrchestrator();
  try {
    await sleep(100);
    const before = (await scheduledRuns(scheduled.name)).length;
    await makeDue(scheduled.name, 40);

    const run = await waitFor(async () => (await scheduledRuns(scheduled.name)).at(before), 3000);
    await waitForFinish([run.id]);
    assert.equal((await scheduledRuns(scheduled.name)).at(before)?.status, "succeeded");
  } finally {
    await orchestratorEngine.close();
    await orchestrator;
  }
});

test("two runs can't be recorded for one tick", async () => {
  const dueAt = await makeDue(scheduled.name, 50);
  await fire([scheduled]);
  const [run] = (await scheduledRuns(scheduled.name)).filter(
    (r) => r.scheduled_for?.getTime() === dueAt.getTime(),
  );
  const { workflow_id } = await db
    .selectFrom("workflow_runs")
    .select("workflow_id")
    .where("id", "=", run.id)
    .executeTakeFirstOrThrow();

  await assert.rejects(
    db
      .insertInto("workflow_runs")
      .values({ workflow_id, schedule_id: run.schedule_id, scheduled_for: dueAt })
      .execute(),
    (err: { code?: string }) => err.code === "23505",
  );
  await waitForFinish([run.id]);
});
