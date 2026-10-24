import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { beginBatchSubmission, reconciledBatchTerminalState, batchSerializable } from "../src/batchPrompts.js";
import { batchItemDownloadCandidates, createBatchTaskLookup, recoverBatchItemTaskIds } from "../src/taskDownload.js";
import { normalizedTaskProgress } from "../src/taskProgress.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
const context = vm.createContext({ Map, Math, batchItemDownloadCandidates, createBatchTaskLookup, recoverBatchItemTaskIds,
  reconciledBatchTerminalState, normalizedTaskProgress });
vm.runInContext(source.slice(source.indexOf("function withDownloadedFlags("), source.indexOf("function persistedState()")), context);
const oldNote = "后台未找到唯一对应任务，仍需核实；未重新提交";

test("new submission clears the previous attempt's recovery note without altering its original row", () => {
  const item = { id: "row", status: "generation_failed", recoveryNote: oldNote, taskIds: ["old-task"] };
  const next = beginBatchSubmission(item, { id: "relay", model: "model" }, 1000, "new-batch");
  assert.equal(next.recoveryNote, "");
  assert.equal(next.lastSubmission.batchId, "new-batch");
  assert.equal(item.recoveryNote, oldNote);
});

for (const status of ["generated", "generating", "failed", "matched", "submitting"]) {
  test(`stored ${status} row drops obsolete recovery note during task reconciliation`, () => {
    const item = { id: "row", status, recoveryNote: oldNote, taskIds: [], references: [], prompt: "原提示词" };
    const [updated] = context.withDownloadedFlags([item], []);
    assert.equal(updated.status, status);
    assert.equal(updated.recoveryNote, "");
    assert.equal(JSON.parse(JSON.stringify(batchSerializable([updated])))[0].recoveryNote, "");
    assert.equal(item.recoveryNote, oldNote);
  });
}

test("real unknown submission keeps its note and original submission key", () => {
  const item = { status: "submission_unknown", taskIds: [], recoveryNote: oldNote,
    lastSubmission: { idempotencyKey: "original-key" } };
  const [updated] = context.withDownloadedFlags([item], []);
  assert.equal(updated.status, "submission_unknown");
  assert.equal(updated.recoveryNote, oldNote);
  assert.equal(updated.lastSubmission.idempotencyKey, "original-key");
});

for (const taskStatus of ["completed", "processing", "failed"]) {
  test(`receiving a ${taskStatus} task clears the old note when an unknown row is reconciled`, () => {
    const item = { status: "submission_unknown", taskIds: ["real-task"], section: 5, prompt: "原提示词", recoveryNote: oldNote };
    const task = { id: "real-task", status: taskStatus, prompt: "原提示词", batchSection: 5, error: taskStatus === "failed" ? "真实失败" : "" };
    const [updated] = context.withDownloadedFlags([item], [task]);
    assert.equal(updated.status, taskStatus === "completed" ? "generated" : taskStatus === "failed" ? "generation_failed" : "generating");
    assert.equal(updated.recoveryNote, "");
    assert.deepEqual(Array.from(updated.taskIds), ["real-task"]);
    if (taskStatus === "failed") assert.equal(updated.error, "真实失败");
  });
}

test("recovery warning is rendered only for an unresolved submission", () => {
  assert.ok(/item\.status === "submission_unknown" && item\.recoveryNote && <div className="batch-issue">核对结果/.test(source));
});
