import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { uselessTaskBatches } from "../src/uselessBatches.js";

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("  async function deleteUselessBatches("), source.indexOf("  async function deleteBatch("));
const failed = (id, batchId = "dead", projectName = "当前") => ({ id, batchId, projectName, status: "failed" });

function harness(records, options = {}) {
  const calls = { reads: 0, confirmations: [], archives: [], notices: [], cleaning: [], uiWrites: 0 };
  const state = { tasks: records, selected: records.map((task) => task.id), expandedTask: records[0]?.id, expandedBatch: records[0]?.batchId, refresh: 0 };
  const update = (key) => (value) => { calls.uiWrites += 1; state[key] = typeof value === "function" ? value(state[key]) : value; };
  const ctx = vm.createContext({
    taskDatabaseReady: true, cleaningUseless: false, submitting: false, batchBusy: false,
    regeneratingTaskId: null, downloadingBatchId: null, taskProjectFilter: "当前", videoBlob: null,
    uselessTaskBatches,
    allTasks: async () => { calls.reads += 1; return records; },
    archiveUselessBatches: async (ids, project) => {
      calls.archives.push({ ids: Array.from(ids), project });
      if (options.archiveError) throw options.archiveError;
      return options.result || { taskIds: records.filter((task) => ids.includes(task.batchId)).map((task) => task.id), batchCount: ids.length };
    },
    window: { confirm: (message) => { calls.confirmations.push(message); return options.confirm !== false; } },
    setCleaningUseless: (value) => calls.cleaning.push(value),
    setNotice: (value) => calls.notices.push(value),
    setTasks: update("tasks"), setSelectedTaskIds: update("selected"), setExpandedTaskId: update("expandedTask"),
    setExpandedBatchId: update("expandedBatch"), setTaskRefreshVersion: update("refresh"), setVideoBlob: update("video"),
    ...(options.context || {}),
  });
  vm.runInContext(handler, ctx);
  return { calls, state, run: () => ctx.deleteUselessBatches() };
}

test("cleanup uses the complete database, not the visible failed filter or search results", async () => {
  const h = harness([failed("visible-failure", "mixed"), { ...failed("hidden-success", "mixed"), status: "completed" }]);
  await h.run();
  assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.confirmations.length, 0);
  assert.equal(h.calls.archives.length, 0);
  assert.equal(h.calls.uiWrites, 0);
  assert.match(h.calls.notices[0], /没有整批全部失败/);
});

test("cancelled cleanup leaves the task database and UI unchanged", async () => {
  const h = harness([failed("a"), failed("b")], { confirm: false });
  await h.run();
  assert.equal(h.calls.archives.length, 0);
  assert.equal(h.calls.uiWrites, 0);
  assert.match(h.calls.confirmations[0], /项目“当前”.*1.*2/);
  assert.match(h.calls.confirmations[0], /保留历史计费记录/);
  assert.deepEqual(h.calls.cleaning, [true, false]);
});

test("a committed cleanup removes only returned IDs and reports batches skipped after confirmation", async () => {
  const h = harness([failed("a"), failed("b", "changed"), { id: "single", status: "failed" }], { result: { taskIds: ["a"], batchCount: 1 } });
  await h.run();
  assert.deepEqual(h.calls.archives, [{ ids: ["dead", "changed"], project: "当前" }]);
  assert.deepEqual(Array.from(h.state.tasks, (task) => task.id), ["b", "single"]);
  assert.deepEqual(Array.from(h.state.selected), ["b", "single"]);
  assert.equal(h.state.expandedTask, null);
  assert.equal(h.state.expandedBatch, null);
  assert.equal(h.state.refresh, 1);
  assert.match(h.calls.notices[0], /1 个全部失败批次、1 条任务.*1 个批次状态已变化/);
});

test("storage failure never removes UI records or adds hard-delete tombstones", async () => {
  const h = harness([failed("a")], { archiveError: new Error("数据库保存失败") });
  await h.run();
  assert.equal(h.calls.uiWrites, 0);
  assert.equal(h.state.tasks.length, 1);
  assert.match(h.calls.notices[0], /数据库保存失败/);
  assert.deepEqual(h.calls.cleaning, [true, false]);
  assert.doesNotMatch(handler, /rememberDeletedIds|deletedTaskIdsRef|removeStored|fetch\(/);
});

test("cleanup cannot start while generation, batch operations, download or another cleanup is running", async () => {
  for (const context of [{ taskDatabaseReady: false }, { cleaningUseless: true }, { submitting: true }, { batchBusy: true }, { regeneratingTaskId: "id" }, { downloadingBatchId: "batch" }]) {
    const h = harness([failed("a")], { context });
    await h.run();
    assert.equal(h.calls.reads, 0);
    assert.equal(h.calls.archives.length, 0);
    assert.equal(h.calls.uiWrites, 0);
  }
  assert.match(source, /onBusyChange=\{setBatchBusy\}/);
  assert.match(source, /onClick=\{deleteUselessBatches\}.*一键删除无用任务/);
});
