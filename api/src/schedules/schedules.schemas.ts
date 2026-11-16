import { z } from "zod";

// Everything that enters through the HTTP API is checked here, so a bad value
// becomes a 400 instead of a database error and a 500. Whether a cron parses,
// and whether exactly one of cron and at is given, is the engine's to say.

export const scheduleParams = z.object({ workflow: z.string(), name: z.string() });

const at = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const createScheduleBody = z.object({
  workflow: z.string(),
  name: z.string(),
  cron: z.string().optional(),
  at: at.optional(),
  input: z.unknown().optional(),
});

export const updateScheduleBody = z.object({
  cron: z.string().optional(),
  at: at.optional(),
  input: z.unknown().optional(),
});
