import { createWorkflowEngine } from "@ratchet/engine";
import { createPostgresStore } from "@ratchet/engine/postgres";
import { workflows } from "./index.ts";

// This app's engine: which workflows it runs, where state lives, and how it behaves.
export const engine = createWorkflowEngine({
  workflows,
  store: createPostgresStore(),
  settings: {
    pollMs: 250,
    errorBackoffMs: 1000,
    closeTimeoutMs: 30_000,
    // "sticky" | "fair" | "oldest-run-first". Restart workers after changing it.
    claimOrder: "sticky",
  },
});
