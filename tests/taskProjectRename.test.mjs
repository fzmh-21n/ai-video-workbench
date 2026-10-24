import assert from "node:assert/strict";
import test from "node:test";
import { persistTaskProjectRename, taskProjectRenamePlan } from "../src/taskProjectRename.js";
import { ACTIVE_TASK_PROJECT_KEY, TASK_PROJECT_CREATED_AT_KEY, TASK_PROJECT_RATIOS_KEY, TASK_PROJECTS_KEY, taskProjectNamesByCreation, UNCLASSIFIED_PROJECT } from "../src/taskProjects.js";
import { TASK_PROJECT_FIXED_CONTENT_KEY } from "../src/fixedContentStore.js";

const keys = [TASK_PROJECTS_KEY, ACTIVE_TASK_PROJECT_KEY, TASK_PROJECT_CREATED_AT_KEY, TASK_PROJECT_RATIOS_KEY, TASK_PROJECT_FIXED_CONTENT_KEY];
const base = (changes = {}) => ({
  projects: ["早期项目", "原项目", "近期项目"], activeProject: "原项目",
  createdAtByName: { 早期项目: 100, 原项目: 200, 近期项目: 300 },
  ratios: { 原项目: "9:16", 近期项目: "16:9" },
  fixedContent: { 原项目: "template-a", 近期项目: "template-b" }, ...changes,
});

function storageFixture(initial = {}, options = {}) {
  const values = new Map(Object.entries(initial));
  let writes = 0;
  let failed = false;
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      writes += 1;
      if (!failed && writes === options.failWrite) { failed = true; throw new Error("存储已满"); }
      if (failed && options.failRestore && key === TASK_PROJECTS_KEY) throw new Error("恢复失败");
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
  };
}

test("renaming active and inactive projects keeps their original creation order and per-project settings", () => {
  for (const activeProject of ["原项目", "近期项目"]) {
    const state = base({ activeProject });
    const snapshot = structuredClone(state);
    const plan = taskProjectRenamePlan(state, " 原项目 ", " 新名字 ");
    assert.deepEqual(plan.projects, ["早期项目", "新名字", "近期项目"]);
    assert.equal(plan.activeProject, activeProject === "原项目" ? "新名字" : activeProject);
    assert.deepEqual(plan.createdAtByName, { 早期项目: 100, 新名字: 200, 近期项目: 300 });
    assert.deepEqual(plan.ratios, { 新名字: "9:16", 近期项目: "16:9" });
    assert.deepEqual(plan.fixedContent, { 新名字: "template-a", 近期项目: "template-b" });
    assert.deepEqual(state, snapshot, "planning cannot modify the original state");
  }
});

test("a history-only project stays in the history-created ordering instead of becoming a newly created project", () => {
  const state = base({ projects: ["早期项目", "近期项目"], activeProject: "近期项目" });
  const history = [{ projectName: "原项目", createdAtMs: 200 }, { projectName: "其他历史", createdAtMs: 250 }];
  const before = taskProjectNamesByCreation(state.projects, history);
  const plan = taskProjectRenamePlan(state, "原项目", "新名字", ["原项目", "其他历史"]);
  assert.deepEqual(plan.projects, ["早期项目", "近期项目"]);
  const after = taskProjectNamesByCreation(plan.projects, history.map((task) => task.projectName === "原项目" ? { ...task, projectName: "新名字" } : task));
  assert.deepEqual(after, before.map((name) => name === "原项目" ? "新名字" : name));
  assert.equal(plan.createdAtByName.新名字, 200);
});

test("rename rejects duplicate DB-only names, missing originals and reserved names without merging projects", () => {
  assert.equal(taskProjectRenamePlan(base(), "原项目", " 原项目 "), null);
  assert.throws(() => taskProjectRenamePlan(base(), "原项目", "只在任务里", ["只在任务里"]), /同名项目/);
  assert.throws(() => taskProjectRenamePlan(base(), "不存在", "新名字"), /原项目不存在/);
  for (const original of ["", " ", UNCLASSIFIED_PROJECT, "all"]) {
    assert.throws(() => taskProjectRenamePlan(base(), original, "新名字"), /系统项目/);
  }
  for (const next of [UNCLASSIFIED_PROJECT, "all"]) {
    assert.throws(() => taskProjectRenamePlan(base(), "原项目", next), /系统保留名称/);
  }
  for (const next of ["", "   "]) assert.throws(() => taskProjectRenamePlan(base(), "原项目", next), /填写新的项目名称/);
});

test("persisting rename saves all five settings before renaming records and returns their count", async () => {
  const storage = storageFixture({ unrelated: "untouched" });
  const plan = taskProjectRenamePlan(base(), "原项目", "新名字");
  let called = false;
  const result = await persistTaskProjectRename(plan, async (from, to) => {
    called = true;
    assert.deepEqual([from, to], ["原项目", "新名字"]);
    assert.deepEqual(JSON.parse(storage.getItem(TASK_PROJECTS_KEY)), plan.projects);
    assert.equal(storage.getItem(ACTIVE_TASK_PROJECT_KEY), "新名字");
    assert.deepEqual(JSON.parse(storage.getItem(TASK_PROJECT_CREATED_AT_KEY)), plan.createdAtByName);
    assert.deepEqual(JSON.parse(storage.getItem(TASK_PROJECT_RATIOS_KEY)), plan.ratios);
    assert.deepEqual(JSON.parse(storage.getItem(TASK_PROJECT_FIXED_CONTENT_KEY)), plan.fixedContent);
    return 7;
  }, storage);
  assert.equal(called, true);
  assert.equal(result, 7);
  assert.equal(storage.getItem("unrelated"), "untouched");
});

test("record update failure rolls all five settings back, including previously absent settings", async () => {
  const initial = { [TASK_PROJECTS_KEY]: '["原项目"]', [ACTIVE_TASK_PROJECT_KEY]: "原项目", [TASK_PROJECT_RATIOS_KEY]: '{"原项目":"9:16"}', unrelated: "kept" };
  const storage = storageFixture(initial);
  const before = [...storage.values];
  await assert.rejects(persistTaskProjectRename(taskProjectRenamePlan(base(), "原项目", "新名字"), async () => { throw new Error("数据库写入失败"); }, storage), /数据库写入失败/);
  assert.deepEqual([...storage.values], before);
});

test("failure on any settings write restores the original keys and never starts record migration", async () => {
  for (let failWrite = 1; failWrite <= 5; failWrite += 1) {
    const initial = Object.fromEntries(keys.map((key, index) => [key, `old-value-${index}`]));
    const storage = storageFixture(initial, { failWrite });
    let recordWrites = 0;
    await assert.rejects(persistTaskProjectRename(taskProjectRenamePlan(base(), "原项目", "新名字"), async () => { recordWrites += 1; }, storage), /存储已满/);
    assert.equal(recordWrites, 0);
    assert.deepEqual(Object.fromEntries(storage.values), initial);
  }
});

test("a rollback failure is surfaced instead of claiming the rename was saved", async () => {
  const storage = storageFixture({ [TASK_PROJECTS_KEY]: "old" }, { failWrite: 2, failRestore: true });
  await assert.rejects(persistTaskProjectRename(taskProjectRenamePlan(base(), "原项目", "新名字"), async () => 1, storage), /部分设置未能恢复.*暂勿刷新.*导出备份/);
});
