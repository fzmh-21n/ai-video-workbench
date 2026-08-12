import assert from "node:assert/strict";
import test from "node:test";

import {
  canBatchMatch,
  canBatchSubmit,
  parseRecoveredTaskIds,
  runOrderedStaggered,
  runWithConcurrency,
  splitBatchPrompts,
} from "../src/batchPrompts.js";

test("splits numbered Chinese prompt sections without splitting SC markers", () => {
  const items = splitBatchPrompts(`3.（第三节，总时长15秒 / 共3镜）\n【本节出场的所有人物】\n001_甲\n镜头1 / SC1\n内容\n\n4.（第四节，总时长15秒 / 共4镜）\n镜头1 / SC1\n内容`);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.section), [3, 4]);
  assert.match(items[0].prompt, /镜头1 \/ SC1/);
  assert.match(items[1].prompt, /^4\.（第四节/);
});

test("starts ordered-rush submissions by numeric section while keeping concurrency", async () => {
  const started = [];
  let active = 0;
  let maximum = 0;
  await runOrderedStaggered([{ section: 31 }, { section: 29 }, { section: 30 }], 3, 2, async (item) => {
    started.push(item.section);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, item.section === 29 ? 8 : 2));
    active -= 1;
  });
  assert.deepEqual(started, [29, 30, 31]);
  assert.equal(maximum, 3);
});

test("strict ordered submission never has more than one request in flight", async () => {
  const started = [];
  let active = 0;
  let maximum = 0;
  await runOrderedStaggered([{ section: 3 }, { section: 1 }, { section: 2 }], 1, 0, async (item) => {
    started.push(item.section);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
  });
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(maximum, 1);
});

test("parses MEAICC UUID and wr task IDs with optional chapter mapping", () => {
  assert.deepEqual(parseRecoveredTaskIds([
    "29=wr_a1b2-c3",
    "第30节：92f875ee-f97b-4941-b4ef-dc5f7fa60022",
  ].join("\n")), [
    { section: 29, taskId: "wr_a1b2-c3" },
    { section: 30, taskId: "92f875ee-f97b-4941-b4ef-dc5f7fa60022" },
  ]);
});

test("supports an arbitrary starting section and western parentheses", () => {
  const items = splitBatchPrompts("21.(标题一)\nA\n22.（标题二）\nB");
  assert.deepEqual(items.map((item) => item.section), [21, 22]);
});

test("runs every batch item while respecting the selected concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const completed = [];
  await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    completed.push(value);
    active -= 1;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5]);
});

test("skips active and completed chapters during later batch operations", () => {
  for (const status of ["submitting", "submitted", "generating", "generated"]) {
    assert.equal(canBatchMatch({ status }), false);
    assert.equal(canBatchSubmit({ status }), false);
  }
  assert.equal(canBatchMatch({ status: "unmatched" }), true);
  assert.equal(canBatchMatch({ status: "failed" }), true);
  assert.equal(canBatchSubmit({ status: "unmatched" }), false);
  assert.equal(canBatchSubmit({ status: "matched" }), true);
  assert.equal(canBatchSubmit({ status: "failed" }), true);
});
