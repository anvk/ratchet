import assert from "node:assert/strict";
import { test } from "node:test";
import { describeWorkflow } from "../describeWorkflow.ts";

const first = async () => ({ ok: true });
const second = async () => ({ ok: false });

const { definition, labels } = describeWorkflow<{ name: string }>({
  name: "demo",
  title: "Run a demo",
  description: "Shows the labels.",
  steps: [
    { name: "first-step", title: "First step", description: "Goes first.", run: first },
    { name: "second-step", title: "Second step", description: "Goes second.", run: second },
  ],
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

test("the definition keeps the name, the steps' order and their run functions", () => {
  assert.equal(definition.name, "demo");
  assert.deepEqual(
    definition.steps.map((step) => step.name),
    ["first-step", "second-step"],
  );
  assert.deepEqual(
    Object.values(definition.steps)
      .map(Object.values)
      .flat()
      .filter((v) => typeof v === "function"),
    [first, second],
  );
});
