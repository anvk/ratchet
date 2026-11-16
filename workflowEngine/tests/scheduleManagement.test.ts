import { startWorkers, stopWorkers, store, waitForFinish, withoutDeadlocks } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import { createWorkflowEngine, UnknownWorkflowError } from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { nextFireAfter } from "../src/workflowEngine.utils.ts";
import { scheduled, scheduledExclusive } from "./fixtures/workflows.ts";

// Real workers run the fixture workflows' steps. Nothing here waits for a real
// minute: a schedule is made due by moving its next_fire_at into the past.
const WORKFLOW = scheduled.name;
const WORKFLOWS = [scheduled, scheduledExclusive];

/** An engine over the shared store, which every schedule is created and changed through. */
function newEngine() {
  return createWorkflowEngine({
    workflows: WORKFLOWS,
    store: { ...store, close: async () => {} },
    settings: { sweepIntervalMs: 50 },
  });
}
const engine = newEngine();

before(() => startWorkers(2));
after(() => stopWorkers());

// Every test starts with no schedules, so one test's schedules never fire in another's.
beforeEach(async () => {
  await db.deleteFrom("schedules").execute();
});

/** The database's clock, which is what schedules are checked against. */
async function databaseNow(): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(db);
  return rows[0].now;
}

/** A saved schedule's row. */
const scheduleRow = (name: string, workflow = WORKFLOW) =>
  db
    .selectFrom("schedules")
    .selectAll()
    .where("workflow", "=", workflow)
    .where("name", "=", name)
    .executeTakeFirstOrThrow();

/** How many schedules are saved, across every workflow. */
async function scheduleCount() {
  const rows = await db.selectFrom("schedules").select("id").execute();
  return rows.length;
}

/**
 * Moves a schedule's next moment `minutesAgo` whole minutes into the past, which
 * makes it due, and returns that moment.
 */
async function makeDue(name: string, minutesAgo = 1): Promise<Date> {
  const row = await db
    .updateTable("schedules")
    .set({
      next_fire_at: sql<Date>`date_trunc('minute', now()) - ${minutesAgo}::int * interval '1 minute'`,
    })
    .where("workflow", "=", WORKFLOW)
    .where("name", "=", name)
    .returning("next_fire_at")
    .executeTakeFirstOrThrow();
  return row.next_fire_at!;
}

/** Fires what is due among the schedules of the `scheduled` workflow, the way an orchestrator does. */
const fire = () =>
  store.fireDueSchedules({
    workflows: [scheduled],
    prepare: ({ workflow }) => ({ definition: WORKFLOWS.find((w) => w.name === workflow)! }),
  });

/** The runs a schedule started and that still point at it, oldest moment first. */
const runsOf = (name: string) =>
  db
    .selectFrom("workflow_runs as r")
    .innerJoin("schedules as s", "s.id", "r.schedule_id")
    .select(["r.id", "r.input", "r.scheduled_for"])
    .where("s.workflow", "=", WORKFLOW)
    .where("s.name", "=", name)
    .orderBy("r.scheduled_for")
    .execute();

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

/** A moment an hour from now, by the process's clock; the tests only need it to be well ahead. */
const inAnHour = () => new Date(Date.now() + 3_600_000);

test("create saves a schedule due at its next minute, and it fires like any other", async () => {
  assert.equal(
    await engine.schedules.create({
      workflow: WORKFLOW,
      name: "mg-create",
      cron: "* * * * *",
      input: { from: "created" },
    }),
    true,
  );

  const row = await scheduleRow("mg-create");
  assert.equal(row.cron, "* * * * *");
  assert.deepEqual(row.input, { from: "created" });
  assert.equal(row.paused_at, null);
  assert.equal(row.last_fired_at, null);
  const now = await databaseNow();
  assert.ok(row.next_fire_at! > now, "the next tick should be in the future");
  assert.ok(row.next_fire_at!.getTime() - now.getTime() <= 60_000, "and at most a minute away");
  assert.equal(row.next_fire_at!.getUTCSeconds(), 0);

  const dueAt = await makeDue("mg-create");
  assert.equal(await fire(), 1);
  const [run] = await runsOf("mg-create");
  assert.deepEqual(run.input, { from: "created" });
  assert.deepEqual(run.scheduled_for, dueAt);
  await waitForFinish([run.id]);
});

test("create gives a schedule with no input an empty one", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-empty", cron: "* * * * *" });

  assert.deepEqual((await scheduleRow("mg-empty")).input, {});
});

test("create returns false for a name the workflow already has, changing nothing", async () => {
  await engine.schedules.create({
    workflow: WORKFLOW,
    name: "mg-taken",
    cron: "0 4 * * *",
    input: { first: true },
  });
  const before = await scheduleRow("mg-taken");

  assert.equal(
    await engine.schedules.create({
      workflow: WORKFLOW,
      name: "mg-taken",
      cron: "0 5 * * *",
      input: { first: false },
    }),
    false,
  );

  assert.deepEqual(await scheduleRow("mg-taken"), before);
});

test("the same name can be used by two workflows", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-shared", cron: "0 4 * * *" });

  assert.equal(
    await engine.schedules.create({
      workflow: scheduledExclusive.name,
      name: "mg-shared",
      cron: "0 4 * * *",
    }),
    true,
  );
});

test("create rejects an unknown workflow, an empty name and a bad or never-firing cron, saving nothing", async () => {
  await assert.rejects(
    engine.schedules.create({ workflow: "no-such-workflow", name: "x", cron: "* * * * *" }),
    UnknownWorkflowError,
  );
  await assert.rejects(
    engine.schedules.create({ workflow: WORKFLOW, name: "", cron: "* * * * *" }),
    /needs a name/,
  );
  await assert.rejects(
    engine.schedules.create({ workflow: WORKFLOW, name: "bad", cron: "61 * * * *" }),
    /minute 61 is out of range/,
  );
  await assert.rejects(
    engine.schedules.create({ workflow: WORKFLOW, name: "never", cron: "0 0 31 2 *" }),
    /never fires/,
  );

  assert.equal(await scheduleCount(), 0);
});

test("update of the cron reschedules from now", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-cron", cron: "0 4 * * *" });
  await makeDue("mg-cron", 30);
  const before = await databaseNow();

  assert.equal(
    await engine.schedules.update({ workflow: WORKFLOW, name: "mg-cron", cron: "0 5 * * *" }),
    true,
  );

  const row = await scheduleRow("mg-cron");
  const after = await databaseNow();
  assert.equal(row.cron, "0 5 * * *");
  const expected = [before, after].map((at) => nextFireAfter({ cron: "0 5 * * *", after: at }));
  assert.ok(
    expected.some((at) => at.getTime() === row.next_fire_at!.getTime()),
    "the next tick should follow the new expression, counted from now",
  );
});

test("update of the input alone keeps the next tick, and the next run starts with the new input", async () => {
  await engine.schedules.create({
    workflow: WORKFLOW,
    name: "mg-input",
    cron: "0 4 * * *",
    input: { from: "old" },
  });
  const dueAt = await makeDue("mg-input", 5);

  assert.equal(
    await engine.schedules.update({
      workflow: WORKFLOW,
      name: "mg-input",
      input: { from: "new" },
    }),
    true,
  );

  const row = await scheduleRow("mg-input");
  assert.equal(row.cron, "0 4 * * *");
  assert.deepEqual(row.next_fire_at, dueAt);
  assert.deepEqual(row.input, { from: "new" });

  assert.equal(await fire(), 1);
  const [run] = await runsOf("mg-input");
  assert.deepEqual(run.input, { from: "new" });
  await waitForFinish([run.id]);
});

test("update with the cron it already has leaves the next tick alone", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-same", cron: "0 4 * * *" });
  const dueAt = await makeDue("mg-same", 5);

  assert.equal(
    await engine.schedules.update({ workflow: WORKFLOW, name: "mg-same", cron: "0 4 * * *" }),
    true,
  );

  assert.deepEqual((await scheduleRow("mg-same")).next_fire_at, dueAt);
});

test("update returns false for a schedule that doesn't exist, and rejects an update that changes nothing", async () => {
  assert.equal(
    await engine.schedules.update({ workflow: WORKFLOW, name: "mg-missing", cron: "0 4 * * *" }),
    false,
  );
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-nochange", cron: "0 4 * * *" });

  await assert.rejects(
    engine.schedules.update({ workflow: WORKFLOW, name: "mg-nochange" }),
    /at least one of/,
  );
});

test("delete removes a schedule, and its past runs remain with its id", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-delete", cron: "* * * * *" });
  const dueAt = await makeDue("mg-delete");
  assert.equal(await fire(), 1);
  const [run] = await runsOf("mg-delete");
  await waitForFinish([run.id]);
  const scheduleId = (
    await db
      .selectFrom("workflow_runs")
      .select("schedule_id")
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow()
  ).schedule_id;
  assert.notEqual(scheduleId, null);

  assert.equal(await engine.schedules.delete({ workflow: WORKFLOW, name: "mg-delete" }), true);

  assert.equal(await scheduleCount(), 0);
  const kept = await db
    .selectFrom("workflow_runs")
    .select(["schedule_id", "scheduled_for"])
    .where("id", "=", run.id)
    .executeTakeFirstOrThrow();
  assert.equal(kept.schedule_id, scheduleId);
  assert.deepEqual(kept.scheduled_for, dueAt);
});

test("delete returns false for a schedule that doesn't exist", async () => {
  assert.equal(await engine.schedules.delete({ workflow: WORKFLOW, name: "mg-missing" }), false);
});

test("a paused schedule that is due doesn't fire, and pausing twice returns false the second time", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-pause", cron: "* * * * *" });
  const dueAt = await makeDue("mg-pause");

  assert.equal(await engine.schedules.pause({ workflow: WORKFLOW, name: "mg-pause" }), true);
  assert.equal(await engine.schedules.pause({ workflow: WORKFLOW, name: "mg-pause" }), false);

  assert.equal(await fire(), 0);
  const row = await scheduleRow("mg-pause");
  assert.notEqual(row.paused_at, null);
  assert.deepEqual(row.next_fire_at, dueAt);
  assert.deepEqual(await runsOf("mg-pause"), []);
});

test("pause returns false for a schedule that doesn't exist", async () => {
  assert.equal(await engine.schedules.pause({ workflow: WORKFLOW, name: "mg-missing" }), false);
});

test("resume puts the next tick after now and starts no run for the skipped ticks", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-resume", cron: "* * * * *" });
  await engine.schedules.pause({ workflow: WORKFLOW, name: "mg-resume" });
  await makeDue("mg-resume", 10);

  assert.equal(await engine.schedules.resume({ workflow: WORKFLOW, name: "mg-resume" }), true);

  const row = await scheduleRow("mg-resume");
  const now = await databaseNow();
  assert.equal(row.paused_at, null);
  assert.ok(row.next_fire_at! > now, "the next tick should be after now");
  assert.ok(row.next_fire_at!.getTime() - now.getTime() <= 60_000);
  assert.equal(await fire(), 0);
  assert.deepEqual(await runsOf("mg-resume"), []);
});

test("resume returns false for a schedule that isn't paused or doesn't exist", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-running", cron: "0 4 * * *" });
  const before = await scheduleRow("mg-running");

  assert.equal(await engine.schedules.resume({ workflow: WORKFLOW, name: "mg-running" }), false);
  assert.equal(await engine.schedules.resume({ workflow: WORKFLOW, name: "mg-missing" }), false);

  assert.deepEqual(await scheduleRow("mg-running"), before);
});

test("schedules survive sync and an orchestrator restart untouched, paused or not", async () => {
  await engine.schedules.create({
    workflow: WORKFLOW,
    name: "mg-live",
    cron: "0 4 * * *",
    input: { n: 1 },
  });
  await engine.schedules.create({
    workflow: WORKFLOW,
    name: "mg-asleep",
    cron: "0 4 * * *",
    input: { n: 2 },
  });
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-once", at: inAnHour() });
  await engine.schedules.pause({ workflow: WORKFLOW, name: "mg-asleep" });
  const before = await db.selectFrom("schedules").selectAll().orderBy("name").execute();

  const restarted = newEngine();
  await restarted.sync();
  const orchestrator = restarted.runOrchestrator();
  await sleep(300);
  await restarted.close();
  await orchestrator;

  assert.deepEqual(await db.selectFrom("schedules").selectAll().orderBy("name").execute(), before);
});

test("create with `at` saves a schedule with no cron, due at that moment", async () => {
  const at = inAnHour();

  assert.equal(
    await engine.schedules.create({
      workflow: WORKFLOW,
      name: "mg-at",
      at,
      input: { from: "once" },
    }),
    true,
  );

  const row = await scheduleRow("mg-at");
  assert.equal(row.cron, null);
  assert.deepEqual(row.next_fire_at, at);
  assert.deepEqual(row.input, { from: "once" });
});

test("a one-time schedule fires once, then has no next tick and never fires again", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-once", at: inAnHour() });
  const dueAt = await makeDue("mg-once");

  assert.equal(await fire(), 1);
  assert.equal(await fire(), 0);

  const row = await scheduleRow("mg-once");
  assert.equal(row.next_fire_at, null);
  assert.equal(row.cron, null);
  assert.notEqual(row.last_fired_at, null);
  const runs = await runsOf("mg-once");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].scheduled_for, dueAt);
  await waitForFinish([runs[0].id]);
});

test("a one-time schedule starts one run however many orchestrators try", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-once-race", at: inAnHour() });
  await makeDue("mg-once-race");

  const results = await Promise.all(Array.from({ length: 20 }, () => fire()));

  assert.equal(
    results.reduce((sum, started) => sum + started, 0),
    1,
  );
  const runs = await runsOf("mg-once-race");
  assert.equal(runs.length, 1);
  await waitForFinish([runs[0].id]);
});

test("create rejects an `at` in the past, and both or neither of cron and at, saving nothing", async () => {
  await assert.rejects(
    engine.schedules.create({
      workflow: WORKFLOW,
      name: "mg-past",
      at: new Date(Date.now() - 60_000),
    }),
    /isn't in the future/,
  );
  await assert.rejects(
    engine.schedules.create({
      workflow: WORKFLOW,
      name: "mg-both",
      cron: "* * * * *",
      at: inAnHour(),
    }),
    /exactly one of/,
  );
  await assert.rejects(
    engine.schedules.create({ workflow: WORKFLOW, name: "mg-neither" }),
    /exactly one of/,
  );

  assert.equal(await scheduleCount(), 0);
});

test("a one-time schedule missed while no orchestrator ran fires once when one returns", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-missed", at: inAnHour() });
  await makeDue("mg-missed", 180);

  const orchestratorEngine = newEngine();
  const orchestrator = orchestratorEngine.runOrchestrator();
  try {
    const run = await waitFor(async () => (await runsOf("mg-missed"))[0]);
    await waitForFinish([run.id]);
    await sleep(200);
    assert.equal((await runsOf("mg-missed")).length, 1);
    assert.equal((await scheduleRow("mg-missed")).next_fire_at, null);
  } finally {
    await orchestratorEngine.close();
    await orchestrator;
  }
});

test("a one-time schedule paused through its moment fires when it is resumed", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-once-paused", at: inAnHour() });
  await engine.schedules.pause({ workflow: WORKFLOW, name: "mg-once-paused" });
  const dueAt = await makeDue("mg-once-paused", 5);
  assert.equal(await fire(), 0);

  assert.equal(await engine.schedules.resume({ workflow: WORKFLOW, name: "mg-once-paused" }), true);

  assert.deepEqual((await scheduleRow("mg-once-paused")).next_fire_at, dueAt);
  assert.equal(await fire(), 1);
  const runs = await runsOf("mg-once-paused");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].scheduled_for, dueAt);
  await waitForFinish([runs[0].id]);
});

test("update moves a one-time schedule's moment before it fires, and returns false after", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-move", at: inAnHour() });
  const later = new Date(Date.now() + 2 * 3_600_000);

  assert.equal(
    await engine.schedules.update({ workflow: WORKFLOW, name: "mg-move", at: later }),
    true,
  );
  assert.deepEqual((await scheduleRow("mg-move")).next_fire_at, later);

  await makeDue("mg-move");
  assert.equal(await fire(), 1);
  assert.equal(
    await engine.schedules.update({ workflow: WORKFLOW, name: "mg-move", at: later }),
    false,
  );
  assert.equal((await scheduleRow("mg-move")).next_fire_at, null);
  await waitForFinish((await runsOf("mg-move")).map((run) => run.id));
});

test("update can't move a one-time schedule's moment into the past", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-move-past", at: inAnHour() });
  const before = await scheduleRow("mg-move-past");

  await assert.rejects(
    engine.schedules.update({
      workflow: WORKFLOW,
      name: "mg-move-past",
      at: new Date(Date.now() - 60_000),
    }),
    /isn't in the future/,
  );

  assert.deepEqual(await scheduleRow("mg-move-past"), before);
});

test("update can't switch a schedule between repeating and firing once", async () => {
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-repeats", cron: "0 4 * * *" });
  await engine.schedules.create({ workflow: WORKFLOW, name: "mg-fires-once", at: inAnHour() });
  const repeating = await scheduleRow("mg-repeats");
  const once = await scheduleRow("mg-fires-once");

  await assert.rejects(
    engine.schedules.update({ workflow: WORKFLOW, name: "mg-repeats", at: inAnHour() }),
    /repeats/,
  );
  await assert.rejects(
    engine.schedules.update({ workflow: WORKFLOW, name: "mg-fires-once", cron: "0 4 * * *" }),
    /fires once/,
  );

  assert.deepEqual(await scheduleRow("mg-repeats"), repeating);
  assert.deepEqual(await scheduleRow("mg-fires-once"), once);
});

test("fires, pauses, resumes, updates and deletes racing on one schedule never deadlock or run a tick twice", async () => {
  await engine.schedules.create({
    workflow: WORKFLOW,
    name: "mg-race",
    cron: "* * * * *",
    input: { round: 0 },
  });
  const ROUNDS = 20;

  await withoutDeadlocks(async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const lastRound = round === ROUNDS;
      // Back to a known state: running, repeating every minute, and due at a tick of its own.
      await db
        .updateTable("schedules")
        .set({
          paused_at: null,
          cron: "* * * * *",
          input: JSON.stringify({ round: 0 }),
          next_fire_at: sql<Date>`date_trunc('minute', now()) - ${round + 10}::int * interval '1 minute'`,
        })
        .where("name", "=", "mg-race")
        .execute();

      const results = await Promise.all([
        ...Array.from({ length: 10 }, () => fire()),
        engine.schedules.pause({ workflow: WORKFLOW, name: "mg-race" }),
        engine.schedules.resume({ workflow: WORKFLOW, name: "mg-race" }),
        engine.schedules.update({
          workflow: WORKFLOW,
          name: "mg-race",
          cron: "*/5 * * * *",
          input: { round },
        }),
        ...(lastRound ? [engine.schedules.delete({ workflow: WORKFLOW, name: "mg-race" })] : []),
      ]);

      const fires = results.slice(0, 10) as number[];
      assert.ok(
        fires.reduce((sum, started) => sum + started, 0) <= 1,
        `round ${round}: a tick should start at most one run`,
      );
      if (!lastRound) {
        const row = await scheduleRow("mg-race");
        assert.ok(["* * * * *", "*/5 * * * *"].includes(row.cron!), `round ${round}: cron`);
        assert.ok(
          row.next_fire_at !== null,
          `round ${round}: a repeating schedule has a next tick`,
        );
        const ticks = (await runsOf("mg-race")).map((run) => run.scheduled_for!.getTime());
        assert.equal(new Set(ticks).size, ticks.length, `round ${round}: no tick started two runs`);
        assert.ok(
          [0, round].includes((row.input as { round: number }).round),
          `round ${round}: input`,
        );
      }
    }
  });

  assert.equal(await scheduleCount(), 0, "the last round deleted it");
  const started = await db
    .selectFrom("workflow_runs")
    .select("id")
    .where("scheduled_for", "is not", null)
    .execute();
  await waitForFinish(started.map((run) => run.id));
});
