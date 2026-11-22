// The smallest useful workflow, and a template for new ones.

import { setTimeout as sleep } from "node:timers/promises";
import { describeWorkflow } from "../describeWorkflow.ts";

export interface GreetingInput {
  name?: string;
  /** Multiplies waits. Tests use 0 to run instantly. */
  timeScale?: number;
}

export default describeWorkflow<GreetingInput>({
  name: "greeting",
  version: "1",
  title: "Send a greeting",
  description: "A three-step example showing how little a new workflow needs.",
  steps: {
    "choose-recipient": {
      title: "Choose recipient",
      description: "Reads who to greet from the run's input.",
    },
    "write-message": {
      title: "Write message",
      description: "Builds the greeting from the previous step's output.",
    },
    "send-message": { title: "Send message", description: "Pretends to deliver the message." },
  },
  async run(ctx) {
    const scale = ctx.input.timeScale ?? 1;
    const { recipient } = await ctx.step("choose-recipient", async () => {
      await sleep(1000 * scale);
      if (!ctx.input.name) throw new Error("Nobody to greet");
      return { recipient: ctx.input.name };
    });
    const { message } = await ctx.step("write-message", async () => {
      await sleep(1500 * scale);
      return { message: `Hello, ${recipient}!` };
    });
    return ctx.step("send-message", async () => {
      await sleep(1000 * scale);
      return { sent: message };
    });
  },
});
