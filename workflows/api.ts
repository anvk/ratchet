import { startApi } from "@ratchet/api";
import { engine } from "./engine.ts";
import { labels, presets } from "./index.ts";

await engine.sync();
// Starts a greeting every minute, so there is a scheduled run to look at. False, changing nothing, once it exists.
await engine.schedules.create({
  workflow: "greeting",
  name: "every-minute",
  cron: "* * * * *",
  input: { name: "the scheduler" },
});
await startApi(engine, { presets, labels });
