import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { mergeSubmissionRecord, submissionRecord } from "../src/submissionRecords.js";
import { taskDatabase } from "./helpers/taskDatabase.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(tasks, { failUpdateAt = 0, synchronousUpdateFailure = false, failCursorAt = 0 } = {}) {
  const { database, stats } = taskDatabase(tasks, { failUpdateAt, synchronousUpdateFailure, failCursorAt, errorMessage: "模拟项目改名写入失败" });
  const context = vm.createContext({ Promise, Date, String, Number, Map, Set, Error, mergeSubmissionRecord, submissionRecord, IDBKeyRange: { only: (value) => value } });
  const source = readFileSync(new URL("../src/taskStore.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
  vm.runInContext(source, context);
  context.databaseFixture = database;
  vm.runInContext("databasePromise = Promise.resolve(databaseFixture)", context);
  return { context, stats };
}

test("project rename atomically moves queued, completed, failed and archived records without changing any other field", async () => {
  const tasks = ["queued", "processing", "completed", "failed"].map((status, index) => ({
    id: `task-${index}`, status, projectName: "旧项目", createdAtMs: 100, updatedAtMs: 200,
    completedAt: "原完成时间", cost: 3, usage: { credits: 300 }, downloadedAtMs: 300,
    ...(status === "failed" ? { archivedAtMs: 250 } : {}),
  }));
  tasks.push({ id: "other", status: "processing", projectName: "其他项目", updatedAtMs: 999 });
  const { context, stats } = harness(tasks);
  const count = await context.renameTaskProjectRecords("旧项目", "新项目");
  assert.equal(count, 4);
  assert.equal(stats.commits, 1, "the promise resolves only after the readwrite transaction commits");
  assert.deepEqual(plain(await context.allTasks()), tasks.map((task) => task.projectName === "旧项目" ? { ...task, projectName: "新项目" } : task));
  assert.deepEqual(stats.indexReads, [
    { store: "tasks", name: "projectName", key: "旧项目" },
    { store: "submission_records", name: "projectName", key: "旧项目" },
  ]);
  assert.equal(stats.puts, 0, "rename uses live cursor records instead of rewriting snapshots with putTasks");
  assert.equal(stats.modes[0], "readwrite");
});

test("project rename validates blank and system-reserved names before opening the database", async () => {
  const { context, stats } = harness([]);
  for (const [oldName, newName] of [["", "新项目"], ["旧项目", "  "], ["未归类", "新项目"], ["旧项目", "未归类"]]) {
    await assert.rejects(context.renameTaskProjectRecords(oldName, newName), /名称|未归类/);
  }
  assert.equal(await context.renameTaskProjectRecords(" 项目 ", "项目"), 0);
  assert.deepEqual(stats.modes, []);
});

test("a project with no task records still commits a harmless rename and returns zero", async () => {
  const { context, stats } = harness([{ id: "other", projectName: "其他项目", status: "completed" }]);
  assert.equal(await context.renameTaskProjectRecords("旧项目", "新项目"), 0);
  assert.equal(stats.commits, 1);
  assert.equal(stats.updates, 0);
});

test("asynchronous and synchronous cursor update failures roll back all earlier renamed records", async () => {
  const tasks = [1, 2, 3].map((id) => ({ id, status: "completed", projectName: "旧项目", cost: id }));
  for (const synchronousUpdateFailure of [false, true]) {
    const { context, stats } = harness(tasks, { failUpdateAt: 2, synchronousUpdateFailure });
    await assert.rejects(context.renameTaskProjectRecords("旧项目", "新项目"), /模拟项目改名写入失败/);
    assert.equal(stats.commits, 0);
    assert.equal(stats.aborts, 1);
    assert.deepEqual(plain(await context.allTasks()), tasks);
  }
});

test("cursor read failure rolls back records already renamed in the same transaction", async () => {
  const tasks = [1, 2, 3].map((id) => ({ id, status: "queued", projectName: "旧项目" }));
  const { context, stats } = harness(tasks, { failCursorAt: 2 });
  await assert.rejects(context.renameTaskProjectRecords("旧项目", "新项目"), /模拟项目游标读取失败/);
  assert.equal(stats.commits, 0);
  assert.equal(stats.aborts, 1);
  assert.deepEqual(plain(await context.allTasks()), tasks);
});

test("late polling updates cannot restore the project's old name after a rename", async () => {
  const task = { id: "processing", projectName: "旧项目", status: "processing", createdAtMs: 100, title: "原标题", cost: 3 };
  const { context } = harness([task]);
  await context.renameTaskProjectRecords("旧项目", "新项目");
  await context.putPolledTaskUpdates([{ id: task.id, projectName: "旧项目", status: "completed", progress: 100 }]);
  const stored = (await context.allTasks())[0];
  assert.equal(stored.projectName, "新项目");
  assert.equal(stored.status, "completed");
  assert.equal(stored.title, "原标题");
  assert.equal(stored.cost, 3);
});
