import { advanceAll, startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createWorkflowEngine,
  createPollingMessageBroker,
  DEFAULT_ENGINE_SETTINGS,
  defineWorkflow,
  UnknownWorkflowError,
} from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { pipeline, workflows } from "./fixtures/workflows.ts";

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

test("a failed step fails the run, and the steps after it are never asked for", async () => {
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
    () =>
      createWorkflowEngine({
        messageBroker: createPollingMessageBroker(),
        workflows: [pipeline, pipeline],
        store,
        settings: { timeoutMs: 60_000 },
      }),
    /Duplicate workflow: pipeline/,
  );
});

test("workers only work on workflows they know", async () => {
  const foreign = defineWorkflow({
    name: "foreign",
    version: "1",
    run: (ctx) => ctx.step("only", () => null),
  });
  await store.syncWorkflows([foreign]);
  const runId = await store.startRun({ definition: foreign });

  // The running workers don't have this workflow, so they neither advance it nor claim from it.
  await sleep(300);
  const run = await db
    .selectFrom("workflow_runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.equal(run.status, "queued");
  assert.deepEqual(await stepStatuses(runId), []);

  await advanceAll([foreign]);
  const claim = await store.claimStep({
    workerId: "other-engine",
    workflows: [foreign],
    order: "fair",
    defaults: { ...DEFAULT_ENGINE_SETTINGS, leaseMs: 30_000 },
  });
  assert.equal(claim?.runId, runId);
});

test("a new version of a workflow leaves earlier runs on the version they started with", async () => {
  const version = (text: string) =>
    defineWorkflow({
      name: "versioned",
      version: text,
      run: (ctx) => ctx.step("only", () => text),
    });
  /** The version a run is on, by its own record and by the workflow row it points at. */
  const versionOf = (runId: string) =>
    db
      .selectFrom("workflow_runs as r")
      .innerJoin("workflows as w", "w.id", "r.workflow_id")
      .select(["r.workflow_version", "w.version"])
      .where("r.id", "=", runId)
      .executeTakeFirstOrThrow();

  const before = version("1");
  await store.syncWorkflows([before]);
  const oldRun = await store.startRun({ definition: before });

  const after = version("2");
  await store.syncWorkflows([after]);
  const newRun = await store.startRun({ definition: after });

  assert.deepEqual(await versionOf(oldRun), { workflow_version: "1", version: "1" });
  assert.deepEqual(await versionOf(newRun), { workflow_version: "2", version: "2" });

  // Each run is advanced only by code of its own version.
  await advanceAll([after]);
  assert.deepEqual(await stepStatuses(oldRun), []);
  assert.deepEqual(await stepStatuses(newRun), [{ name: "only", status: "ready" }]);
  await db.deleteFrom("workflow_runs").where("id", "in", [oldRun, newRun]).execute();
});

test("engine.startRun starts a run by workflow name, and rejects a name it doesn't have", async () => {
  const engine = createWorkflowEngine({
    messageBroker: createPollingMessageBroker(),
    workflows,
    store,
    settings: { timeoutMs: 60_000 },
  });
  const runId = await engine.startRun({ workflow: "pipeline", input: {} });
  await waitForFinish([runId]);
  const run = await db
    .selectFrom("workflow_runs as r")
    .innerJoin("workflows as w", "w.id", "r.workflow_id")
    .select(["w.name", "r.status"])
    .where("r.id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.deepEqual(run, { name: "pipeline", status: "succeeded" });

  const { count: before } = await db
    .selectFrom("workflow_runs")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  await assert.rejects(
    engine.startRun({ workflow: "no-such-workflow", input: {} }),
    (err) => err instanceof UnknownWorkflowError && err.workflow === "no-such-workflow",
  );
  const { count: after } = await db
    .selectFrom("workflow_runs")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  assert.equal(after, before, "an unknown name creates no run");
});

test("changing only a workflow's version makes a new version, which workers with the old one leave alone", async () => {
  // Same code, new version: like a deploy that changed what a step does.
  const bumped = { ...pipeline, version: "2" };
  await store.syncWorkflows([bumped]);
  const versions = await db
    .selectFrom("workflows")
    .select("version")
    .where("name", "=", pipeline.name)
    .execute();
  assert.deepEqual(versions.map((v) => v.version).sort(), ["1", "2"]);
  const runId = await store.startRun({ definition: bumped });
  const started = await db
    .selectFrom("workflow_runs")
    .select("workflow_version")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.equal(started.workflow_version, "2", "a run records the version it started on");

  // The running workers have version "1", so they leave it alone.
  await sleep(300);
  const run = await db
    .selectFrom("workflow_runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.equal(run.status, "queued");

  await advanceAll([bumped]);
  const claim = await store.claimStep({
    workerId: "newer-deploy",
    workflows: [bumped],
    order: "fair",
    defaults: { ...DEFAULT_ENGINE_SETTINGS, leaseMs: 30_000 },
  });
  assert.equal(claim?.runId, runId);
  await db.deleteFrom("workflow_runs").where("id", "=", runId).execute();
});

test("defineWorkflow rejects a workflow without a version", () => {
  const define = (version: unknown) =>
    defineWorkflow({
      name: "unversioned",
      version: version as string,
      run: (ctx) => ctx.step("only", () => null),
    });
  for (const version of [undefined, "", "  ", 2]) {
    assert.throws(() => define(version), /Workflow unversioned needs a version/);
  }
  assert.doesNotThrow(() => define("2"));
});

test("defineWorkflow rejects a workflow without a name or without code", () => {
  const run = () => null;
  assert.throws(() => defineWorkflow({ name: "", version: "1", run }), /A workflow needs a name/);
  assert.throws(
    () => defineWorkflow({ name: "no-code", version: "1", run: undefined as never }),
    /Workflow no-code needs a run function/,
  );
  assert.throws(
    () => defineWorkflow({ name: "old-style", version: "1", steps: [] } as never),
    /Workflow old-style needs a run function/,
  );
});

test("a run's output is what its workflow returned", async () => {
  const runId = await store.startRun({ definition: pipeline });
  await waitForFinish([runId]);

  const run = await db
    .selectFrom("workflow_runs")
    .select(["status", "output"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.deepEqual(run, {
    status: "succeeded",
    output: { total: 3, idempotencyKey: `${runId}:third` },
  });
});
