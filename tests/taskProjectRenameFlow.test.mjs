import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { persistTaskProjectRename, taskProjectRenamePlan } from "../src/taskProjectRename.js";

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("  async function renameTaskProject("), source.indexOf("  async function deleteTaskProject("));

function fixture(options = {}) {
  const records = [
    { id: "task-a", projectName: "原项目", assetProjectName: "原资产文件夹", status: "completed", cost: 3, downloadedAtMs: 123, providerTaskId: "remote-id", createdAtMs: 100, reuseSnapshot: { projectName: "原资产文件夹", image: "原文件" } },
    { id: "task-b", projectName: "其他项目", status: "processing", cost: 1 },
  ];
  const calls = { names: 0, directory: [], records: [], notices: [], renaming: [], writes: 0 };
  const values = new Map([["unrelated", "kept"]]);
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
  const handle = { name: "本地视频目录句柄" };
  const directories = new Map([["原项目", handle]]);
  const state = {
    taskProjects: ["最早项目", "原项目", "其他项目"], activeTaskProject: "原项目",
    taskProjectCreatedAtByName: { 最早项目: 50, 原项目: 100, 其他项目: 200 },
    taskProjectRatios: { 原项目: "9:16", 其他项目: "16:9" },
    taskProjectFixedContent: { 原项目: "fixed-a", 其他项目: "fixed-b" },
    taskProjectOptions: ["all", "原项目", "原项目", "其他项目"], taskProjectFilter: "原项目", selectedTargetProject: "原项目",
    ratioProjectPrompt: { projectName: "原项目", value: "9:16", extra: "kept" },
    tasks: records, taskRefreshVersion: 0, ratio: "9:16",
    taskDatabaseReady: true, projectRenameRunningRef: { current: false }, projectFolderLoading: false, submitting: false, batchBusy: false,
    regeneratingTaskId: null, downloadingBatchId: null, cleaningUseless: false,
    ...options.state,
  };
  const set = (key) => (value) => { calls.writes += 1; state[key] = typeof value === "function" ? value(state[key]) : value; };
  const context = vm.createContext({
    ...state, taskProjectRenamePlan,
    getTaskProjectNames: async () => { calls.names += 1; return options.knownNames || ["原项目", "其他项目"]; },
    persistTaskProjectRename: (plan, renameRecords) => persistTaskProjectRename(plan, renameRecords, storage),
    renameTaskProjectDirectory: async (from, to) => {
      calls.directory.push([from, to]);
      if (options.directoryError) throw options.directoryError;
      if (!directories.has(from)) return false;
      const value = directories.get(from);
      directories.delete(from);
      directories.set(to, value);
      return true;
    },
    renameTaskProjectRecords: async (from, to) => {
      calls.records.push([from, to]);
      if (options.recordError) throw options.recordError;
      if (options.recordResult) return options.recordResult(from, to);
      return 1;
    },
    setRenamingProject: (value) => calls.renaming.push(value),
    setNotice: (value) => calls.notices.push(value),
  });
  for (const key of ["taskProjects", "activeTaskProject", "taskProjectCreatedAtByName", "taskProjectRatios", "taskProjectFixedContent", "taskProjectOptions", "taskProjectFilter", "selectedTargetProject", "ratioProjectPrompt", "tasks", "taskRefreshVersion"]) {
    context[`set${key[0].toUpperCase()}${key.slice(1)}`] = set(key);
  }
  vm.runInContext(handler, context);
  return { calls, state, records, storage, values, directories, handle, context, run: (from = "原项目", to = " 新名字 ") => context.renameTaskProject(from, to) };
}

test("App rename migrates every selected project reference after storage and preserves task billing, downloads and asset identities", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.calls.directory, [["原项目", "新名字"]]);
  assert.deepEqual(f.calls.records, [["原项目", "新名字"]]);
  assert.equal(f.directories.get("新名字"), f.handle);
  assert.equal(f.directories.has("原项目"), false);
  assert.deepEqual(Array.from(f.state.taskProjects), ["最早项目", "新名字", "其他项目"]);
  assert.equal(f.state.activeTaskProject, "新名字");
  assert.deepEqual(Array.from(f.state.taskProjectOptions), ["all", "新名字", "其他项目"]);
  assert.equal(f.state.taskProjectFilter, "新名字");
  assert.equal(f.state.selectedTargetProject, "新名字");
  assert.equal(f.state.ratioProjectPrompt.projectName, "新名字");
  assert.equal(f.state.ratioProjectPrompt.value, "9:16");
  assert.equal(f.state.ratioProjectPrompt.extra, "kept");
  assert.equal(f.state.taskProjectRatios.新名字, "9:16");
  assert.equal(f.state.taskProjectFixedContent.新名字, "fixed-a");
  assert.equal(f.state.taskProjectCreatedAtByName.新名字, 100);
  assert.equal(f.state.taskProjectCreatedAtByName.原项目, undefined);
  assert.equal(f.state.ratio, "9:16");
  assert.deepEqual({ ...f.state.tasks[0] }, { ...f.records[0], projectName: "新名字" });
  assert.equal(f.state.tasks[0].reuseSnapshot, f.records[0].reuseSnapshot);
  assert.equal(f.state.tasks[1], f.records[1]);
  assert.equal(f.state.taskRefreshVersion, 1);
  assert.deepEqual(f.calls.renaming, [true, false]);
  assert.equal(f.context.projectRenameRunningRef.current, false);
  assert.match(f.calls.notices[0], /原项目.*新名字.*1 条任务.*计费记录均保留/);
  assert.equal(f.storage.getItem("unrelated"), "kept");
});

test("renaming an inactive project preserves the current project, all-project filter and unrelated targets", async () => {
  const f = fixture({ state: { activeTaskProject: "其他项目", taskProjectFilter: "all", selectedTargetProject: "其他项目", ratioProjectPrompt: { projectName: "其他项目", value: "16:9" } } });
  await f.run();
  assert.equal(f.state.activeTaskProject, "其他项目");
  assert.equal(f.state.taskProjectFilter, "all");
  assert.equal(f.state.selectedTargetProject, "其他项目");
  assert.equal(f.state.ratioProjectPrompt.projectName, "其他项目");
  assert.equal(f.state.taskProjectRatios.其他项目, "16:9");
  assert.equal(f.state.taskProjectFixedContent.其他项目, "fixed-b");
});

test("a history-only project keeps the saved catalog order and a missing ratio prompt stays absent", async () => {
  const f = fixture({ state: { taskProjects: ["最早项目", "其他项目"], ratioProjectPrompt: null } });
  await f.run();
  assert.deepEqual(Array.from(f.state.taskProjects), ["最早项目", "其他项目"]);
  assert.equal(f.state.activeTaskProject, "新名字");
  assert.equal(f.state.ratioProjectPrompt, null);
});

test("an unchanged name and a name that exists only in task records perform no writes", async () => {
  const unchanged = fixture();
  await unchanged.run("原项目", " 原项目 ");
  assert.equal(unchanged.calls.writes, 0);
  assert.deepEqual(unchanged.calls.records, []);
  assert.deepEqual(unchanged.calls.directory, []);
  assert.equal(unchanged.values.size, 1);
  assert.deepEqual(unchanged.calls.renaming, [true, false]);
  const duplicate = fixture({ knownNames: ["原项目", "仅在数据库"] });
  await assert.rejects(duplicate.run("原项目", "仅在数据库"), /同名项目/);
  assert.equal(duplicate.calls.names, 1);
  assert.equal(duplicate.calls.writes, 0);
  assert.deepEqual(duplicate.calls.records, []);
  assert.deepEqual(duplicate.calls.directory, []);
  assert.equal(duplicate.context.projectRenameRunningRef.current, false);
});

test("directory migration failure rolls settings back and never updates database records or visible project state", async () => {
  const f = fixture({ directoryError: new Error("目录绑定保存失败") });
  const before = [...f.values];
  await assert.rejects(f.run(), /目录绑定保存失败/);
  assert.deepEqual([...f.values], before);
  assert.deepEqual(f.calls.records, []);
  assert.equal(f.calls.writes, 0);
  assert.equal(f.state.activeTaskProject, "原项目");
  assert.equal(f.directories.get("原项目"), f.handle);
  assert.equal(f.context.projectRenameRunningRef.current, false);
  assert.deepEqual(f.calls.renaming, [true, false]);
});

test("record migration failure restores the old directory binding and all settings before surfacing the error", async () => {
  const f = fixture({ recordError: new Error("事务失败") });
  const before = [...f.values];
  await assert.rejects(f.run(), /事务失败/);
  assert.deepEqual(f.calls.directory, [["原项目", "新名字"], ["新名字", "原项目"]]);
  assert.equal(f.directories.get("原项目"), f.handle);
  assert.equal(f.directories.has("新名字"), false);
  assert.deepEqual([...f.values], before);
  assert.equal(f.calls.writes, 0);
  assert.equal(f.state.tasks, f.records);
  assert.equal(f.state.taskProjectFilter, "原项目");
  assert.equal(f.state.taskRefreshVersion, 0);
  assert.equal(f.calls.notices.length, 0);
  assert.equal(f.context.projectRenameRunningRef.current, false);
});

test("a project without a directory binding can be renamed and needs no reverse-directory rollback on failure", async () => {
  for (const recordError of [undefined, new Error("事务失败")]) {
    const f = fixture({ recordError });
    f.directories.clear();
    if (recordError) await assert.rejects(f.run(), /事务失败/);
    else await f.run();
    assert.deepEqual(f.calls.directory, [["原项目", "新名字"]]);
    assert.equal(f.directories.size, 0);
    assert.equal(f.calls.records.length, 1);
    assert.equal(f.state.activeTaskProject, recordError ? "原项目" : "新名字");
  }
});

test("the rename guard blocks unfinished operations before reading project names or writing any data", async () => {
  for (const state of [{ taskDatabaseReady: false }, { projectRenameRunningRef: { current: true } }, { projectFolderLoading: true }, { submitting: true }, { batchBusy: true }, { regeneratingTaskId: "task" }, { downloadingBatchId: "batch" }, { cleaningUseless: true }]) {
    const f = fixture({ state });
    await assert.rejects(f.run(), /请等待/);
    assert.equal(f.calls.names, 0);
    assert.equal(f.calls.writes, 0);
    assert.deepEqual(f.calls.renaming, []);
    assert.deepEqual(f.calls.records, []);
    assert.deepEqual(f.calls.directory, []);
    assert.equal(f.values.size, 1);
  }
});

test("a pending database rename cannot be invoked twice and does not prematurely change visible project state", async () => {
  let finish;
  let entered;
  const recordStarted = new Promise((resolve) => { entered = resolve; });
  const completion = new Promise((resolve) => { finish = resolve; });
  const f = fixture({ recordResult: () => { entered(); return completion; } });
  const first = f.run();
  await recordStarted;
  assert.equal(f.context.projectRenameRunningRef.current, true);
  assert.equal(f.state.activeTaskProject, "原项目");
  assert.equal(f.calls.writes, 0);
  await assert.rejects(f.run(), /请等待/);
  assert.equal(f.calls.names, 1);
  assert.equal(f.calls.records.length, 1);
  finish(1);
  await first;
  assert.equal(f.state.activeTaskProject, "新名字");
  assert.equal(f.context.projectRenameRunningRef.current, false);
});
