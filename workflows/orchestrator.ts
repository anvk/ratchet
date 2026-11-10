import { closeOnSignals } from "@ratchet/engine";
import { engine } from "./engine.ts";

closeOnSignals(engine);
await engine.runOrchestrator();
await engine.close();
