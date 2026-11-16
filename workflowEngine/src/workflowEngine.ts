import { DEFAULT_ENGINE_SETTINGS } from "./workflowEngine.constants.ts";
import type {
  Registry,
  ScheduledRun,
  WorkflowDefinition,
  WorkflowEngine,
  WorkflowEngineSettings,
  WorkflowStore,
} from "./workflowEngine.types.ts";
import { InvalidScheduleError, UnknownWorkflowError } from "./workflowEngine.errors.ts";
import { assertCronFires } from "./workflowEngine.cron.ts";
import { assertUnique } from "./workflowEngine.utils.ts";
import { runOrchestrator } from "./workflowEngine.orchestrator.ts";
import { runWorker } from "./workflowEngine.worker.ts";

/** Checks that a workflow is well formed and returns it, typing ctx.input in its steps. */
export function defineWorkflow<Input = unknown>(
  definition: WorkflowDefinition<Input>,
): WorkflowDefinition<Input> {
  if (definition.steps.length === 0) {
    throw new Error(`Workflow ${definition.name} has no steps`);
  }
  if (
    definition.concurrency !== undefined &&
    !(Number.isInteger(definition.concurrency.limit) && definition.concurrency.limit > 0)
  ) {
    throw new Error(`Workflow ${definition.name} needs a whole, positive concurrency limit`);
  }
  assertUnique(
    definition.steps.map((s) => s.name),
    `step in ${definition.name}`,
  );
  for (const [i, step] of definition.steps.entries()) {
    const stepLabel = `Step ${definition.name}/${step.name}`;
    const earlierNames = definition.steps.slice(0, i).map((s) => s.name);
    for (const need of step.needs ?? []) {
      // Only earlier steps, which rules out unknown names, itself and loops at once.
      if (!earlierNames.includes(need)) {
        throw new Error(`${stepLabel} needs ${need}, which isn't a step listed before it`);
      }
    }
    assertUnique(step.needs ?? [], `need in ${stepLabel}`);
    if (step.leaseMs !== undefined && !(Number.isInteger(step.leaseMs) && step.leaseMs > 0)) {
      throw new Error(`${stepLabel} needs a whole, positive leaseMs`);
    }
    if (step.timeoutMs !== undefined && !(Number.isInteger(step.timeoutMs) && step.timeoutMs > 0)) {
      throw new Error(`${stepLabel} needs a whole, positive timeoutMs`);
    }
    if (
      step.maxAttempts !== undefined &&
      !(Number.isInteger(step.maxAttempts) && step.maxAttempts > 0)
    ) {
      throw new Error(`${stepLabel} needs a whole, positive maxAttempts`);
    }
    if (
      step.backoffMs !== undefined &&
      !(Number.isInteger(step.backoffMs) && step.backoffMs >= 0)
    ) {
      throw new Error(`${stepLabel} needs a whole backoffMs of 0 or more`);
    }
  }
  return definition;
}

/**
 * The concurrency group a run of a workflow with this input belongs to, or
 * undefined when the workflow has no `concurrency` or its key is null. Runs
 * the workflow's key function, which is user code, so the store never has to.
 */
function concurrencyFor({
  definition,
  input,
}: {
  definition: WorkflowDefinition;
  input: unknown;
}): { key: string; limit: number } | undefined {
  const key = definition.concurrency?.key(input);
  return definition.concurrency && key != null
    ? { key, limit: definition.concurrency.limit }
    : undefined;
}

/**
 * Creates an engine from its workflows, storage and settings. Several engines
 * can run side by side, each only claiming work from its own workflows.
 */
export function createWorkflowEngine({
  workflows,
  store,
  settings: overrides,
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
  const settings = { ...DEFAULT_ENGINE_SETTINGS, ...overrides };
  const stop = new AbortController();
  const loops = new Set<Promise<void>>();
  let storeClosed: Promise<void> | undefined;

  /** Tracks a running worker or orchestrator, so close can wait for it to stop. */
  async function track(loop: Promise<void>) {
    loops.add(loop);
    try {
      await loop;
    } finally {
      loops.delete(loop);
    }
  }

  /** Waits for running workers and orchestrators, giving up after closeTimeoutMs. */
  async function waitForLoops() {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), settings.closeTimeoutMs);
    });
    const finished = Promise.allSettled(loops).then(() => false);

    if (await Promise.race([finished, timedOut])) {
      console.error(`Steps still running after ${settings.closeTimeoutMs}ms. Force closing.`);
    }
    clearTimeout(timer);
  }

  /** Throws UnknownWorkflowError, or InvalidScheduleError for an empty name, so nothing reaches the store. */
  function assertScheduleTarget({ workflow, name }: { workflow: string; name: string }) {
    if (!registry.has(workflow)) throw new UnknownWorkflowError(workflow);
    if (name.trim() === "") throw new InvalidScheduleError("A schedule needs a name");
  }

  /** Throws unless `at` is a valid date. Whether it is in the future is for the store, which has the database's clock. */
  function assertValidAt(at: Date) {
    if (Number.isNaN(at.getTime()))
      throw new InvalidScheduleError("A schedule's `at` isn't a valid date");
  }

  const schedules: WorkflowEngine["schedules"] = {
    async create({ workflow, name, cron, at, input }) {
      assertScheduleTarget({ workflow, name });
      if ((cron === undefined) === (at === undefined)) {
        throw new InvalidScheduleError("A schedule needs exactly one of `cron` and `at`");
      }
      if (cron !== undefined) assertCronFires(cron);
      if (at !== undefined) assertValidAt(at);
      return store.createSchedule({ workflow, name, cron, at, input: input ?? {} });
    },
    async update({ workflow, name, cron, at, input }) {
      assertScheduleTarget({ workflow, name });
      if (cron === undefined && at === undefined && input === undefined) {
        throw new InvalidScheduleError("An update needs at least one of `cron`, `at` and `input`");
      }
      if (cron !== undefined && at !== undefined) {
        throw new InvalidScheduleError("A schedule has either `cron` or `at`, not both");
      }
      if (cron !== undefined) assertCronFires(cron);
      if (at !== undefined) assertValidAt(at);
      return store.updateSchedule({ workflow, name, cron, at, input });
    },
    async delete({ workflow, name }) {
      assertScheduleTarget({ workflow, name });
      return store.deleteSchedule({ workflow, name });
    },
    async pause({ workflow, name }) {
      assertScheduleTarget({ workflow, name });
      return store.setSchedulePaused({ workflow, name, paused: true });
    },
    async resume({ workflow, name }) {
      assertScheduleTarget({ workflow, name });
      return store.setSchedulePaused({ workflow, name, paused: false });
    },
  };

  /** What a due schedule's run needs: its workflow's code, and the concurrency group its input falls in. */
  function prepareScheduledRun({
    workflow,
    input,
  }: {
    workflow: string;
    input: unknown;
  }): ScheduledRun {
    const definition = registry.get(workflow)!;
    return { definition, concurrency: concurrencyFor({ definition, input }) };
  }

  return {
    registry,
    settings,
    schedules,
    sync: () => store.syncWorkflows(workflows),
    startRun({ workflow, input, idempotencyKey }) {
      const definition = registry.get(workflow);
      if (!definition) return Promise.reject(new UnknownWorkflowError(workflow));
      try {
        const concurrency = concurrencyFor({ definition, input });
        return store.startRun({ definition, input, idempotencyKey, concurrency });
      } catch (err) {
        return Promise.reject(err);
      }
    },
    redriveRun: (runId) => store.redriveRun({ runId }),
    cancelRun: (runId) => store.cancelRun({ runId }),
    runWorker: ({ workerId } = {}) =>
      track(runWorker({ registry, store, settings, stopSignal: stop.signal, workerId })),
    runOrchestrator: () =>
      track(
        runOrchestrator({
          store,
          settings,
          stopSignal: stop.signal,
          workflows,
          prepare: prepareScheduledRun,
        }),
      ),
    async close({ force = false } = {}) {
      stop.abort();
      if (!force) await waitForLoops();
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
