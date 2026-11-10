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
   * Stays the same across retries of this step. Pass it to anything with side
   * effects, such as a payment provider, so a retry can't repeat the effect.
   */
  idempotencyKey: string;
}

/** One step of a workflow: how to describe it, and the code to run. */
export interface StepDefinition<Input = any> {
  /** Stable identifier, unique within the workflow. */
  name: string;
  title: string;
  description: string;
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
  }): Promise<{ completed: boolean; next: Claim | null }>;
  /** Records failure, skips the remaining steps and fails the run. False if the claim is stale. */
  failStep(claim: Claim, error: string): Promise<boolean>;
  /** Releases connections or file handles. */
  close(): Promise<void>;
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
   * Stops workers from claiming more steps, waits for the steps they are running
   * for up to closeTimeoutMs, then closes the store. Safe to call more than once.
   *
   * With force, closes without waiting. A step still running when the store closes
   * can't be interrupted, so its result is lost and it stays `running` until
   * something recovers it.
   */
  close(options?: { force?: boolean }): Promise<void>;
}
