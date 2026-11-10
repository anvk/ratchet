import { startApi } from "@ratchet/api";
import { engine } from "./engine.ts";

await engine.sync();
await startApi(engine);
