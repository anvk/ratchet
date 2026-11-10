import { startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createWorkflowEngine, defineWorkflow } from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { pipeline } from "./fixtures/workflows.ts";

before(() => startWorkers(6));
after(() => stopWorkers());

/** The name and status of each step in a run, in order. */
const stepStatuses = (runId: string) =>
  db
    .selectFrom("step_runs")
    .select(["name", "status"])
    .where("run_id", "=", runId)
    .orderBy("position")
    .execute();

test("competing workers never claim the same step", async () => {
  const runIds = await Promise.all(
    Array.from({ length: 40 }, () => store.startRun({ definition: pipeline })),
  );
  await waitForFinish(runIds);

  const runs = await db
    .selectFrom("workflow_runs")
    .select("status")
    .where("id", "in", runIds)
    .execute();
  assert.equal(runs.length, 40);
  assert.ok(runs.every((run) => run.status === "succeeded"));

  const claims = await db
    .selectFrom("events")
    .select(["run_id", "step_name", "worker_id"])
    .where("run_id", "in", runIds)
    .where("type", "=", "step_claimed")
    .execute();
  assert.equal(claims.length, 40 * 3, "each step should be claimed exactly once");
  assert.equal(new Set(claims.map((c) => `${c.run_id}:${c.step_name}`)).size, 40 * 3);

  // Otherwise this test could pass with no real competition.
  assert.ok(new Set(claims.map((c) => c.worker_id)).size > 1, "expected several workers");
});

test("later steps receive the outputs of earlier steps", async () => {
  const runId = await store.startRun({ definition: pipeline });
  await waitForFinish([runId]);

  const last = await db
    .selectFrom("step_runs")
    .select("output")
    .where("run_id", "=", runId)
    .where("name", "=", "third")
    .executeTakeFirstOrThrow();
  assert.deepEqual(last.output, { total: 3, idempotencyKey: `${runId}:third` });
});

test("a failed step fails the run and skips the steps after it", async () => {
  const runId = await store.startRun({ definition: pipeline, input: { failAt: "second" } });
  await waitForFinish([runId]);

  const run = await db
    .selectFrom("workflow_runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.equal(run.status, "failed");

  assert.deepEqual(await stepStatuses(runId), [
    { name: "first", status: "succeeded" },
    { name: "second", status: "failed" },
    { name: "third", status: "skipped" },
  ]);
});

test("the event history matches the final state", async () => {
  const runId = await store.startRun({ definition: pipeline });
  await waitForFinish([runId]);

  const events = await db
    .selectFrom("events")
    .select("type")
    .where("run_id", "=", runId)
    .where("step_name", "is", null)
    .orderBy("id")
    .execute();
  assert.deepEqual(
    events.map((e) => e.type),
    ["run_queued", "run_started", "run_succeeded"],
  );
});

test("a repeated idempotency key starts only one run", async () => {
  const start = () => store.startRun({ definition: pipeline, idempotencyKey: "same-request" });
  const ids = await Promise.all(Array.from({ length: 10 }, start));
  assert.equal(new Set(ids).size, 1, "every request should get the same run");
  await waitForFinish(ids);

  assert.equal(await start(), ids[0], "a later repeat should get the same run");

  const events = await db
    .selectFrom("events")
    .select("id")
    .where("run_id", "=", ids[0])
    .where("type", "=", "run_queued")
    .execute();
  assert.equal(events.length, 1, "the run should only be created once");
});

test("runs without a key are never treated as duplicates", async () => {
  const [first, second] = await Promise.all([
    store.startRun({ definition: pipeline }),
    store.startRun({ definition: pipeline }),
  ]);
  assert.notEqual(first, second);
  await waitForFinish([first, second]);
});

test("an engine rejects two workflows with the same name", () => {
  assert.throws(
    () => createWorkflowEngine({ workflows: [pipeline, pipeline], store }),
    /Duplicate workflow: pipeline/,
  );
});

test("workers only claim steps from workflows they know", async () => {
  const foreign = defineWorkflow({
    name: "foreign",
    title: "Foreign",
    description: "Belongs to a different engine.",
    steps: [{ name: "only", title: "Only", description: "A step.", run: async () => null }],
  });
  await store.syncWorkflows([foreign]);
  const runId = await store.startRun({ definition: foreign });

  // The running workers only know the pipeline workflow.
  await sleep(300);
  const run = await db
    .selectFrom("workflow_runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.equal(run.status, "queued");

  const claim = await store.claimStep({
    workerId: "other-engine",
    workflowNames: [foreign.name],
    order: "fair",
    defaultLeaseMs: 30_000,
  });
  assert.equal(claim?.runId, runId);
});

test("editing a workflow leaves earlier runs on the version they started with", async () => {
  /** Builds the same workflow with a different step title, so it hashes to a new version. */
  const version = (title: string) =>
    defineWorkflow({
      name: "versioned",
      title: "Versioned",
      description: "Changes between versions.",
      steps: [{ name: "only", title, description: "A step.", run: async () => null }],
    });
  /** The title in the plan for a run's only step. */
  const stepTitle = (runId: string) =>
    db
      .selectFrom("step_runs as sr")
      .innerJoin("steps as s", "s.id", "sr.step_id")
      .select("s.title")
      .where("sr.run_id", "=", runId)
      .executeTakeFirstOrThrow();

  const before = version("Before");
  await store.syncWorkflows([before]);
  const oldRun = await store.startRun({ definition: before });

  const edited = version("After");
  await store.syncWorkflows([edited]);
  const newRun = await store.startRun({ definition: edited });

  assert.equal((await stepTitle(oldRun)).title, "Before");
  assert.equal((await stepTitle(newRun)).title, "After");
});
