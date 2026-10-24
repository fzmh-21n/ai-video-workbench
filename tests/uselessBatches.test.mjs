import test from "node:test";
import assert from "node:assert/strict";
import { uselessTaskBatches, archivedUselessTask } from "../src/uselessBatches.js";
import { mergePolledTaskUpdate } from "../src/taskStore.js";
import { currentCostSummary } from "../src/costAnalytics.js";

const failed = (id, batchId = "batch", extra = {}) => ({ id, batchId, status: "failed", projectName: "当前项目", ...extra });

test("only complete all-failed batches qualify; ordinary single tasks and empty batches do not", () => {
  const tasks = Array.from({ length: 10 }, (_, index) => failed(`${index}`));
  assert.equal(uselessTaskBatches(tasks).length, 1);
  assert.equal(uselessTaskBatches(tasks)[0].tasks.length, 10);
  assert.deepEqual(uselessTaskBatches([failed("single", "")]), []);
  assert.deepEqual(uselessTaskBatches([]), []);
});

test("successful, active and unknown records exclude the entire batch even when hidden by UI filters", () => {
  for (const status of ["completed", "processing", "queued", "submission_unknown", undefined]) {
    const tasks = [failed("failed"), failed("hidden", "batch", { status })];
    assert.equal(uselessTaskBatches(tasks).length, 0);
  }
  assert.equal(uselessTaskBatches([failed("old"), failed("regenerated", "batch", { status: "completed" })]).length, 0);
});

test("project selection never deletes a batch that spans another project", () => {
  const tasks = [failed("a"), failed("b", "batch", { projectName: "另一个项目" }), failed("safe", "own")];
  assert.deepEqual(uselessTaskBatches(tasks, "当前项目").map((batch) => batch.id), ["own"]);
  assert.equal(uselessTaskBatches(tasks, "all").length, 2);
});

test("cleanup keeps accounting metadata but releases prompt and reference snapshots", () => {
  const task = failed("original", "batch", { cost: 3, usage: { credits: 300 }, createdAtMs: Date.now(), model: "model", profileId: "relay", prompt: "长提示词", reuseSnapshot: { prompt: "长提示词", references: [] } });
  const archived = archivedUselessTask(task, 123);
  assert.equal(archived.archivedAtMs, 123);
  assert.equal(archived.id, task.id);
  assert.equal(archived.cost, 3);
  assert.deepEqual(archived.usage, task.usage);
  assert.equal(archived.prompt, undefined);
  assert.equal(archived.reuseSnapshot, undefined);
  assert.deepEqual(currentCostSummary([archived], {}, "day"), currentCostSummary([task], {}, "day"));
  assert.equal(uselessTaskBatches([archived]).length, 0);
});

test("late polling cannot revive an archived batch or overwrite its billing metadata", () => {
  const archived = archivedUselessTask(failed("original", "batch", { cost: 3 }), 123);
  const next = mergePolledTaskUpdate(archived, { status: "completed", cost: 0, archivedAtMs: undefined });
  assert.equal(next.status, "failed");
  assert.equal(next.archivedAtMs, 123);
  assert.equal(next.cost, 3);
});
