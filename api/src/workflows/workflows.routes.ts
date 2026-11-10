import type { WorkflowEngine } from "@ratchet/engine";
import type { FastifyInstance } from "fastify";
import type { WorkflowsResponse } from "../api.types.ts";

/** `GET /workflows`: what can be started now, from the engine's registry. */
export function workflowsRoutes(app: FastifyInstance, engine: WorkflowEngine) {
  // Past runs read their plan from the database, not from here.
  app.get("/workflows", async (): Promise<WorkflowsResponse> => ({
    workflows: [...engine.registry.values()].map((workflow) => ({
      name: workflow.name,
      title: workflow.title,
      description: workflow.description,
      presets: workflow.presets ?? [],
      steps: workflow.steps.map(({ name, title, description }) => ({ name, title, description })),
    })),
  }));
}
