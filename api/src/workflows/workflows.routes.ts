import type { WorkflowEngine } from "@ratchet/engine";
import type { FastifyInstance } from "fastify";
import type { ApiOptions } from "../app.ts";
import type { WorkflowsResponse } from "../api.types.ts";

/** `GET /workflows`: what can be started now, from the engine's registry, with the app's presets. */
export function workflowsRoutes({
  app,
  engine,
  presets = {},
}: { app: FastifyInstance; engine: WorkflowEngine } & ApiOptions) {
  // Past runs read their plan from the database, not from here.
  app.get("/workflows", async (): Promise<WorkflowsResponse> => ({
    workflows: [...engine.registry.values()].map((workflow) => ({
      name: workflow.name,
      title: workflow.title,
      description: workflow.description,
      presets: presets[workflow.name] ?? [],
      steps: workflow.steps.map(({ name, title, description }) => ({ name, title, description })),
    })),
  }));
}
