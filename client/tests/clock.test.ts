import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { createClock, sharedClock } from "../src/utils/clock.ts";

/** Advances fake time one interval at a time (a single big tick sets Date to the end first). */
const advance = (ms: number, step = 50) => {
  for (let t = 0; t < ms; t += step) mock.timers.tick(step);
};

beforeEach(() => mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 }));
afterEach(() => mock.timers.reset());

test("a clock starts at the current time", () => {
  assert.equal(createClock({ intervalMs: 100 }).getSnapshot(), 1_000);
});

test("subscribers hear every tick, and the snapshot moves with it", () => {
  const clock = createClock({ intervalMs: 100 });
  let heard = 0;
  clock.subscribe(() => heard++);
  advance(250);
  assert.equal(heard, 2);
  assert.equal(clock.getSnapshot(), 1_200);
});

test("all subscribers tick together", () => {
  const clock = createClock({ intervalMs: 100 });
  const seen: number[][] = [[], []];
  clock.subscribe(() => seen[0].push(clock.getSnapshot()));
  mock.timers.tick(50);
  clock.subscribe(() => seen[1].push(clock.getSnapshot()));
  advance(150);
  // The late subscriber joins the existing timer instead of starting its own.
  assert.deepEqual(seen, [
    [1_100, 1_200],
    [1_100, 1_200],
  ]);
});

test("the clock stops when the last subscriber leaves", () => {
  let reads = 0;
  const clock = createClock({ intervalMs: 100, readTime: () => ++reads });
  const stopA = clock.subscribe(() => {});
  const stopB = clock.subscribe(() => {});
  stopA();
  mock.timers.tick(100);
  const whileOneListens = reads;
  stopB();
  mock.timers.tick(1_000);
  assert.equal(reads, whileOneListens, "no ticks once nobody listens");
});

test("an idle clock catches up when someone subscribes again", () => {
  const clock = createClock({ intervalMs: 100 });
  clock.subscribe(() => {})();
  mock.timers.tick(5_000);
  clock.subscribe(() => {});
  assert.equal(clock.getSnapshot(), 6_000);
});

test("the same interval always gets the same shared clock", () => {
  assert.equal(sharedClock(100), sharedClock(100));
  assert.notEqual(sharedClock(100), sharedClock(1_000));
});
