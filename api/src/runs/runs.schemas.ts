import { z } from "zod";
import { WORKFLOW_RUN_STATUSES } from "@ratchet/engine";

// Everything that enters through the HTTP API is checked here, so a bad value
// becomes a 400 instead of a database error and a 500.

export const runParams = z.object({ id: z.uuid() });

export const startRunBody = z.object({
  workflow: z.string(),
  input: z.unknown().optional(),
  idempotency_key: z.string().min(1).optional(),
});

export const encodeCursor = (at: string, id: string) => `${at}|${id}`;

const cursor = z
  .string()
  .transform((value) => {
    const [at, id] = value.split("|");
    return { at, id };
  })
  .pipe(z.object({ at: z.iso.datetime(), id: z.uuid() }));

export const listRunsQuery = z.object({
  status: z.enum(WORKFLOW_RUN_STATUSES).optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
