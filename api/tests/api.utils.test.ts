import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowLabels } from "../src/api.types.ts";
import { stepLabel, titleFromName, toJson, workflowLabel, type ToJson } from "../src/api.utils.ts";

// Type-level checks: these fail `pnpm typecheck`, not `pnpm test`.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Compiles only when its type argument is `true`. */
const expectType = <T extends true>(value: T) => value;

const at = new Date("2026-11-10T16:03:02.434Z");

test("dates become ISO strings, however deeply nested", () => {
  const value = {
    created_at: at,
    run: { started_at: at },
    steps: [{ finished_at: at }],
  };
  assert.deepEqual(toJson(value), {
    created_at: "2026-11-10T16:03:02.434Z",
    run: { started_at: "2026-11-10T16:03:02.434Z" },
    steps: [{ finished_at: "2026-11-10T16:03:02.434Z" }],
  });
});

test("other JSON values come back unchanged", () => {
  const value = { id: "a", count: 3, ok: true, missing: null, list: [1, 2], nested: { x: "y" } };
  assert.deepEqual(toJson(value), value);
});

test("undefined fields are dropped, like in the response", () => {
  assert.deepEqual(toJson({ a: 1, b: undefined }), { a: 1 });
});

test("the result is a copy, not the original object", () => {
  const value = { nested: { x: 1 } };
  const result = toJson(value);
  assert.notEqual(result, value);
  assert.notEqual(result.nested, value.nested);
});

test("the type turns every Date into a string and leaves the rest", () => {
  type Row = {
    id: string;
    count: number;
    created_at: Date;
    finished_at: Date | null;
    steps: { started_at: Date; output: unknown }[];
  };
  expectType<
    Equal<
      ToJson<Row>,
      {
        id: string;
        count: number;
        created_at: string;
        finished_at: string | null;
        steps: { started_at: string; output: unknown }[];
      }
    >
  >(true);
});

test("a title is made from a name: separators become spaces, first letter upper-cased", () => {
  assert.equal(titleFromName("score-risk"), "Score risk");
  assert.equal(titleFromName("post_ledger"), "Post ledger");
  assert.equal(titleFromName("greeting"), "Greeting");
  assert.equal(titleFromName("camelCase"), "CamelCase");
});

const labels: Record<string, WorkflowLabels> = {
  payment: {
    title: "Process a payment",
    description: "Takes a fake payment.",
    steps: { "score-risk": { title: "Score the risk", description: "Runs a simulation." } },
  },
};

test("a workflow's label comes from the labels when they have it", () => {
  assert.deepEqual(workflowLabel({ labels, workflow: "payment" }), {
    title: "Process a payment",
    description: "Takes a fake payment.",
  });
});

test("a workflow with no labels gets a title from its name and no description", () => {
  assert.deepEqual(workflowLabel({ labels, workflow: "bank-transfer" }), {
    title: "Bank transfer",
    description: null,
  });
  assert.deepEqual(workflowLabel({ labels: undefined, workflow: "payment" }), {
    title: "Payment",
    description: null,
  });
});

test("a step's label comes from the labels when they have it", () => {
  assert.deepEqual(stepLabel({ labels, workflow: "payment", step: "score-risk" }), {
    title: "Score the risk",
    description: "Runs a simulation.",
  });
});

test("an unknown step of a known workflow gets a title from its name", () => {
  assert.deepEqual(stepLabel({ labels, workflow: "payment", step: "post-ledger" }), {
    title: "Post ledger",
    description: null,
  });
});

test("a step of a workflow with no labels, or with labels undefined, gets a title from its name", () => {
  assert.deepEqual(stepLabel({ labels, workflow: "other", step: "score-risk" }), {
    title: "Score risk",
    description: null,
  });
  assert.deepEqual(stepLabel({ labels: undefined, workflow: "payment", step: "score-risk" }), {
    title: "Score risk",
    description: null,
  });
});
