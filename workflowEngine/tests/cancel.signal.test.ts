import { startWorkers, stopWorkers, store, waitForFinish } from "./harness.ts";

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { db } from "../src/stores/postgres/index.ts";
import { cancellable } from "./fixtures/workflows.ts";

// Exactly one worker, so a second run can only start once the first run's step
// has returned.
before(() => startWorkers(1));
after(() => stopWorkers());

test("a cancelled step hears through its abort signal", async () => {
  const a = await store.startRun({ definition: cancellable, input: { untilSignal: true } });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const work = await db
      .selectFrom("step_runs")
      .select("status")
      .where("run_id", "=", a)
      .where("name", "=", "work")
      .executeTakeFirst();
    // The step isn't there until the workflow has asked for it.
    if (work?.status === "running") break;
    assert.ok(Date.now() < deadline, "work never started running");
    await sleep(20);
  }

  assert.equal(await store.cancelRun({ runId: a }), true);
  const b = await store.startRun({ definition: cancellable, input: { ms: 10 } });

  await waitForFinish([b], 3000);
  const run = await db
    .selectFrom("workflow_runs")
    .select("status")
    .where("id", "=", b)
    .executeTakeFirstOrThrow();
  assert.equal(run.status, "succeeded");
});
