import { startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createWorkflowEngine, defineWorkflow } from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { exclusive, paired, pipeline } from "./fixtures/workflows.ts";

// Real workers, which run the fixture workflows. The inline workflows below
// are unknown to them, so nothing claims those runs.
before(() => startWorkers(4));
after(() => stopWorkers());

interface GroupedInput {
  group?: string;
}

/** A one-step workflow that groups runs by input.group, two at a time. */
const grouped = defineWorkflow<GroupedInput>({
  name: "concurrency-grouped",
  version: "1",
  concurrency: { key: (input) => input.group ?? null, limit: 2 },
  steps: [{ name: "only", run: async () => null }],
});

/** The concurrency columns of a run. */
const groupColumns = (runId: string) =>
  db
    .selectFrom("workflow_runs")
    .select(["concurrency_key", "concurrency_limit", "admitted_at"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();

/** Starts a run of the grouped workflow through an engine, the way an application would. */
async function startGrouped(input: GroupedInput) {
  const engine = createWorkflowEngine({
    workflows: [grouped],
    store,
    settings: { timeoutMs: 60_000 },
  });
  await engine.sync();
  return engine.startRun({ workflow: "concurrency-grouped", input });
}

test("defineWorkflow rejects a concurrency limit that isn't a whole, positive number", () => {
  const define = (limit: number) =>
    defineWorkflow({
      name: "concurrency-bad",
      version: "1",
      concurrency: { key: () => "a", limit },
      steps: [{ name: "only", run: async () => null }],
    });
  for (const limit of [0, -1, 1.5]) {
    assert.throws(() => define(limit), /needs a whole, positive concurrency limit/);
  }
  for (const limit of [1, 5]) {
    assert.doesNotThrow(() => define(limit));
  }
});

test("a run records its group's key and limit, and is admitted when it starts", async () => {
  const run = await groupColumns(await startGrouped({ group: "a" }));
  assert.equal(run.concurrency_key, "a");
  assert.equal(run.concurrency_limit, 2);
  assert.notEqual(run.admitted_at, null);
});

test("a run whose key is null belongs to no group", async () => {
  const run = await groupColumns(await startGrouped({}));
  assert.equal(run.concurrency_key, null);
  assert.equal(run.concurrency_limit, null);
  assert.notEqual(run.admitted_at, null);
});

test("a run of a workflow without concurrency belongs to no group", async () => {
  const run = await groupColumns(await store.startRun({ definition: pipeline }));
  assert.equal(run.concurrency_key, null);
  assert.equal(run.concurrency_limit, null);
  assert.notEqual(run.admitted_at, null);
});

test("changing a workflow's concurrency limit does not create a new version", async () => {
  const withLimit = (limit: number) =>
    defineWorkflow({
      name: "concurrency-versioned",
      version: "1",
      concurrency: { key: () => "a", limit },
      steps: [{ name: "only", run: async () => null }],
    });
  await createWorkflowEngine({
    workflows: [withLimit(2)],
    store,
    settings: { timeoutMs: 60_000 },
  }).sync();
  await createWorkflowEngine({
    workflows: [withLimit(3)],
    store,
    settings: { timeoutMs: 60_000 },
  }).sync();
  const versions = await db
    .selectFrom("workflows")
    .select("id")
    .where("name", "=", "concurrency-versioned")
    .execute();
  assert.equal(versions.length, 1);
});

interface GroupRunInput {
  group: string;
  ms?: number;
  decline?: boolean;
  failFirst?: boolean;
}

/** Starts a run of a fixture workflow through an engine, so its concurrency key is computed. */
async function startFixture(workflow: "exclusive" | "paired", input: GroupRunInput) {
  const engine = createWorkflowEngine({
    workflows: [exclusive, paired],
    store,
    settings: { timeoutMs: 60_000 },
  });
  return engine.startRun({ workflow, input });
}

/** A run's row, as the tests check it. */
const runRow = (runId: string) =>
  db
    .selectFrom("workflow_runs")
    .select(["status", "failure_reason", "admitted_at", "finished_at"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();

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

/**
 * The most runs that were ever in progress at once, from when each was admitted
 * until it finished. Instants are sorted; when an end and a start are the same
 * instant, the end counts first.
 */
function mostInProgress(runs: { admitted_at: Date | null; finished_at: Date | null }[]) {
  const instants = runs.flatMap((r) => [
    { at: r.admitted_at!.getTime(), change: 1 },
    { at: r.finished_at!.getTime(), change: -1 },
  ]);
  instants.sort((a, b) => a.at - b.at || a.change - b.change);
  let current = 0;
  let most = 0;
  for (const { change } of instants) {
    current += change;
    most = Math.max(most, current);
  }
  return most;
}

/** The admitted_at and finished_at of runs. */
const timesOf = (runIds: string[]) =>
  db
    .selectFrom("workflow_runs")
    .select(["id", "status", "admitted_at", "finished_at"])
    .where("id", "in", runIds)
    .orderBy("admitted_at")
    .execute();

test("runs of one group never overlap when the limit is 1", async () => {
  const runIds = await Promise.all(
    Array.from({ length: 20 }, () => startFixture("exclusive", { group: "overlap-1" })),
  );
  await waitForFinish(runIds);
  const runs = await timesOf(runIds);
  assert.ok(runs.every((r) => r.status === "succeeded"));
  assert.equal(mostInProgress(runs), 1);
});

test("a limit of 2 lets two runs of a group overlap, and never three", async () => {
  const runIds = await Promise.all(
    Array.from({ length: 20 }, () => startFixture("paired", { group: "overlap-2", ms: 100 })),
  );
  await waitForFinish(runIds);
  const runs = await timesOf(runIds);
  assert.ok(runs.every((r) => r.status === "succeeded"));
  assert.equal(mostInProgress(runs), 2);
});

test("runs of different groups don't wait for each other", async () => {
  const runIds = await Promise.all([
    startFixture("exclusive", { group: "apart-a", ms: 500 }),
    startFixture("exclusive", { group: "apart-b", ms: 500 }),
  ]);
  for (const runId of runIds) {
    assert.notEqual((await runRow(runId)).admitted_at, null);
    assert.ok(!(await eventTypes(runId)).includes("run_waiting"));
  }
  await waitForFinish(runIds);
});

test("a run that has to wait has no ready step until it is admitted", async () => {
  const first = await startFixture("exclusive", { group: "waiting", ms: 1000 });
  const second = await startFixture("exclusive", { group: "waiting", ms: 50 });

  const waiting = await runRow(second);
  assert.equal(waiting.admitted_at, null);
  assert.equal(waiting.status, "queued");
  const steps = await db
    .selectFrom("step_runs")
    .select("status")
    .where("run_id", "=", second)
    .execute();
  assert.ok(steps.length > 0 && steps.every((s) => s.status === "pending"));
  assert.deepEqual(
    (await eventTypes(second)).filter((t) => t === "run_waiting"),
    ["run_waiting"],
  );

  await waitForFinish([first, second]);
  const done = await runRow(second);
  assert.notEqual(done.admitted_at, null);
  assert.equal(done.status, "succeeded");
  assert.deepEqual(
    (await eventTypes(second)).filter((t) => t === "run_admitted"),
    ["run_admitted"],
  );
});

test("waiting runs are admitted oldest first", async () => {
  const runIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    runIds.push(await startFixture("exclusive", { group: "order", ms: 100 }));
  }
  await waitForFinish(runIds);
  const byAdmission = await timesOf(runIds);
  assert.deepEqual(
    byAdmission.map((r) => r.id),
    runIds,
  );
});

test("a run that fails frees its slot", async () => {
  const first = await startFixture("exclusive", { group: "failing", decline: true });
  const second = await startFixture("exclusive", { group: "failing" });
  await waitForFinish([first, second]);
  assert.equal((await runRow(first)).status, "failed");
  assert.equal((await runRow(second)).status, "succeeded");
});

test("a redriven run waits for a slot if its group is full", async () => {
  const a = await startFixture("exclusive", { group: "redrive-full", failFirst: true });
  await waitForFinish([a]);
  const failed = await runRow(a);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure_reason, "attempts_exhausted");

  const b = await startFixture("exclusive", { group: "redrive-full", ms: 1500 });
  assert.equal(await store.redriveRun({ runId: a }), true);

  const waiting = await runRow(a);
  assert.equal(waiting.status, "queued");
  assert.equal(waiting.admitted_at, null);
  const ready = await db
    .selectFrom("step_runs")
    .select("id")
    .where("run_id", "=", a)
    .where("status", "=", "ready")
    .execute();
  assert.equal(ready.length, 0);
  const types = await eventTypes(a);
  assert.ok(types.lastIndexOf("run_waiting") > types.lastIndexOf("run_redriven"));
  assert.ok(types.lastIndexOf("run_redriven") >= 0);

  await waitForFinish([a, b]);
  const [aDone, bDone] = [await runRow(a), await runRow(b)];
  assert.equal(aDone.status, "succeeded");
  assert.equal(bDone.status, "succeeded");
  assert.ok(aDone.admitted_at!.getTime() >= bDone.finished_at!.getTime());
});

test("a redriven run takes a free slot straight away", async () => {
  const a = await startFixture("exclusive", { group: "redrive-free", failFirst: true });
  await waitForFinish([a]);
  assert.equal((await runRow(a)).status, "failed");

  assert.equal(await store.redriveRun({ runId: a }), true);
  assert.notEqual((await runRow(a)).admitted_at, null);

  await waitForFinish([a]);
  assert.equal((await runRow(a)).status, "succeeded");
});
