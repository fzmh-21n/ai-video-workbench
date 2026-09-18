import assert from "node:assert/strict";
import test from "node:test";

import { normalizedTaskGroupProgress, normalizedTaskProgress } from "../src/taskProgress.js";

test("shows completed tasks at 100 percent when the relay omits progress", () => {
  assert.equal(normalizedTaskProgress("completed", undefined), 100);
  assert.equal(normalizedTaskProgress("completed", 0), 100);
});

test("keeps active task progress within the visible range", () => {
  assert.equal(normalizedTaskProgress("processing", 62), 62);
  assert.equal(normalizedTaskProgress("queued", undefined), 0);
  assert.equal(normalizedTaskProgress("processing", 140), 99);
  assert.equal(normalizedTaskProgress("processing", -10), 0);
});

test("never shows a batch at 100 percent while any task is still active", () => {
  assert.equal(normalizedTaskGroupProgress([
    { status: "completed", progress: 100 },
    { status: "completed", progress: 100 },
    { status: "processing", progress: 99 },
  ]), 99);
  assert.equal(normalizedTaskGroupProgress([
    { status: "completed", progress: 100 },
    { status: "failed", progress: 100 },
  ]), 100);
});
