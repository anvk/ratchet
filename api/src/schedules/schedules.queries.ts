import { db } from "@ratchet/engine/postgres";

// The read side, like runs.queries.ts: only ever SELECTs.

export function listSchedules() {
  return db
    .selectFrom("schedules")
    .select(["workflow", "name", "cron", "next_fire_at", "last_fired_at"])
    .orderBy("workflow")
    .orderBy("name")
    .execute();
}
