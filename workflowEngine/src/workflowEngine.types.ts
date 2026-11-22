import type { FailureReason } from "./workflowEngine.constants.ts";

/** The settings a step may be given where the function asks for it. */
export interface StepOptions {
  /** How long a worker may go without a heartbeat before the step is given to another worker. */
  leaseMs?: number;
  /** How many times the step may run, counting the first. */
  maxAttempts?: number;
  /** The wait before the first retry, doubling for each one after it. */
  backoffMs?: number;
  /** How long one attempt may run. */
  timeoutMs?: number;
}

/** What a step's function receives when it runs. */
export interface StepRunContext {
  runId: string;
  stepName: string;
  /** Starts at 1. */
  attempt: number;
  /** The same on every attempt of this step. Pass it to anything with side effects. */
  idempotencyKey: string;
  /** Fires when the result won't be used: the step was taken away, or it ran past its time limit. */
  abortSignal: AbortSignal;
}

/** The code of one step. */
export type StepFunction<Output = unknown> = (step: StepRunContext) => Promise<Output> | Output;

/** What a workflow function receives. */
export interface WorkflowContext<Input = unknown> {
  runId: string;
  /** The input the run was started with. */
  input: Input;
  /**
   * Asks for a step. If the run has already saved this step's output, that
   * output comes back and `fn` is not called. If the step failed for good, a
   * StepFailedError is thrown here, which the function may catch. Otherwise
   * the promise doesn't settle in this replay: the function waits here until
   * it is run again with the step's result.
   *
   * A name may be used once in a run. Steps asked for without waiting in
   * between, as in `Promise.all`, are all asked for together.
   */
  step<Output>(name: string, fn: StepFunction<Output>, options?: StepOptions): Promise<Output>;
}

/**
 * A workflow as code. It must take the same path every time it is run with the
 * same saved results, so it may only wait on `ctx`, and anything that can
 * differ between two runs (the clock, random numbers, anything outside the
 * process) belongs inside a step.
 */
export type WorkflowFunction<Input = unknown, Output = unknown> = (
  ctx: WorkflowContext<Input>,
) => Promise<Output> | Output;

/**
 * What a run has saved about one step: its output, why it failed for good, or
 * `open` for a step the function asked for that hasn't finished.
 */
export type SavedStep =
  | { status: "succeeded"; output: unknown }
  | { status: "failed"; reason: FailureReason; error: string }
  | { status: "open" };

/** A step a function asked for. */
export interface AskedStep {
  name: string;
  options: StepOptions;
  /**
   * The steps this one comes straight after: those whose results the function
   * had to have before it would ask for this step, leaving out any that another
   * of them already comes after. For a step asked for once "charge" and
   * "reserve" were done, where each of those came after "load", this is
   * "charge" and "reserve". Worked out by trying: a step counts if, without its
   * result, the function doesn't get as far as asking for this one.
   */
  after: string[];
}

/**
 * What a workflow function did when run against what is saved.
 *
 * - `completed`: it returned.
 * - `failed`: it threw, or it broke one of the rules that replaying depends on.
 * - `parked`: it is waiting for steps that haven't finished. `requested` are
 *   the ones nothing is saved about yet, in the order it asked; `waitingOn` are
 *   all the unfinished steps it asked for, those included.
 */
export type Decision =
  | { kind: "completed"; output: unknown }
  | { kind: "failed"; reason: FailureReason; error: string; step?: string }
  | { kind: "parked"; requested: AskedStep[]; waitingOn: string[] };

/** What a replay needs: the function, and the run it is being replayed for. */
export interface ReplayRequest<Input = unknown> {
  run: WorkflowFunction<Input>;
  runId: string;
  input: Input;
  /** Everything the run has saved, by step name. */
  steps: Record<string, SavedStep>;
  /**
   * For steps the run already has, the steps each came straight after (see
   * AskedStep.after). Only used to work out the same for new steps with fewer
   * tries; leaving it out costs time, not correctness.
   */
  after?: Record<string, string[]>;
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
  /**
   * Any text you choose, such as "1". A run belongs to the version it started
   * on, and only workers with that version work on it, so workers with old
   * code and workers with new never share a run. The engine can't see inside
   * `run`, so this is the only thing that makes a new version: change it when
   * you edit the workflow in a way that runs already in progress couldn't
   * carry on with, such as a step renamed, removed or asked for in a different
   * order. Leave it alone for a fix those runs can pick up.
   */
  version: string;
  /** Keeps runs that share a key from overlapping. Runs are not limited by default. */
  concurrency?: WorkflowConcurrency<Input>;
  /**
   * The workflow's code. It asks for steps with `ctx.step`, and whatever it
   * returns is the run's output. It is run again from the top whenever one of
   * its steps finishes, getting back the results already saved, so it must
   * take the same path each time: see WorkflowFunction.
   */
  run: WorkflowFunction<Input>;
}

/**
 * Runs a run's workflow code against what the run has saved, and says what it
 * did. The engine gives one to the store methods that need it, since the store
 * has rows but not your code. It must be given a run of a workflow, and a
 * version, that this process has.
 */
export type AdvanceRun = (run: {
  /** The workflow's name. */
  workflow: string;
  runId: string;
  input: unknown;
  /** Everything the run has saved, by step name. */
  steps: Record<string, SavedStep>;
  /** For each step the run has, the steps it came straight after. See ReplayRequest.after. */
  after: Record<string, string[]>;
}) => Promise<Decision>;

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
  /** Used to find the step's code, by running the workflow up to where it asks for this step. */
  stepName: string;
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
  /** Everything the run had saved when the step was claimed, by step name, this step included. */
  saved: Record<string, SavedStep>;
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
 * What the message broker tells workers. A message is a hint, never the truth:
 * a worker acts on one by asking the store, which decides. So a message may
 * arrive more than once, or with nothing behind it, and do no harm.
 *
 * - `step_ready`: some step may be claimable now. It doesn't say which. This is
 *   the only thing that makes an idle worker look for work.
 * - `run_cancelled`: this run was cancelled, so a worker running one of its
 *   steps should check whether it still owns it.
 */
export type EngineMessage = { type: "step_ready" } | { type: "run_cancelled"; runId: string };

/**
 * Carries messages from the orchestrator to the workers, across processes. The
 * engine only talks to this interface, so Postgres LISTEN/NOTIFY, a broker such
 * as RabbitMQ or NATS, or a plain timer can sit behind it.
 *
 * Only the orchestrator publishes, from the store's outbox (see
 * WorkflowStore.relayMessages), and only workers subscribe.
 *
 * An idle worker does nothing until it is told `step_ready`, so an
 * implementation must never leave its subscribers waiting on a message it
 * failed to deliver: after any interruption in which it could have missed
 * one, such as a lost connection, it must tell them `step_ready` itself.
 */
export interface MessageBroker {
  /**
   * Sends a message to every subscriber, in this process and in others. Throws
   * if it couldn't be sent, so that the message stays in the outbox.
   */
  publish(message: EngineMessage): Promise<void>;
  /** Calls the listener for each message published from now on, until close. */
  subscribe(listener: (message: EngineMessage) => void): Promise<void>;
  /** Releases connections. */
  close(): Promise<void>;
}

/**
 * Where workflow state lives. The engine only talks to this interface, so a
 * file or another database can replace Postgres by implementing it.
 *
 * Every method must be atomic: a state change, its events and its messages
 * are saved together or not at all. A method that gives workers something to
 * do (a step to claim, or a run whose code should be run again) saves a
 * `step_ready` message, and one that stops a running step saves a
 * `run_cancelled` one, for relayMessages to hand over later. A step that will
 * retry is claimable when its backoff ends, so its message is held back until
 * then.
 *
 * What a run does next is decided by its workflow's code, never by the store.
 * **Advancing** a run means: with the run locked, hand everything it has saved
 * to an AdvanceRun and act on the decision. `parked`: make each step it asked
 * for claimable. `completed`: the run succeeds, with that output. `failed`: the
 * run fails, for that reason. A run lasts exactly as long as its code, so when
 * it finishes either way, steps it asked for that haven't started are skipped,
 * steps still running are failed with reason `cancelled` and their late results
 * refused, and a run in a group gives its slot to the oldest waiting run. Since
 * a run is only ever advanced under its lock, two steps finishing at once are
 * seen one after the other, and a step waiting for both is asked for once.
 */
export interface WorkflowStore {
  /** Saves each workflow's name and version, so runs of it can be started. Safe to repeat. */
  syncWorkflows(workflows: WorkflowDefinition[]): Promise<void>;
  /**
   * Creates a run and returns its id. The run has no steps yet: it is marked
   * for a worker to advance, which is when its code first runs.
   * If the caller's idempotencyKey was already used, creates nothing and returns
   * the existing run's id.
   * With `concurrency`, the run is admitted only if fewer than `limit` runs with
   * that key are in progress; otherwise it is created waiting, and is marked
   * to be advanced only when one finishes.
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
   * a workflow count, so a worker never runs a step with code the run didn't
   * start on. Two workers must never receive the same step.
   */
  claimStep(request: {
    workerId: string;
    workflows: WorkflowDefinition[];
    order: ClaimOrder;
    defaults: StepDefaults;
  }): Promise<Claim | null>;
  /**
   * Advances a run that is marked for it and belongs to one of these
   * workflows, and returns whether there was one. Only a run of a version in
   * `workflows` is taken, and two processes never advance the same run at
   * once. If `advance` throws, nothing changes and the run stays marked.
   */
  advanceRun(request: { workflows: WorkflowDefinition[]; advance: AdvanceRun }): Promise<boolean>;
  /**
   * Records success, then advances the run in the same transaction. With
   * claimNext, the first step that advance makes claimable goes straight to
   * the same worker, so no other worker can take it in between. `completed` is
   * false if the claim is stale, and then nothing else happens.
   */
  completeStep(request: {
    claim: Claim;
    output: unknown;
    claimNext: boolean;
    defaults: StepDefaults;
    advance: AdvanceRun;
  }): Promise<{ completed: boolean; next: Claim | null }>;
  /** Pushes a claim's lease forward by its leaseMs. False if this worker no longer owns the step. */
  extendLease(claim: Claim): Promise<boolean>;
  /**
   * Makes every running step whose lease has expired ready again, so another
   * worker can claim it, or fails the step for good if it has no attempts
   * left and marks its run to be advanced. Returns how many it found. Safe to
   * run from several processes at once.
   */
  sweepExpiredLeases(request: { defaults: StepDefaults }): Promise<number>;
  /**
   * Records a failure. If `final` is null and the step has attempts left, the
   * step becomes ready again after a backoff (`retryInMs`). Otherwise it fails
   * for good, with `failureReason` saying why, and the run is advanced in the
   * same transaction: its code is handed the failure, and either catches it and
   * carries on or fails the run. `recorded` is false if the claim is stale.
   */
  failStep(request: {
    claim: Claim;
    error: string;
    final: FinalFailure | null;
    defaults: StepDefaults;
    advance: AdvanceRun;
  }): Promise<{
    recorded: boolean;
    retryInMs: number | null;
    failureReason: FailureReason | null;
  }>;
  /**
   * Resumes a run that was cancelled, or that failed for a reason in
   * REDRIVABLE_FAILURE_REASONS. Steps that succeeded keep their outputs. Every
   * other step is put back to `pending` with fresh attempts, and becomes
   * claimable when the workflow's code asks for it again. The run is marked to
   * be advanced; one in a group that is full waits for a slot first. Returns
   * false, changing nothing, for any other run.
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
   * already has a schedule with this name. Throws InvalidScheduleError, saving
   * nothing, if `at` is not after now.
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
   * has already fired. Throws InvalidScheduleError if `cron` is given for a one-time schedule, if
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
   * Removes a schedule. The runs it started stay, untouched, with their
   * `scheduled_for` and the schedule's id. Returns false if there is no such
   * schedule.
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
   * were missed, it starts one run and resumes from now. A tick that comes due
   * while a run the schedule started hasn't finished starts nothing: it records
   * a `schedule_tick_skipped` event on that run and the schedule moves on to its
   * next tick. `scheduledRunFor` is called for each run to start with the
   * schedule's workflow, name and input, and returns the workflow's code and
   * concurrency group. Schedules of other workflows are left alone. Returns how
   * many runs it started; skipped ticks aren't counted.
   */
  fireDueSchedules(request: {
    workflows: WorkflowDefinition[];
    scheduledRunFor: (schedule: { workflow: string; name: string; input: unknown }) => ScheduledRun;
  }): Promise<number>;
  /**
   * Hands the saved messages whose time has come to `publish` and removes the
   * ones it took, however many are waiting. A retry's message is left until its
   * backoff is over. Repeats are sent once: any number of waiting
   * `step_ready` messages become one, and so do several `run_cancelled` for one
   * run, so a long backlog costs a few publishes. If `publish` throws, the
   * messages it was given stay saved for the next call. A message can be
   * published more than once, never lost. Safe to run from several processes at
   * once. Returns how many saved messages it removed.
   */
  relayMessages(request: { publish: (message: EngineMessage) => Promise<void> }): Promise<number>;
  /** Releases connections or file handles. */
  close(): Promise<void>;
}

/**
 * Why a worker knows a failure must not be retried: the step threw a
 * NonRetryableError, or the workflow's code never asked for the step when the
 * worker ran it to find the step's code. The store works out the other reasons
 * itself.
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
  /** How long a worker waits after an unexpected error, such as a lost connection. */
  errorBackoffMs: number;
  /** How long close waits for running steps before force closing. */
  closeTimeoutMs: number;
  /** How workers choose their next step. See ClaimOrder. */
  claimOrder: ClaimOrder;
  /** The lease for steps that don't set their own. See StepOptions.leaseMs. */
  leaseMs: number;
  /**
   * How long one attempt may run, for steps that don't set their own. See
   * StepOptions.timeoutMs. The one setting with no default, so no step can
   * run forever without someone having chosen its limit.
   */
  timeoutMs: number;
  /**
   * How often the orchestrator does its rounds: sweeping expired leases and
   * starting due scheduled runs.
   */
  sweepIntervalMs: number;
  /**
   * How often the orchestrator relays saved messages to the message broker.
   * Much shorter than its rounds: this is how long a ready step waits before
   * workers are told about it.
   */
  relayIntervalMs: number;
  /** How many times a step may run, for steps that don't set their own. See StepOptions.maxAttempts. */
  maxAttempts: number;
  /** The first retry's wait, for steps that don't set their own. See StepOptions.backoffMs. */
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
  /**
   * Runs a worker until the engine is closed. It subscribes to the message
   * broker: it claims steps until there are none, then waits for a
   * `step_ready` message, and a `run_cancelled` one makes it check the step it
   * is running.
   */
  runWorker(options?: { workerId?: string }): Promise<void>;
  /**
   * Runs the orchestrator until the engine is closed. It looks after runs as a
   * whole, and every sweepIntervalMs does two jobs: it makes steps whose worker
   * stopped sending heartbeats ready again, and it starts a run for each
   * schedule of this engine's workflows that is due and not paused. Every
   * relayIntervalMs it also relays the store's saved messages to the message
   * broker.
   */
  runOrchestrator(): Promise<void>;
  /**
   * Schedules start runs of a workflow by the clock. They live in the store, not
   * in the workflow's definition, and are not part of a workflow's version. A
   * schedule has a name, unique within its workflow, and the input each of its
   * runs starts with (an empty object by default). Its runs start on whatever
   * version of the workflow the firing orchestrator has.
   *
   * A schedule never has two of its runs going at once. A tick that comes due
   * while a run the schedule started hasn't finished starts nothing, and isn't
   * made up later: that run gets a `schedule_tick_skipped` event and the
   * schedule waits for its next tick. Only the schedule's own runs count, not
   * runs started by a call or by another schedule, and a run counts until it has
   * succeeded, failed or been cancelled, so one waiting in a concurrency group
   * counts, and so does one that was redriven. Every
   * method throws UnknownWorkflowError for a workflow this engine doesn't have,
   * and InvalidScheduleError for a request that can't be a schedule (see that class).
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
    /** Removes a schedule. The runs it started stay, keeping its id. False if there is no such schedule. */
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
   * for up to closeTimeoutMs, then closes the store and the message broker. Safe
   * to call more than once.
   *
   * With force, closes without waiting. A step still running when the store closes
   * can't be interrupted, so its result is lost; once its lease expires, the
   * orchestrator gives it to another worker.
   */
  close(options?: { force?: boolean }): Promise<void>;
}
