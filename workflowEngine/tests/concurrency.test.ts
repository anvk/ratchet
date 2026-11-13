import { startWorkers, stopWorkers, store } from "./harness.ts";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createWorkflowEngine, defineWorkflow } from "../src/index.ts";
import { db } from "../src/stores/postgres/index.ts";
import { pipeline } from "./fixtures/workflows.ts";

// No workers: these tests only look at what a run records when it starts.
before(() => startWorkers(0));
after(() => stopWorkers());

interface GroupedInput {
  group?: string;
}

/** A one-step workflow that groups runs by input.group, two at a time. */
const grouped = defineWorkflow<GroupedInput>({
  name: "concurrency-grouped",
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
  const engine = createWorkflowEngine({ workflows: [grouped], store });
  await engine.sync();
  return engine.startRun({ workflow: "concurrency-grouped", input });
}

test("defineWorkflow rejects a concurrency limit that isn't a whole, positive number", () => {
  const define = (limit: number) =>
    defineWorkflow({
      name: "concurrency-bad",
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
      concurrency: { key: () => "a", limit },
      steps: [{ name: "only", run: async () => null }],
    });
  await createWorkflowEngine({ workflows: [withLimit(2)], store }).sync();
  await createWorkflowEngine({ workflows: [withLimit(3)], store }).sync();
  const versions = await db
    .selectFrom("workflows")
    .select("id")
    .where("name", "=", "concurrency-versioned")
    .execute();
  assert.equal(versions.length, 1);
});
