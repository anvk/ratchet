import type { FailureReason } from "./workflowEngine.constants.ts";

/** What a step's run function receives from the engine. */
export interface StepContext<Input = any> {
  runId: string;
  stepName: string;
  attempt: number;
  /** The input the run was started with. */
  input: Input;
  /** Outputs of earlier steps, by step name. */
  outputs: Record<string, any>;
  /**
   * Stays the same across every attempt of this step. Pass it to anything with
   * side effects, such as a payment provider, so running the step again can't
   * repeat the effect.
   */
  idempotencyKey: string;
  /**
   * Fires if this worker loses the step's lease, meaning another worker may
   * already be running it. Stop early if you can: the result will be rejected.
   */
  signal: AbortSignal;
}

/** One step of a workflow: how to describe it, and the code to run. */
export interface StepDefinition<Input = any> {
  /** Stable identifier, unique within the workflow. */
  name: string;
  title: string;
  description: string;
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
  run(ctx: StepContext<Input>): Promise<unknown>;
}

/** A named input the dashboard offers when starting a run. */
export interface Preset {
  label: string;
  input: object;
}

/** A workflow as its author writes it, passed to defineWorkflow. */
export interface WorkflowDefinition<Input = any> {
  /** Stable identifier, unique within the registry. */
  name: string;
  title: string;
  description: string;
  presets?: Preset[];
  /** Run in this order. */
  steps: StepDefinition<Input>[];
}

/** Every workflow an engine knows about, by name. */
export type Registry = Map<string, WorkflowDefinition>;

/**
 * How workers choose their next step.
 *
 * - `sticky`: after finishing a step, a worker takes the next step of the same
 *   run, so a run goes start to finish on one worker. Otherwise like `fair`.
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
  /** Order within the run. Finishing a step makes position + 1 ready. */
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
  /** Outputs of the steps that have already succeeded, by step name. */
  outputs: Record<string, unknown>;
}

/** Optional details on a row in the events table. */
export interface EventFields {
  /** Step name. Left out for run-level events like run_started. */
  step?: string;
  attempt?: number;
  workerId?: string;
  /** Extra JSON, such as a failed step's error message. */
  detail?: unknown;
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
   * Creates a run with its first step ready to claim, and returns the run's id.
   * If the caller's idempotencyKey was already used, creates nothing and returns
   * the existing run's id.
   */
  startRun(request: {
    definition: WorkflowDefinition;
    input?: unknown;
    idempotencyKey?: string;
  }): Promise<string>;
  /**
   * Claims a ready step belonging to one of these workflows, choosing by order,
   * or returns null if there is none. Two workers must never receive the same step.
   */
  claimStep(request: {
    workerId: string;
    workflowNames: string[];
    order: ClaimOrder;
    defaults: StepDefaults;
  }): Promise<Claim | null>;
  /**
   * Records success, then readies the next step or finishes the run. With
   * claimNext, the next step goes straight to the same worker in the same
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
   * for good, with `failureReason` saying why: the remaining steps are skipped
   * and the run fails. `recorded` is false if the claim is stale.
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
  /** How often the orchestrator sweeps for expired leases. */
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
  /** Saves this engine's workflows to its store. Call before starting runs. */
  sync(): Promise<void>;
  /** Starts a run. See WorkflowStore.startRun. */
  startRun(request: {
    definition: WorkflowDefinition;
    input?: unknown;
    idempotencyKey?: string;
  }): Promise<string>;
  /** Runs a worker until the engine is closed. */
  runWorker(options?: { workerId?: string }): Promise<void>;
  /**
   * Runs the orchestrator until the engine is closed. It looks after runs as a
   * whole; so far, every sweepIntervalMs it makes steps whose worker stopped
   * sending heartbeats ready again.
   */
  runOrchestrator(): Promise<void>;
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
