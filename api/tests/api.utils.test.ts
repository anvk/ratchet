import assert from "node:assert/strict";
import { test } from "node:test";
import { toJson, type ToJson } from "../src/api.utils.ts";

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
