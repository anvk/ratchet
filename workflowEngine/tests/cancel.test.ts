import { startWorkers, stopWorkers, store, waitForFinish, withoutDeadlocks } from "./harness.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { createWorkflowEngine, defineWorkflow } from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { cancellable, exclusive, pipeline } from "./fixtures/workflows.ts";

// Real workers, which run the fixture workflows. The inline workflow below is
// unknown to them, so nothing claims its runs.
before(() => startWorkers(4));
after(() => stopWorkers());

/** Two steps no worker has code for, so a run of it stays queued. */
const unclaimed = defineWorkflow({
  name: "cancel-unclaimed",
  version: "1",
  steps: [
    { name: "one", run: async () => null },
    { name: "two", run: async () => null },
  ],
});

/** Polls until the check passes, and throws after the deadline. */
async function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A run's row, as the tests check it. */
const runRow = (runId: string) =>
  db
    .selectFrom("workflow_runs")
    .select(["status", "failure_reason", "admitted_at", "finished_at"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();

/** A run's steps, in order. */
const stepRows = (runId: string) =>
  db
    .selectFrom("step_runs")
    .select(["name", "status", "error", "output", "failure_reason"])
    .where("run_id", "=", runId)
    .orderBy("position")
    .execute();

/** The types of a run's events, in order. */
async function eventTypes(runId: string) {
  const events = await db
    .selectFrom("events")
    .select("type")
    .where("run_id", "=", runId)
    .orderBy("id")
    .execute();
  return events.map((e) => e.type);
}

/** Starts a run of the cancellable fixture. */
const startCancellable = (input: { ms?: number; untilSignal?: boolean }) =>
  store.startRun({ definition: cancellable, input });

/** Starts a run of the exclusive fixture through an engine, so its concurrency key is computed. */
const startExclusive = (input: { group: string; ms?: number }) =>
  createWorkflowEngine({ workflows: [exclusive], store, settings: { timeoutMs: 60_000 } }).startRun(
    {
      workflow: "exclusive",
      input,
    },
  );

/** Waits until a run's `work` step is running. */
const waitForWork = (runId: string) =>
  waitUntil(
    async () => (await stepRows(runId)).some((s) => s.name === "work" && s.status === "running"),
    "work to be running",
  );

test("cancelling a run nobody has started skips every step", async () => {
  await createWorkflowEngine({
    workflows: [unclaimed],
    store,
    settings: { timeoutMs: 60_000 },
  }).sync();
  const runId = await store.startRun({ definition: unclaimed });

  assert.equal(await store.cancelRun({ runId }), true);

  const run = await runRow(runId);
  assert.equal(run.status, "cancelled");
  assert.equal(run.failure_reason, null);
  assert.notEqual(run.finished_at, null);
  assert.deepEqual(
    (await stepRows(runId)).map((s) => s.status),
    ["skipped", "skipped"],
  );
  const types = await eventTypes(runId);
  assert.deepEqual(types.slice(-3), ["step_skipped", "step_skipped", "run_cancelled"]);
  assert.ok(!types.includes("step_failed"));
});

test("cancelling a running run fails its running step and skips the rest", async () => {
  const runId = await startCancellable({ ms: 1500 });
  await waitForWork(runId);

  assert.equal(await store.cancelRun({ runId }), true);

  const run = await runRow(runId);
  assert.equal(run.status, "cancelled");
  assert.equal(run.failure_reason, null);
  const [work, after] = await stepRows(runId);
  assert.equal(work.status, "failed");
  assert.equal(work.failure_reason, "cancelled");
  assert.equal(work.error, "Run cancelled");
  assert.equal(after.status, "skipped");
});

test("a cancelled run is not a failed run", async () => {
  const runId = await startCancellable({ ms: 1500 });
  await waitForWork(runId);

  assert.equal(await store.cancelRun({ runId }), true);

  const run = await runRow(runId);
  assert.equal(run.status, "cancelled");
  assert.equal(run.failure_reason, null);
  const [work, after] = await stepRows(runId);
  assert.equal(work.status, "failed");
  assert.equal(work.failure_reason, "cancelled");
  assert.equal(after.status, "skipped");
});

test("a cancelled step's late result is rejected", async () => {
  const runId = await startCancellable({ ms: 800 });
  await waitForWork(runId);
  assert.equal(await store.cancelRun({ runId }), true);

  await sleep(1300);

  const [work] = await stepRows(runId);
  assert.equal(work.status, "failed");
  assert.equal(work.output, null);
  assert.ok(!(await eventTypes(runId)).includes("step_succeeded"));
});

test("a finished run can't be cancelled", async () => {
  const runId = await startCancellable({ ms: 10 });
  await waitForFinish([runId]);
  assert.equal((await runRow(runId)).status, "succeeded");
  const events = await eventTypes(runId);

  assert.equal(await store.cancelRun({ runId }), false);
  assert.equal(await store.cancelRun({ runId: randomUUID() }), false);

  assert.equal((await runRow(runId)).status, "succeeded");
  assert.deepEqual(await eventTypes(runId), events);
});

test("cancelling a run gives its slot to the next", async () => {
  const a = await startExclusive({ group: "cancel-slot", ms: 5000 });
  const b = await startExclusive({ group: "cancel-slot", ms: 50 });
  assert.equal((await runRow(b)).admitted_at, null);

  assert.equal(await store.cancelRun({ runId: a }), true);

  assert.notEqual((await runRow(b)).admitted_at, null);
  await waitForFinish([b]);
  assert.equal((await runRow(b)).status, "succeeded");
});

test("a waiting run can be cancelled", async () => {
  const a = await startExclusive({ group: "cancel-waiting", ms: 1500 });
  const b = await startExclusive({ group: "cancel-waiting", ms: 50 });

  assert.equal(await store.cancelRun({ runId: b }), true);

  const run = await runRow(b);
  assert.equal(run.status, "cancelled");
  assert.equal(run.failure_reason, null);
  assert.equal(run.admitted_at, null);
  assert.ok((await stepRows(b)).every((s) => s.status === "skipped"));

  await waitForFinish([a]);
  assert.equal((await runRow(a)).status, "succeeded");
});

test("a cancelled run can be redriven", async () => {
  const runId = await startCancellable({ ms: 300 });
  await waitForWork(runId);
  assert.equal(await store.cancelRun({ runId }), true);

  assert.equal(await store.redriveRun({ runId }), true);

  await waitUntil(
    async () => (await runRow(runId)).status === "succeeded",
    "the redrive to finish",
  );
});

test("cancelling while workers make their first claims leaves every run finished", async () => {
  await withoutDeadlocks(async () => {
    for (let round = 0; round < 5; round++) {
      const runIds = await Promise.all(
        Array.from({ length: 40 }, () => store.startRun({ definition: pipeline })),
      );
      const cancelled = await Promise.all(runIds.map((runId) => store.cancelRun({ runId })));

      await waitUntil(
        async () => {
          const open = await db
            .selectFrom("workflow_runs")
            .select("id")
            .where("id", "in", runIds)
            .where("finished_at", "is", null)
            .execute();
          return open.length === 0;
        },
        "every run to finish",
        30_000,
      );

      const runs = await db
        .selectFrom("workflow_runs")
        .select(["id", "status", "failure_reason"])
        .where("id", "in", runIds)
        .execute();
      runIds.forEach((runId, i) => {
        const run = runs.find((r) => r.id === runId)!;
        if (cancelled[i]) {
          assert.equal(run.status, "cancelled");
          assert.equal(run.failure_reason, null);
        } else {
          assert.equal(run.status, "succeeded");
        }
      });

      const unfinished = await db
        .selectFrom("step_runs")
        .select("id")
        .where("run_id", "in", runIds)
        .where("status", "in", ["pending", "ready", "running"])
        .execute();
      assert.equal(unfinished.length, 0);
    }
  });
});

test("cancelling a waiting run while its group's slot frees up never deadlocks", async () => {
  await withoutDeadlocks(async () => {
    const pairs: { a: string; b: string; cancelled: boolean }[] = [];
    for (let round = 0; round < 30; round++) {
      const group = `cancel-race-${round}`;
      const a = await startExclusive({ group, ms: 30 + (round % 4) * 10 });
      const b = await startExclusive({ group, ms: 30 });
      await sleep((round * 7) % 81);
      pairs.push({ a, b, cancelled: await store.cancelRun({ runId: b }) });
    }

    const runIds = pairs.flatMap((p) => [p.a, p.b]);
    await waitUntil(
      async () => {
        const open = await db
          .selectFrom("workflow_runs")
          .select("id")
          .where("id", "in", runIds)
          .where("finished_at", "is", null)
          .execute();
        return open.length === 0;
      },
      "every run to finish",
      30_000,
    );

    for (const { a, b, cancelled } of pairs) {
      assert.equal((await runRow(a)).status, "succeeded");
      const run = await runRow(b);
      if (cancelled) {
        assert.equal(run.status, "cancelled");
        assert.equal(run.failure_reason, null);
      } else {
        assert.equal(run.status, "succeeded");
      }
    }
    const unfinished = await db
      .selectFrom("step_runs")
      .select("id")
      .where("run_id", "in", runIds)
      .where("status", "in", ["pending", "ready", "running"])
      .execute();
    assert.equal(unfinished.length, 0);
  });
});
