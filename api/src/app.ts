import type { WorkflowEngine } from "@ratchet/engine";
import Fastify from "fastify";
import { healthRoutes } from "./health/health.routes.ts";
import { errorHandler } from "./middlewares/errorHandler.ts";
import { notFound } from "./middlewares/notFound.ts";
import { runsRoutes } from "./runs/runs.routes.ts";
import { workflowsRoutes } from "./workflows/workflows.routes.ts";

/** Builds the HTTP API without starting it: middlewares first, then routes. */
export function buildApp(engine: WorkflowEngine) {
  const app = Fastify({ logger: false });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFound);

  healthRoutes(app);
  workflowsRoutes(app, engine);
  runsRoutes(app, engine);

  return app;
}
