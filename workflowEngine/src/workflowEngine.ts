import { DEFAULT_ENGINE_SETTINGS } from "./workflowEngine.constants.ts";
import type {
  AdvanceRun,
  MessageBroker,
  Registry,
  ScheduledRun,
  WorkflowDefinition,
  WorkflowEngine,
  WorkflowEngineSettings,
  WorkflowStore,
} from "./workflowEngine.types.ts";
import { InvalidScheduleError, UnknownWorkflowError } from "./workflowEngine.errors.ts";
import { assertCronFires } from "./workflowEngine.cron.ts";
import { advance } from "./workflowEngine.replay.ts";
import { assertUnique } from "./workflowEngine.utils.ts";
import { runOrchestrator } from "./workflowEngine.orchestrator.ts";
import { runWorker } from "./workflowEngine.worker.ts";

/** Checks that a workflow is well formed and returns it, typing ctx.input in its code. */
export function defineWorkflow<Input = unknown>(
  definition: WorkflowDefinition<Input>,
): WorkflowDefinition<Input> {
  // The types already require these; the checks are for callers that aren't type-checked.
  if (typeof definition.name !== "string" || definition.name.trim() === "") {
    throw new Error("A workflow needs a name");
  }
  if (typeof definition.version !== "string" || definition.version.trim() === "") {
    throw new Error(`Workflow ${definition.name} needs a version`);
  }
  if (typeof definition.run !== "function") {
    throw new Error(`Workflow ${definition.name} needs a run function`);
  }
  if (
    definition.concurrency !== undefined &&
    !(Number.isInteger(definition.concurrency.limit) && definition.concurrency.limit > 0)
  ) {
    throw new Error(`Workflow ${definition.name} needs a whole, positive concurrency limit`);
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
 * Creates an engine from its workflows, storage, message broker and settings. Every setting
 * has a default except `timeoutMs`, which must be given. Several engines can
 * run side by side, each only claiming work from its own workflows.
 */
export function createWorkflowEngine({
  workflows,
  store,
  messageBroker,
  settings: overrides,
}: {
  workflows: WorkflowDefinition[];
  store: WorkflowStore;
  /** Tells workers when to look for work. createPollingMessageBroker needs nothing beside the store. */
  messageBroker: MessageBroker;
  settings: Partial<WorkflowEngineSettings> & Pick<WorkflowEngineSettings, "timeoutMs">;
}): WorkflowEngine {
  // The type already requires it; this is for callers that aren't type-checked.
  if (!(Number.isInteger(overrides.timeoutMs) && overrides.timeoutMs > 0)) {
    throw new Error("An engine needs a whole, positive timeoutMs setting");
  }
  if (!messageBroker) {
    throw new Error(
      "An engine needs a messageBroker; createPollingMessageBroker() needs nothing else",
    );
  }
  assertUnique(
    workflows.map((w) => w.name),
    "workflow",
  );
  const registry: Registry = new Map(workflows.map((w) => [w.name, w]));
  const settings = { ...DEFAULT_ENGINE_SETTINGS, ...overrides };
  const stop = new AbortController();
  const loops = new Set<Promise<void>>();
  let closed: Promise<void> | undefined;

  /**
   * Runs a run's workflow code against what it has saved. Workers hand this to
   * the store, which calls it with the run locked. Only ever given runs of
   * workflows in the registry, since those are the only ones a worker claims.
   */
  const advanceRun: AdvanceRun = ({ workflow, runId, input, steps, after }) => {
    const definition = registry.get(workflow);
    if (!definition) throw new UnknownWorkflowError(workflow);
    return advance({ run: definition.run, runId, input, steps, after });
  };

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
  function scheduledRunFor({
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
      track(
        runWorker({
          registry,
          store,
          messageBroker,
          settings,
          advance: advanceRun,
          stopSignal: stop.signal,
          workerId,
        }),
      ),
    runOrchestrator: () =>
      track(
        runOrchestrator({
          store,
          messageBroker,
          settings,
          stopSignal: stop.signal,
          workflows,
          scheduledRunFor,
        }),
      ),
    async close({ force = false } = {}) {
      stop.abort();
      if (!force) await waitForLoops();
      closed ??= Promise.all([store.close(), messageBroker.close()]).then(() => {});
      await closed;
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
