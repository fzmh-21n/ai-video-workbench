import assert from "node:assert/strict";
import test from "node:test";

import {
  canBatchMatch,
  canBatchSubmit,
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
