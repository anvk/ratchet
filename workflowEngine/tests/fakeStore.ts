import type { WorkflowStore } from "../src/index.ts";

/**
 * An in-memory WorkflowStore for tests that need no database. It hands out
 * `claims` claims of `workflow`/`step` (the step's name, defaulting to the
 * workflow's), then none, and records everything the engine does with them.
 */
export function fakeStore({
  workflow,
  step = workflow,
  claims = 1,
}: {
  workflow: string;
  step?: string;
  claims?: number;
}) {
  const calls = {
    claims: 0,
    completed: 0,
    closed: 0,
    /** The output of each completeStep call, in order. */
    outputs: [] as unknown[],
    /** The error and final of each failStep call, in order. */
    failures: [] as { error: string; final: string | null }[],
  };
  const store: WorkflowStore = {
    syncWorkflows: async () => {},
    startRun: async () => "run",
    async claimStep({ workerId }) {
      if (calls.claims === claims) return null;
      calls.claims++;
      return {
        stepRunId: `step-run-${calls.claims}`,
        stepName: step,
        position: 0,
        attempt: 1,
        leaseMs: 30_000,
        workerId,
        runId: "run",
        workflow,
        input: {},
        outputs: {},
      };
    },
    completeStep: async ({ output }) => {
      calls.completed++;
      calls.outputs.push(output);
      return { completed: true, next: null };
    },
    failStep: async ({ error, final }) => {
      calls.failures.push({ error, final });
      return { recorded: true, retryInMs: null, failureReason: "non_retryable" };
    },
    extendLease: async () => true,
    redriveRun: async () => false,
    cancelRun: async () => false,
    sweepExpiredLeases: async () => 0,
    fireDueSchedules: async () => 0,
    close: async () => {
      calls.closed++;
    },
  };
  return { store, calls };
}
