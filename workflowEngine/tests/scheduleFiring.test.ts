import { startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import {
  createWorkflowEngine,
  defineWorkflow,
  type ScheduleToFire,
  type WorkflowSchedule,
} from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { nextFireAfter } from "../src/workflowEngine.utils.ts";
import { scheduled, scheduledExclusive } from "./fixtures/workflows.ts";

// Real workers run the fixture workflows' steps. Nothing here waits for a real
// minute: a schedule is made due by moving its next_fire_at into the past.
before(() => startWorkers(2));
after(() => stopWorkers());

// A schedule left due, or about to be, could be fired by a later test.
beforeEach(async () => {
  await db
    .updateTable("schedules")
    .set({ next_fire_at: sql<Date>`now() + interval '1 hour'` })
    .where("workflow", "in", [scheduled.name, scheduledExclusive.name])
    .execute();
});

/** Defines a one-step workflow with the given schedules, for the tests that only sync. */
const define = (name: string, schedules: WorkflowSchedule[]) =>
  defineWorkflow({ name, schedules, steps: [{ name: "only", run: async () => null }] });

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
  return row.next_fire_at;
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

/** What a caller passes to fireDueSchedules for a workflow's "tick" schedule, as the engine builds it. */
function toFire(definition: typeof scheduled | typeof scheduledExclusive): ScheduleToFire {
  const input = definition.schedules![0].input ?? {};
  const key = definition.concurrency?.key(input);
  return {
    definition,
    name: "tick",
    input,
    concurrency:
      definition.concurrency && key != null
        ? { key, limit: definition.concurrency.limit }
        : undefined,
  };
}

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

test("sync saves a schedule, due at its next minute", async () => {
  await store.syncWorkflows([define("schedfire-save", [{ name: "tick", cron: "* * * * *" }])]);

  const row = await scheduleRow("schedfire-save");
  assert.equal(row.cron, "* * * * *");
  assert.equal(row.last_fired_at, null);
  const now = await databaseNow();
  assert.ok(row.next_fire_at > now, "the next tick should be in the future");
  assert.ok(row.next_fire_at.getTime() - now.getTime() <= 60_000, "and at most a minute away");
  assert.equal(row.next_fire_at.getUTCSeconds(), 0);
});

test("syncing again leaves an unchanged schedule alone", async () => {
  const definition = define("schedfire-keep", [{ name: "tick", cron: "0 4 * * *" }]);
  await store.syncWorkflows([definition]);
  const pending = await makeDue("schedfire-keep", 5);

  await store.syncWorkflows([definition]);

  assert.deepEqual((await scheduleRow("schedfire-keep")).next_fire_at, pending);
});

test("a schedule whose cron changed is rescheduled", async () => {
  await store.syncWorkflows([define("schedfire-change", [{ name: "tick", cron: "0 4 * * *" }])]);
  const before = await databaseNow();

  await store.syncWorkflows([define("schedfire-change", [{ name: "tick", cron: "0 5 * * *" }])]);

  const row = await scheduleRow("schedfire-change");
  const after = await databaseNow();
  assert.equal(row.cron, "0 5 * * *");
  const expected = [before, after].map((at) => nextFireAfter({ cron: "0 5 * * *", after: at }));
  assert.ok(
    expected.some((at) => at.getTime() === row.next_fire_at.getTime()),
    "the next tick should follow the new expression",
  );
});

test("a schedule no longer declared is removed, and other workflows' schedules are untouched", async () => {
  const cron = "0 3 * * *";
  await store.syncWorkflows([
    define("schedfire-drop", [{ name: "tick", cron }]),
    define("schedfire-other", [{ name: "tick", cron }]),
  ]);
  const otherBefore = await scheduleRow("schedfire-other");

  await store.syncWorkflows([define("schedfire-drop", [])]);

  const dropped = await db
    .selectFrom("schedules")
    .select("id")
    .where("workflow", "=", "schedfire-drop")
    .execute();
  assert.equal(dropped.length, 0);
  assert.deepEqual(await scheduleRow("schedfire-other"), otherBefore);
});

test("a due schedule starts one run", async () => {
  const dueAt = await makeDue(scheduled.name);

  assert.equal(await store.fireDueSchedules({ schedules: [toFire(scheduled)] }), 1);

  const runs = await scheduledRuns(scheduled.name);
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.deepEqual(run.input, { from: "schedule" });
  assert.notEqual(run.schedule_id, null);
  assert.deepEqual(run.scheduled_for, dueAt);

  const row = await scheduleRow(scheduled.name);
  assert.ok(row.next_fire_at > (await databaseNow()), "it should wait for its next tick");
  assert.notEqual(row.last_fired_at, null);

  const [queued] = await eventsOf(run.id, "run_queued");
  assert.deepEqual(queued.detail, { schedule: "tick", scheduledFor: dueAt.toISOString() });

  await waitForFinish([run.id]);
  assert.equal((await scheduledRuns(scheduled.name))[0].status, "succeeded");
});

test("a schedule that isn't due starts nothing", async () => {
  const before = (await scheduledRuns(scheduled.name)).length;

  assert.equal(await store.fireDueSchedules({ schedules: [toFire(scheduled)] }), 0);

  assert.equal((await scheduledRuns(scheduled.name)).length, before);
});

test("a schedule fires once however many orchestrators try", async () => {
  const schedules = [toFire(scheduled)];
  for (let round = 1; round <= 20; round++) {
    const dueAt = await makeDue(scheduled.name, round + 10);
    const before = (await scheduledRuns(scheduled.name)).length;

    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.fireDueSchedules({ schedules })),
    );

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
  const schedules = [toFire(scheduled)];
  const before = (await scheduledRuns(scheduled.name)).length;

  assert.equal(await store.fireDueSchedules({ schedules }), 1);
  assert.equal(await store.fireDueSchedules({ schedules }), 0);

  const runs = await scheduledRuns(scheduled.name);
  assert.equal(runs.length, before + 1);
  assert.deepEqual(
    runs.find((r) => r.scheduled_for?.getTime() === oldTick.getTime())?.scheduled_for,
    oldTick,
  );
  assert.ok((await scheduleRow(scheduled.name)).next_fire_at > (await databaseNow()));
  await waitForFinish(runs.map((r) => r.id));
});

test("a scheduled run waits for its concurrency group like any other", async () => {
  const { concurrency } = toFire(scheduledExclusive);
  const holder = await store.startRun({
    definition: scheduledExclusive,
    input: { ms: 1500 },
    concurrency,
  });
  await makeDue(scheduledExclusive.name);

  assert.equal(await store.fireDueSchedules({ schedules: [toFire(scheduledExclusive)] }), 1);

  const [run] = await scheduledRuns(scheduledExclusive.name);
  assert.equal(run.admitted_at, null);
  assert.equal((await eventsOf(run.id, "run_waiting")).length, 1);

  await waitForFinish([holder, run.id]);
  const [finished] = await scheduledRuns(scheduledExclusive.name);
  assert.equal(finished.status, "succeeded");
  assert.notEqual(finished.admitted_at, null);
});

test("a schedule that was never saved is an error", async () => {
  const ghost = define("schedfire-ghost", [{ name: "tick", cron: "* * * * *" }]);
  await makeDue(scheduled.name);
  const before = (await scheduledRuns(scheduled.name)).length;

  await assert.rejects(
    store.fireDueSchedules({
      schedules: [toFire(scheduled), { definition: ghost, name: "tick", input: {} }],
    }),
    /schedfire-ghost\/tick/,
  );

  assert.equal((await scheduledRuns(scheduled.name)).length, before);
});

test("the orchestrator starts a due schedule's run", async () => {
  const engine = createWorkflowEngine({
    workflows: [scheduled],
    store: { ...store, close: async () => {} },
    settings: { sweepIntervalMs: 50 },
  });
  const orchestrator = engine.runOrchestrator();
  try {
    await sleep(100);
    const before = (await scheduledRuns(scheduled.name)).length;
    await makeDue(scheduled.name, 40);

    const run = await waitFor(async () => (await scheduledRuns(scheduled.name)).at(before), 3000);
    await waitForFinish([run.id]);
    assert.equal((await scheduledRuns(scheduled.name)).at(before)?.status, "succeeded");
  } finally {
    await engine.close();
    await orchestrator;
  }
});

test("two runs can't be recorded for one tick", async () => {
  const dueAt = await makeDue(scheduled.name, 50);
  await store.fireDueSchedules({ schedules: [toFire(scheduled)] });
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

test("schedules don't change a workflow's version", async () => {
  const steps = [{ name: "only", run: async () => null }];
  await store.syncWorkflows([
    defineWorkflow({
      name: "schedfire-version",
      schedules: [{ name: "tick", cron: "* * * * *" }],
      steps,
    }),
  ]);
  await store.syncWorkflows([defineWorkflow({ name: "schedfire-version", steps })]);

  const versions = await db
    .selectFrom("workflows")
    .select("id")
    .where("name", "=", "schedfire-version")
    .execute();
  assert.equal(versions.length, 1);
});
