import {
  closeOnSignals,
  createPollingMessageBroker,
  createWorkflowEngine,
} from "../../src/index.ts";
import { createPostgresStore } from "../../src/stores/postgres/index.ts";
import { scheduledWorkflows, workflows } from "./workflows.ts";

const engine = createWorkflowEngine({
  workflows: [...workflows, ...scheduledWorkflows],
  store: createPostgresStore(),
  // Most tests run no orchestrator to relay messages, so these workers ask on a timer.
  messageBroker: createPollingMessageBroker({ everyMs: 5 }),
  settings: { timeoutMs: 60_000 },
});

closeOnSignals(engine);
await engine.runWorker({ workerId: process.env.WORKER_ID });
await engine.close();
