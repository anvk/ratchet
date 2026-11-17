import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleUrl } from "../src/utils/url.ts";

test("assembleUrl returns the path unchanged without parameters", () => {
  assert.equal(assembleUrl("/runs", {}), "/runs");
});

test("assembleUrl leaves out empty parameters", () => {
  assert.equal(assembleUrl("/runs", { a: undefined, b: null, c: "" }), "/runs");
  assert.equal(
    assembleUrl("/runs", { status: "failed", cursor: undefined }),
    "/runs?status=failed",
  );
});

test("assembleUrl keeps falsy values that aren't empty", () => {
  assert.equal(assembleUrl("/runs", { limit: 0, open: false }), "/runs?limit=0&open=false");
});

test("assembleUrl keeps parameters in the order given", () => {
  assert.equal(
    assembleUrl("/runs", { status: "running", limit: 5 }),
    "/runs?status=running&limit=5",
  );
});

test("assembleUrl encodes values", () => {
  assert.equal(assembleUrl("/search", { q: "a&b c" }), "/search?q=a%26b+c");
});
