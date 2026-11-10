import { closeOnSignals, createWorkflowEngine } from "../../src/index.ts";
import { createPostgresStore } from "../../src/stores/postgres/index.ts";
import { workflows } from "./workflows.ts";

const engine = createWorkflowEngine({
  workflows,
  store: createPostgresStore(),
  settings: { pollMs: 5 },
});

closeOnSignals(engine);
await engine.runWorker({ workerId: process.env.WORKER_ID });
await engine.close();
