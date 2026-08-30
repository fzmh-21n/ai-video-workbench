import test from "node:test";
import assert from "node:assert/strict";
import { addTaskProject, assignTasksToProject, loadActiveTaskProject, loadTaskProjects, saveTaskProjects, tasksOnOrAfter } from "../src/taskProjects.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("creates unique named task projects", () => {
  assert.deepEqual(addTaskProject(["剧本A"], " 剧本B "), ["剧本A", "剧本B"]);
  assert.throws(() => addTaskProject(["剧本A"], "剧本A"), /同名项目/);
  assert.throws(() => addTaskProject([], "未归类"), /保留名称/);
});

test("persists task projects and the active project", () => {
  const storage = memoryStorage();
  saveTaskProjects(["剧本A", "剧本A", "剧本B"], "剧本B", storage);
  assert.deepEqual(loadTaskProjects(storage), ["剧本A", "剧本B"]);
  assert.equal(loadActiveTaskProject(storage), "剧本B");
});

test("moves only selected tasks into a task project", () => {
  const tasks = [{ id: "a", projectName: "旧项目" }, { id: "b", projectName: "旧项目" }];
  const result = assignTasksToProject(tasks, ["b"], "新项目");
  assert.equal(result[0].projectName, "旧项目");
  assert.equal(result[1].projectName, "新项目");
  assert.equal(tasks[1].projectName, "旧项目");
});

test("selects tasks from an inclusive local date cutoff", () => {
  const cutoff = new Date(2026, 7, 27).getTime();
  const tasks = [
    { id: "before", createdAtMs: cutoff - 1 },
    { id: "at", createdAtMs: cutoff },
    { id: "after", createdAtMs: cutoff + 1000 },
  ];
  assert.deepEqual(tasksOnOrAfter(tasks, cutoff).map((task) => task.id), ["at", "after"]);
});
