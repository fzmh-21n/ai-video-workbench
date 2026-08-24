import assert from "node:assert/strict";
import test from "node:test";

import { regeneratedTaskRecord, reviewedTask } from "../src/taskRegeneration.js";

test("marks and clears dissatisfaction without changing the completed result", () => {
  const task = { id: "task-1", status: "completed", videoUrl: "https://example.com/old.mp4" };
  const marked = reviewedTask(task, true, 1234);
  assert.equal(marked.reviewStatus, "dissatisfied");
  assert.equal(marked.reviewedAtMs, 1234);
  assert.equal(marked.status, "completed");
  assert.equal(marked.videoUrl, task.videoUrl);

  const cleared = reviewedTask(marked, false, 5678);
  assert.equal(cleared.reviewStatus, undefined);
  assert.equal(cleared.reviewedAtMs, undefined);
  assert.equal(cleared.videoUrl, task.videoUrl);
});

test("creates a linked single regeneration task with the original model", () => {
  const record = regeneratedTaskRecord({
    sourceTask: { id: "old-1", title: "镜头一", projectName: "彩票", profileId: "p1" },
    createdTask: { id: "new-1", status: "queued" },
    profile: { id: "p1", name: "即梦" },
    model: "seedance-2.0",
    prompt: "原提示词",
    reuseSnapshot: { quantity: 1 },
    diagnosticRequestId: "req-1",
    createdAtMs: 2000,
    nextPollAt: 3000,
  });
  assert.equal(record.retryOfTaskId, "old-1");
  assert.equal(record.retryAttempt, 1);
  assert.equal(record.model, "seedance-2.0");
  assert.equal(record.projectName, "彩票");
  assert.equal(record.title, "镜头一-重生成1");
});

test("keeps a regenerated batch task in its original batch and chapter", () => {
  const record = regeneratedTaskRecord({
    sourceTask: {
      id: "old-batch",
      title: "第3节",
      batchId: "batch-1",
      batchTitle: "第一批",
      batchSection: 3,
      batchOrder: 30,
      retryAttempt: 1,
    },
    createdTask: { id: "new-batch", status: "queued" },
    profile: { id: "p2", name: "火山" },
    model: "seedance-2.5",
    prompt: "原提示词",
    reuseSnapshot: { quantity: 1 },
    diagnosticRequestId: "req-2",
    createdAtMs: 4000,
    nextPollAt: 5000,
  });
  assert.equal(record.batchId, "batch-1");
  assert.equal(record.batchTitle, "第一批");
  assert.equal(record.batchSection, 3);
  assert.equal(record.retryOfTaskId, "old-batch");
  assert.equal(record.retryAttempt, 2);
  assert.ok(record.batchOrder > 30);
  assert.equal(record.title, "第3节-重生成2");
});

test("uses the source model for single and batch tasks on both Seedance versions", () => {
  for (const model of ["seedance-2.0", "seedance-2.5"]) {
    for (const mode of ["single", "batch"]) {
      const batchFields = mode === "batch"
        ? { batchId: `batch-${model}`, batchTitle: "测试批次", batchSection: 1, batchOrder: 10 }
        : {};
      const record = regeneratedTaskRecord({
        sourceTask: { id: `${mode}-${model}`, title: "测试任务", ...batchFields },
        createdTask: { id: `new-${mode}-${model}`, status: "queued" },
        profile: { id: "profile", name: "测试中转" },
        model,
        prompt: "原提示词",
        reuseSnapshot: { quantity: 1 },
        diagnosticRequestId: "request",
        createdAtMs: 1,
        nextPollAt: 2,
      });
      assert.equal(record.model, model);
      assert.equal(Boolean(record.batchId), mode === "batch");
    }
  }
});
