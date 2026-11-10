// The smallest useful workflow, and a template for new ones.

import { setTimeout as sleep } from "node:timers/promises";
import { defineWorkflow } from "@ratchet/engine";

interface GreetingInput {
  name?: string;
  /** Multiplies waits. Tests use 0 to run instantly. */
  timeScale?: number;
}

export default defineWorkflow<GreetingInput>({
  name: "greeting",
  title: "Send a greeting",
  description: "A three-step example showing how little a new workflow needs.",
  presets: [
    { label: "Greet the world", input: { name: "world" } },
    { label: "Greet nobody (fails)", input: { name: "" } },
  ],
  steps: [
    {
      name: "choose-recipient",
      title: "Choose recipient",
      description: "Reads who to greet from the run's input.",
      async run(ctx) {
        await sleep(1000 * (ctx.input.timeScale ?? 1));
        if (!ctx.input.name) throw new Error("Nobody to greet");
        return { recipient: ctx.input.name };
      },
    },
    {
      name: "write-message",
      title: "Write message",
      description: "Builds the greeting from the previous step's output.",
      async run(ctx) {
        await sleep(1500 * (ctx.input.timeScale ?? 1));
        return { message: `Hello, ${ctx.outputs["choose-recipient"].recipient}!` };
      },
    },
    {
      name: "send-message",
      title: "Send message",
      description: "Pretends to deliver the message.",
      async run(ctx) {
        await sleep(1000 * (ctx.input.timeScale ?? 1));
        return { sent: ctx.outputs["write-message"].message };
      },
    },
  ],
});
