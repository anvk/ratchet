import { closeOnSignals } from "@ratchet/engine";
import { engine } from "./engine.ts";

closeOnSignals(engine);
// The orchestrator starts scheduled runs, so like anything that starts runs it saves the workflows' plans first.
await engine.sync();
await engine.runOrchestrator();
await engine.close();
