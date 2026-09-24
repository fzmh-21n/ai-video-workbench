import assert from "node:assert/strict";
import test from "node:test";

import { MANUAL_CANCELLATION_ERROR, isTaskCancellable, manuallyCancelledTask } from "../src/taskCancellation.js";

test("manually cancels only queued or processing tasks and preserves their identity", () => {
  const processing = { id: "task-1", status: "processing", progress: 82, prompt: "原提示词", nextPollAt: 999 };
  const cancelled = manuallyCancelledTask(processing, 12345);

  assert.equal(isTaskCancellable(processing), true);
  assert.equal(cancelled.id, "task-1");
  assert.equal(cancelled.prompt, "原提示词");
  assert.equal(cancelled.status, "failed");
  assert.equal(cancelled.progress, 100);
  assert.equal(cancelled.error, MANUAL_CANCELLATION_ERROR);
  assert.equal(cancelled.cancelledByUser, true);
  assert.equal(cancelled.cancelledAtMs, 12345);
  assert.equal(cancelled.nextPollAt, null);
  assert.equal(isTaskCancellable(cancelled), false);
  assert.equal(manuallyCancelledTask({ id: "done", status: "completed" }).status, "completed");
});
