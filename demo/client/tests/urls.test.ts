import assert from "node:assert/strict";
import { test } from "node:test";
import { URLS } from "../src/urls.ts";

test("the runs list lives at the root", () => {
  assert.equal(URLS.runs.list(), "/");
  assert.equal(URLS.runs.list({}), "/");
});

test("the runs list can be filtered by status", () => {
  assert.equal(URLS.runs.list({ status: "failed" }), "/?status=failed");
});

test("a run's page is under /runs", () => {
  assert.equal(
    URLS.runs.details({ id: "bb9ada8a-03be-4cdd-9be6-b39daba121e2" }),
    "/runs/bb9ada8a-03be-4cdd-9be6-b39daba121e2",
  );
});

test("a run's page gives the route pattern main.tsx uses", () => {
  assert.equal(URLS.runs.details({ id: ":id" }), "/runs/:id");
});
