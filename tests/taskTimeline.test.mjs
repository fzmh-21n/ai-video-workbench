import assert from "node:assert/strict";
import test from "node:test";

import { batchTimeline, taskTimeline } from "../src/taskTimeline.js";

test("shows submitted and generated times for a completed task", () => {
  const result = taskTimeline({
    status: "completed",
    createdAtMs: new Date(2026, 8, 17, 10, 0, 0).getTime(),
    completedAtMs: new Date(2026, 8, 17, 10, 3, 0).getTime(),
  });
  assert.match(result.submitted, /2026/);
  assert.match(result.generated, /10:03:00/);
  assert.equal(taskTimeline({ status: "processing", createdAtMs: Date.now() }).generated, "—");
});

test("uses the first submission and final completion for a completed batch", () => {
  const result = batchTimeline([
    { status: "completed", createdAtMs: 1000, completedAtMs: 4000 },
    { status: "completed", createdAtMs: 2000, completedAtMs: 5000 },
  ]);
  assert.equal(Date.parse(result.submitted), 1000);
  assert.equal(Date.parse(result.generated), 5000);
  assert.equal(batchTimeline([{ status: "completed", createdAtMs: 1000, completedAtMs: 4000 }, { status: "processing", createdAtMs: 2000 }]).generated, "—");
});
