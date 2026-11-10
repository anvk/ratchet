import type { FastifyInstance } from "fastify";

/** `GET /health`: answers once the API is up. */
export function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ ok: true }));
}
