import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { ErrorResponse } from "../api.types.ts";

/**
 * Turns every thrown error into an ErrorResponse. A malformed request (failed
 * Zod parse) becomes a 400 listing what was wrong. Fastify's own client errors,
 * such as invalid JSON, keep their status. Anything else is a 500 that hides
 * its details from the client and logs them instead.
 */
export function errorHandler(error: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ZodError) {
    const body: ErrorResponse = { error: "Invalid request", issues: error.issues };
    return reply.code(400).send(body);
  }
  if (error.statusCode && error.statusCode < 500) {
    const body: ErrorResponse = { error: error.message };
    return reply.code(error.statusCode).send(body);
  }
  console.error(`${req.method} ${req.url} failed:`, error);
  const body: ErrorResponse = { error: "Internal error" };
  return reply.code(500).send(body);
}
