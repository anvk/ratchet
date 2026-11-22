import assert from "node:assert/strict";
import { test } from "node:test";
import { advance } from "@ratchet/engine";
import { describeWorkflow } from "../describeWorkflow.ts";

const { definition, labels } = describeWorkflow<{ name: string }>({
  name: "demo",
  version: "1",
  title: "Run a demo",
  description: "Shows the labels.",
  steps: {
    "first-step": { title: "First step", description: "Goes first." },
    "second-step": { title: "Second step", description: "Goes second." },
  },
  async run(ctx) {
    await ctx.step("first-step", () => ({ ok: true }));
    return ctx.step("second-step", () => ({ ok: false }));
  },
});

test("labels hold the workflow's text and one entry per step, by name", () => {
  assert.deepEqual(labels, {
    title: "Run a demo",
    description: "Shows the labels.",
    steps: {
      "first-step": { title: "First step", description: "Goes first." },
      "second-step": { title: "Second step", description: "Goes second." },
    },
  });
});

test("the definition keeps the name, the version and the workflow's code", async () => {
  assert.equal(definition.name, "demo");
  assert.equal(definition.version, "1");
  const decision = await advance({
    run: definition.run,
    runId: "run-1",
    input: { name: "x" },
    steps: { "first-step": { status: "succeeded", output: { ok: true } } },
  });
  assert.deepEqual(decision, {
    kind: "parked",
    requested: [{ name: "second-step", options: {}, after: ["first-step"] }],
    waitingOn: ["second-step"],
  });
});

test("the definition has no title, description or step labels", () => {
  assert.equal("title" in definition, false);
  assert.equal("description" in definition, false);
  assert.equal("steps" in definition, false);
});

test("a concurrency setting reaches the definition", () => {
  const { definition } = describeWorkflow<{ group?: string }>({
    name: "grouped",
    version: "1",
    title: "Run grouped",
    description: "Has a concurrency group.",
    concurrency: { key: (input) => input.group ?? null, limit: 2 },
    steps: { "only-step": { title: "Only step", description: "Runs." } },
    run: (ctx) => ctx.step("only-step", () => null),
  });
  assert.equal(definition.concurrency?.limit, 2);
});
