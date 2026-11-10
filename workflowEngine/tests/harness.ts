import { adminUrl, TEST_DATABASE, testDatabaseUrl } from "./test-env.ts";

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createWorkflowEngine, FINISHED_RUN_STATUSES } from "../src/index.ts";
import { createPostgresStore, db } from "../src/stores/postgres/index.ts";
import { workflows } from "./fixtures/workflows.ts";

const WORKER = fileURLToPath(new URL("./fixtures/worker.ts", import.meta.url));
const SCHEMA = fileURLToPath(new URL("../src/stores/postgres/schema.sql", import.meta.url));

export const store = createPostgresStore();

const workers: ChildProcess[] = [];
const workerIds = new Map<ChildProcess, string>();

/** Recreates the test database from the Postgres store's schema.sql. */
async function resetDatabase() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  await admin.end();

  const test = new pg.Client({ connectionString: testDatabaseUrl });
  await test.connect();
  await test.query(readFileSync(SCHEMA, "utf8"));
  await test.end();
}

/** Workers are real separate processes, so they compete the way they do in production. */
export async function startWorkers(count: number) {
  await resetDatabase();
  await createWorkflowEngine({ workflows, store }).sync();
  for (let i = 1; i <= count; i++) {
    const worker = spawn(process.execPath, ["--import", "tsx", WORKER], {
      env: { ...process.env, WORKER_ID: `test-worker-${i}` },
      stdio: ["ignore", "ignore", "inherit"],
    });
    workers.push(worker);
    workerIds.set(worker, `test-worker-${i}`);
  }
}

/** Sends a signal to one worker process, found by its WORKER_ID. */
export function signalWorker(workerId: string, signal: NodeJS.Signals) {
  const worker = workers.find((w) => workerIds.get(w) === workerId);
  if (!worker) throw new Error(`No worker ${workerId}`);
  worker.kill(signal);
}

/** Shuts down the workers and closes the database connection. */
export async function stopWorkers() {
  await Promise.all(
    workers.map(
      (worker) =>
        new Promise<void>((resolve) => {
          if (worker.exitCode !== null || worker.signalCode !== null) return resolve();
          worker.once("exit", () => resolve());
          worker.kill("SIGTERM");
        }),
    ),
  );
  workers.length = 0;
  await store.close();
}

/** Waits until every run has succeeded or failed, and throws after the timeout. */
export async function waitForFinish(runIds: string[], timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await db
      .selectFrom("workflow_runs")
      .select("id")
      .where("id", "in", runIds)
      .where("status", "not in", FINISHED_RUN_STATUSES)
      .execute();
    if (open.length === 0) return;
    await sleep(50);
  }
  throw new Error("Runs did not finish in time");
}
