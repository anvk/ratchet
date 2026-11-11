import type { WorkflowEngine } from "@ratchet/engine";
import Fastify from "fastify";
import { healthRoutes } from "./health/health.routes.ts";
import { errorHandler } from "./middlewares/errorHandler.ts";
import { notFound } from "./middlewares/notFound.ts";
import { runsRoutes } from "./runs/runs.routes.ts";
import { workflowsRoutes } from "./workflows/workflows.routes.ts";
import type { Preset } from "./api.types.ts";

/** What the app serving the API adds on top of the engine. */
export interface ApiOptions {
  /** Inputs the dashboard offers for each workflow, by workflow name. */
  presets?: Record<string, Preset[]>;
}

/** Builds the HTTP API without starting it: middlewares first, then routes. */
export function buildApp(engine: WorkflowEngine, options: ApiOptions = {}) {
  const app = Fastify({ logger: false });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFound);

  healthRoutes(app);
  workflowsRoutes({ app, engine, ...options });
  runsRoutes(app, engine);

  return app;
}
