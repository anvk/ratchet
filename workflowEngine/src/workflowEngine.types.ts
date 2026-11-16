import type { FailureReason } from "./workflowEngine.constants.ts";

/** What a step's run function receives from the engine. */
export interface StepContext<Input = any> {
  runId: string;
  stepName: string;
  attempt: number;
  /** The input the run was started with. */
  input: Input;
  /**
   * Outputs of every step this one depends on, directly or through other
   * steps, by step name. Steps running side by side never see each other's.
   */
  outputs: Record<string, any>;
  /**
   * Stays the same across every attempt of this step. Pass it to anything with
   * side effects, such as a payment provider, so running the step again can't
   * repeat the effect.
   */
  idempotencyKey: string;
  /**
   * Fires if this worker loses the step's lease, meaning another worker may
   * already be running it, or if the attempt runs past the step's `timeoutMs`.
   * Either way the result won't be used, so stop early if you can.
   */
  signal: AbortSignal;
}

/** One step of a workflow: its name, how it runs, and the code to run. */
export interface StepDefinition<Input = any> {
  /** Stable identifier, unique within the workflow. */
  name: string;
  /**
   * Steps that must succeed before this one starts. Steps whose needs are met
   * run side by side. Defaults to the step listed before it, so steps without
   * needs run in order; `[]` makes another starting step. A step can only need
   * steps listed before it, which also means steps can't wait on each other in
   * a loop.
   */
  needs?: string[];
  /**
   * How long a worker may go without a heartbeat before this step is given to
   * another worker. Defaults to the engine's leaseMs. Heartbeats come every
   * third of it, so a step that blocks the event loop for longer loses its lease.
   */
  leaseMs?: number;
  /**
   * How many times this step may run, counting the first, before its run fails.
   * A thrown error and a lost lease both use up an attempt; a NonRetryableError
   * fails at once. Defaults to the engine's maxAttempts.
   */
  maxAttempts?: number;
  /**
   * The wait before the first retry, doubling for each one after it. Defaults to
   * the engine's backoffMs.
   */
  backoffMs?: number;
  /**
   * How long one attempt may run. When it passes, `ctx.signal` fires and the
   * attempt fails like a thrown error, so it is retried while the step has
   * attempts left. No limit by default. The function itself can't be stopped: if
   * it ignores the signal it carries on in the background and its result is
   * discarded.
   */
  timeoutMs?: number;
  run(ctx: StepContext<Input>): Promise<unknown>;
}

/**
 * Limits how many of a workflow's runs are in progress at once. Each run's key
 * puts it in a group, and only `limit` runs of a group are in progress together.
 */
export interface WorkflowConcurrency<Input = any> {
  /**
   * Computed from a run's input when it starts. Runs with the same key form a
   * group. Null puts the run in no group, so it never waits.
   */
  key: (input: Input) => string | null;
  /** How many runs of a group may be in progress at once. The rest wait for one to finish, oldest first. */
  limit: number;
}

/** A workflow as its author writes it, passed to defineWorkflow. */
export interface WorkflowDefinition<Input = any> {
  /** Stable identifier, unique within the registry. */
  name: string;
  /** Keeps runs that share a key from overlapping. Runs are not limited by default. */
  concurrency?: WorkflowConcurrency<Input>;
  /** Each step is listed after the steps it needs. */
  steps: StepDefinition<Input>[];
}

/** Every workflow an engine knows about, by name. */
export type Registry = Map<string, WorkflowDefinition>;

/**
 * How workers choose their next step.
 *
 * - `sticky`: after finishing a step, a worker takes the next step of the same
 *   run, so a run goes start to finish on one worker. When several steps become
 *   ready at once, it takes the first and leaves the rest to other workers.
 *   Otherwise like `fair`.
 * - `fair`: the step that has been ready the longest, so runs take turns and
 *   move forward together.
 * - `oldest-run-first`: a step from the oldest run, on whichever worker is free.
 */
export type ClaimOrder = "sticky" | "fair" | "oldest-run-first";

/**
 * A step a worker has taken, plus everything needed to run it. Returned by
 * claimStep or completeStep, then passed back to completeStep or failStep.
 */
export interface Claim {
  stepRunId: string;
  /** Used with the workflow name to find the step's code in the registry. */
  stepName: string;
  /** Where the step is listed in the workflow. */
  position: number;
  /** Starts at 1. With workerId, proves this worker still owns the step. */
  attempt: number;
  /** The lease this claim was given, which every heartbeat renews. */
  leaseMs: number;
  workerId: string;
  runId: string;
  /** The workflow's name, not its id. */
  workflow: string;
  /** The input the run was started with. */
  input: unknown;
  /** Outputs of the steps this one depends on, directly or not, by step name. */
  outputs: Record<string, unknown>;
}

/** Optional details on a row in the events table. */
export interface EventFields {
  /** Step name. Left out for run-level events like run_started. */
  stepName?: string;
  attempt?: number;
  workerId?: string;
  /** Extra JSON, such as a failed step's error message. */
  detail?: unknown;
}

/** What the engine tells the store about a due schedule's run: the workflow's code and its concurrency group. */
export interface ScheduledRun {
  /** The workflow the schedule belongs to. */
  definition: WorkflowDefinition;
  /** Worked out by the engine from the schedule's input. See WorkflowStore.startRun. */
  concurrency?: { key: string; limit: number };
}

/**
 * Where workflow state lives. The engine only talks to this interface, so a
 * file or another database can replace Postgres by implementing it.
 *
 * Every method must be atomic: a state change and its events are saved
 * together or not at all.
 */
export interface WorkflowStore {
  /** Saves each workflow's plan. Safe to repeat, and an edit creates a new version. */
  syncWorkflows(workflows: WorkflowDefinition[]): Promise<void>;
  /**
   * Creates a run with its starting steps (those that need nothing) ready to
   * claim, and returns the run's id.
   * If the caller's idempotencyKey was already used, creates nothing and returns
   * the existing run's id.
   * With `concurrency`, the run is admitted only if fewer than `limit` runs with
   * that key are in progress; otherwise it is created waiting, with no step
   * ready, until one finishes.
   */
  startRun(request: {
    definition: WorkflowDefinition;
    input?: unknown;
    idempotencyKey?: string;
    concurrency?: { key: string; limit: number };
  }): Promise<string>;
  /**
   * Claims a ready step belonging to one of these workflows, choosing by order,
   * or returns null if there is none. Only runs started on the same version of
   * a workflow count, so a worker never runs a step with different code from
   * the run's plan. Two workers must never receive the same step.
   */
  claimStep(request: {
    workerId: string;
    workflows: WorkflowDefinition[];
    order: ClaimOrder;
    defaults: StepDefaults;
  }): Promise<Claim | null>;
  /**
   * Records success, then readies every step whose needs have now all
   * succeeded, or finishes the run once nothing can move: succeeded if every
   * step did, failed if any failed for good; finishing a run in a group gives
   * its slot to the oldest waiting run. Two steps finishing at
   * once must ready a step that needs both exactly once. With claimNext, the
   * first newly ready step goes straight to the same worker in the same
   * transaction, so no other worker can take it in between. `completed` is
   * false if the claim is stale.
   */
  completeStep(request: {
    claim: Claim;
    output: unknown;
    claimNext: boolean;
    defaults: StepDefaults;
  }): Promise<{ completed: boolean; next: Claim | null }>;
  /** Pushes a claim's lease forward by its leaseMs. False if this worker no longer owns the step. */
  extendLease(claim: Claim): Promise<boolean>;
  /**
   * Makes every running step whose lease has expired ready again, so another
   * worker can claim it, or fails its run if it has no attempts left. Returns
   * how many it found. Safe to run from several processes at once.
   */
  sweepExpiredLeases(request: { defaults: StepDefaults }): Promise<number>;
  /**
   * Records a failure. If `final` is null and the step has attempts left, the
   * step becomes ready again after a backoff (`retryInMs`). Otherwise it fails
   * for good, with `failureReason` saying why: steps that depend on it are
   * skipped, every other step carries on, and the run fails once nothing is
   * left to move; a run that fails gives its slot in a group to the oldest
   * waiting run. `recorded` is false if the claim is stale.
   */
  failStep(request: {
    claim: Claim;
    error: string;
    final: FinalFailure | null;
    defaults: StepDefaults;
  }): Promise<{
    recorded: boolean;
    retryInMs: number | null;
    failureReason: FailureReason | null;
  }>;
  /**
   * Resumes a run that was cancelled, or that failed for a reason in
   * REDRIVABLE_FAILURE_REASONS, from the steps that didn't succeed, with fresh attempts. Succeeded steps keep
   * their outputs. A run in a group that is full waits for a slot before its
   * steps become ready. Returns false, changing nothing, for any other run.
   */
  redriveRun(request: { runId: string }): Promise<boolean>;
  /**
   * Stops a run that hasn't finished: steps that haven't started are skipped, a
   * running step fails with reason `cancelled` (its worker's next heartbeat fails
   * and its result is rejected), and the run becomes `cancelled` (not
   * failed), giving up its slot in a group. Returns false, changing nothing, if the run
   * doesn't exist or has finished. A cancelled run can be redriven.
   */
  cancelRun(request: { runId: string }): Promise<boolean>;
  /**
   * Saves a schedule of a workflow, named by the workflow's name. With `cron`
   * it repeats, and its first run is at the next tick after now. With `at` it
   * fires once, at that moment. Returns false, saving nothing, if the workflow
   * already has a schedule with this name. Throws, saving nothing, if `at` is
   * not after now.
   */
  createSchedule(request: {
    workflow: string;
    name: string;
    cron?: string;
    at?: Date;
    input: unknown;
  }): Promise<boolean>;
  /**
   * Changes a schedule. A `cron` that differs from the saved one reschedules it
   * to the next tick after now. An `input` alone leaves its next run where it
   * was. An `at` moves a one-time schedule's moment. Returns false, changing
   * nothing, if there is no such schedule, or if it is a one-time schedule that
   * has already fired. Throws if `cron` is given for a one-time schedule, if
   * `at` is given for a repeating one, or if `at` is not after now.
   */
  updateSchedule(request: {
    workflow: string;
    name: string;
    cron?: string;
    at?: Date;
    input?: unknown;
  }): Promise<boolean>;
  /**
   * Removes a schedule. The runs it started stay, with their `scheduled_for`
   * and no schedule. Returns false if there is no such schedule.
   */
  deleteSchedule(request: { workflow: string; name: string }): Promise<boolean>;
  /**
   * Pauses or resumes a schedule. A paused schedule fires nothing. Resuming a
   * repeating schedule continues from the next tick after now, with no run for
   * the ticks skipped; resuming a one-time schedule leaves its moment as it was,
   * so one whose moment passed fires on the next round. Returns false, changing
   * nothing, if there is no such schedule or it is already in that state.
   */
  setSchedulePaused(request: { workflow: string; name: string; paused: boolean }): Promise<boolean>;
  /**
   * Starts a run for each due, unpaused schedule of these workflows, and moves
   * it on to its next tick; a one-time schedule has none afterwards. A schedule
   * starts one run per tick however many processes call this at once. If ticks
   * were missed, it starts one run and resumes from now. `prepare` is called for
   * each due schedule with its workflow, name and input, and returns the
   * workflow's code and concurrency group. Schedules of other workflows are left
   * alone. Returns how many runs it started.
   */
  fireDueSchedules(request: {
    workflows: WorkflowDefinition[];
    prepare: (schedule: { workflow: string; name: string; input: unknown }) => ScheduledRun;
  }): Promise<number>;
  /** Releases connections or file handles. */
  close(): Promise<void>;
}

/**
 * Why a worker knows a failure must not be retried: the step threw a
 * NonRetryableError, or the worker has no code for it. The store works out the
 * other reasons itself.
 */
export type FinalFailure = Extract<FailureReason, "non_retryable" | "unknown_step">;

/**
 * The engine-wide values for whatever a step doesn't set itself. The store needs
 * them to set leases, schedule retries and cap attempts.
 */
export interface StepDefaults {
  leaseMs: number;
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

/** How an engine instance behaves. */
export interface WorkflowEngineSettings {
  /** How long an idle worker waits before asking for work again. */
  pollMs: number;
  /** How long a worker waits after an unexpected error, such as a lost connection. */
  errorBackoffMs: number;
  /** How long close waits for running steps before force closing. */
  closeTimeoutMs: number;
  /** How workers choose their next step. See ClaimOrder. */
  claimOrder: ClaimOrder;
  /** The lease for steps that don't set their own. See StepDefinition.leaseMs. */
  leaseMs: number;
  /**
   * How often the orchestrator does its rounds: sweeping expired leases and
   * starting due scheduled runs.
   */
  sweepIntervalMs: number;
  /** How many times a step may run, for steps that don't set their own. See StepDefinition.maxAttempts. */
  maxAttempts: number;
  /** The first retry's wait, for steps that don't set their own. See StepDefinition.backoffMs. */
  backoffMs: number;
  /** The longest a retry ever waits, however many attempts came before. */
  maxBackoffMs: number;
}

/** A running configuration of the engine: its workflows, its storage and its settings. */
export interface WorkflowEngine {
  readonly registry: Registry;
  readonly settings: WorkflowEngineSettings;
  /**
   * Saves this engine's workflows to its store. Call it before starting runs, in
   * every process that starts runs; that includes the orchestrator, which starts
   * scheduled runs.
   */
  sync(): Promise<void>;
  /**
   * Starts a run of one of this engine's workflows, by name, and returns its
   * id. Throws UnknownWorkflowError, creating nothing, for any other name. See
   * WorkflowStore.startRun for idempotencyKey. A run of a workflow with
   * `concurrency` may wait for a slot before any of its steps run.
   */
  startRun(request: {
    workflow: string;
    input?: unknown;
    idempotencyKey?: string;
  }): Promise<string>;
  /**
   * Resumes a failed run from the steps that didn't succeed. A run in a group
   * that is full waits for a slot before its steps become ready. See
   * WorkflowStore.redriveRun.
   */
  redriveRun(runId: string): Promise<boolean>;
  /** Stops a run that hasn't finished. See WorkflowStore.cancelRun. */
  cancelRun(runId: string): Promise<boolean>;
  /** Runs a worker until the engine is closed. */
  runWorker(options?: { workerId?: string }): Promise<void>;
  /**
   * Runs the orchestrator until the engine is closed. It looks after runs as a
   * whole, and every sweepIntervalMs does two jobs: it makes steps whose worker
   * stopped sending heartbeats ready again, and it starts a run for each
   * schedule of this engine's workflows that is due and not paused.
   */
  runOrchestrator(): Promise<void>;
  /**
   * Schedules start runs of a workflow by the clock. They live in the store, not
   * in the workflow's definition, and are not part of a workflow's version. A
   * schedule has a name, unique within its workflow, and the input each of its
   * runs starts with (an empty object by default). Its runs start on whatever
   * version of the workflow the firing orchestrator has. A tick starts a run
   * even if the last one is still going, unless `concurrency` prevents it. Every
   * method throws UnknownWorkflowError for a workflow this engine doesn't have,
   * and an Error for an empty name or a cron that doesn't parse or never fires.
   */
  readonly schedules: {
    /**
     * Saves a schedule, with exactly one of `cron` (repeats; five fields, in UTC:
     * minute, hour, day of month, month, day of week) and `at` (fires once, at
     * that moment, which must be in the future). Returns false, saving nothing,
     * if the workflow already has a schedule with this name. See
     * WorkflowStore.createSchedule.
     */
    create(request: {
      workflow: string;
      name: string;
      cron?: string;
      at?: Date;
      input?: unknown;
    }): Promise<boolean>;
    /**
     * Changes a schedule's `cron`, `at` or `input`; at least one is needed. A new
     * cron reschedules from now, and an input alone keeps the next tick. Returns
     * false if there is no such schedule, or if it fires once and already has.
     * Throws if `cron` is given for a one-time schedule or `at` for a repeating
     * one. See WorkflowStore.updateSchedule.
     */
    update(request: {
      workflow: string;
      name: string;
      cron?: string;
      at?: Date;
      input?: unknown;
    }): Promise<boolean>;
    /** Removes a schedule, keeping the runs it started. False if there is no such schedule. */
    delete(request: { workflow: string; name: string }): Promise<boolean>;
    /** Stops a schedule from firing; it skips its ticks. False if it is missing or already paused. */
    pause(request: { workflow: string; name: string }): Promise<boolean>;
    /**
     * Lets a paused schedule fire again, from the next tick after now with no
     * catch-up run. False if it is missing or not paused. See
     * WorkflowStore.setSchedulePaused.
     */
    resume(request: { workflow: string; name: string }): Promise<boolean>;
  };
  /**
   * Stops workers from claiming more steps, waits for the steps they are running
   * for up to closeTimeoutMs, then closes the store. Safe to call more than once.
   *
   * With force, closes without waiting. A step still running when the store closes
   * can't be interrupted, so its result is lost; once its lease expires, the
   * orchestrator gives it to another worker.
   */
  close(options?: { force?: boolean }): Promise<void>;
}
