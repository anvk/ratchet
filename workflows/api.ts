import { startApi } from "@ratchet/api";
import { engine } from "./engine.ts";
import { presets } from "./index.ts";

await engine.sync();
await startApi(engine, { presets });
