import { closeOnSignals } from "@ratchet/engine";
import { engine } from "./engine.ts";

closeOnSignals(engine);
await engine.runWorker({ workerId: process.env.WORKER_ID });
await engine.close();
