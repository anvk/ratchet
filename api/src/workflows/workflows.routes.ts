import type { WorkflowEngine } from "@ratchet/engine";
import type { FastifyInstance } from "fastify";
import type { ApiOptions } from "../app.ts";
import type { WorkflowsResponse } from "../api.types.ts";
import { stepLabel, workflowLabel } from "../api.utils.ts";

/** `GET /workflows`: what can be started now, from the engine's registry, with the app's presets and labels. */
export function workflowsRoutes({
  app,
  engine,
  presets = {},
  labels,
}: { app: FastifyInstance; engine: WorkflowEngine } & ApiOptions) {
  // Past runs read their plan from the database, not from here.
  app.get("/workflows", async (): Promise<WorkflowsResponse> => ({
    workflows: [...engine.registry.values()].map((workflow) => ({
      name: workflow.name,
      ...workflowLabel({ labels, workflow: workflow.name }),
      presets: presets[workflow.name] ?? [],
      steps: workflow.steps.map(({ name }) => ({
        name,
        ...stepLabel({ labels, workflow: workflow.name, step: name }),
      })),
    })),
  }));
}
