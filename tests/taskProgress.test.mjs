import assert from "node:assert/strict";
import test from "node:test";

import { normalizedTaskProgress } from "../src/taskProgress.js";

test("shows completed tasks at 100 percent when the relay omits progress", () => {
  assert.equal(normalizedTaskProgress("completed", undefined), 100);
  assert.equal(normalizedTaskProgress("completed", 0), 100);
});

test("keeps active task progress within the visible range", () => {
  assert.equal(normalizedTaskProgress("processing", 62), 62);
  assert.equal(normalizedTaskProgress("queued", undefined), 0);
  assert.equal(normalizedTaskProgress("processing", 140), 100);
  assert.equal(normalizedTaskProgress("processing", -10), 0);
});
