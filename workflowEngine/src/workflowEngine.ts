import { DEFAULT_ENGINE_SETTINGS } from "./workflowEngine.constants.ts";
import type {
  Registry,
  WorkflowDefinition,
  WorkflowEngine,
  WorkflowEngineSettings,
  WorkflowStore,
} from "./workflowEngine.types.ts";
import { assertUnique } from "./workflowEngine.utils.ts";
import { runWorker } from "./workflowEngine.worker.ts";

/** Checks that a workflow is well formed and returns it, typing ctx.input in its steps. */
export function defineWorkflow<Input = unknown>(
  definition: WorkflowDefinition<Input>,
): WorkflowDefinition<Input> {
  if (definition.steps.length === 0) {
    throw new Error(`Workflow ${definition.name} has no steps`);
  }
  assertUnique(
    definition.steps.map((s) => s.name),
    `step in ${definition.name}`,
  );
  return definition;
}

/**
 * Creates an engine from its workflows, storage and settings. Several engines
 * can run side by side, each only claiming work from its own workflows.
 */
export function createWorkflowEngine({
  workflows,
  store,
  settings,
}: {
  workflows: WorkflowDefinition[];
  store: WorkflowStore;
  settings?: Partial<WorkflowEngineSettings>;
}): WorkflowEngine {
  assertUnique(
    workflows.map((w) => w.name),
    "workflow",
  );
  const registry: Registry = new Map(workflows.map((w) => [w.name, w]));
  const resolved = { ...DEFAULT_ENGINE_SETTINGS, ...settings };
  const stop = new AbortController();
  const workers = new Set<Promise<void>>();
  let storeClosed: Promise<void> | undefined;

  /** Runs a worker, and tracks it so close can wait for it. */
  async function startWorker(workerId?: string) {
    const worker = runWorker({
      registry,
      store,
      settings: resolved,
      stopSignal: stop.signal,
      workerId,
    });
    workers.add(worker);
    try {
      await worker;
    } finally {
      workers.delete(worker);
    }
  }

  /** Waits for running workers, giving up after closeTimeoutMs. */
  async function waitForWorkers() {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), resolved.closeTimeoutMs);
    });
    const finished = Promise.allSettled(workers).then(() => false);

    if (await Promise.race([finished, timedOut])) {
      console.error(`Steps still running after ${resolved.closeTimeoutMs}ms. Force closing.`);
    }
    clearTimeout(timer);
  }

  return {
    registry,
    settings: resolved,
    sync: () => store.syncWorkflows(workflows),
    startRun: (request) => store.startRun(request),
    runWorker: ({ workerId } = {}) => startWorker(workerId),
    async close({ force = false } = {}) {
      stop.abort();
      if (!force) await waitForWorkers();
      storeClosed ??= store.close();
      await storeClosed;
    },
  };
}

/**
 * Closes the engine and exits on SIGINT or SIGTERM: gracefully the first time,
 * and with force the second. Process managers often deliver one Ctrl+C as several
 * signals, so repeats within a second don't count.
 */
export function closeOnSignals(engine: WorkflowEngine) {
  let firstSignalAt: number | undefined;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (firstSignalAt === undefined) {
        firstSignalAt = Date.now();
        // Exits explicitly, because a step abandoned by the timeout keeps the process alive.
        engine
          .close()
          .catch((err) => console.error("graceful close failed:", err))
          .finally(() => process.exit());
      } else if (Date.now() - firstSignalAt >= 1000) {
        engine
          .close({ force: true })
          .catch((err) => console.error("forced close failed:", err))
          .finally(() => process.exit(1));
      }
    });
  }
}
