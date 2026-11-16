import { closeOnSignals, createWorkflowEngine } from "../../src/index.ts";
import { createPostgresStore } from "../../src/stores/postgres/index.ts";
import { scheduledWorkflows, workflows } from "./workflows.ts";

const engine = createWorkflowEngine({
  workflows: [...workflows, ...scheduledWorkflows],
  store: createPostgresStore(),
  settings: { pollMs: 5 },
});

closeOnSignals(engine);
await engine.runWorker({ workerId: process.env.WORKER_ID });
await engine.close();
