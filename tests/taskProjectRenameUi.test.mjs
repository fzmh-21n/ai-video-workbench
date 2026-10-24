import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import * as costs from "../src/costAnalytics.js";
import * as projects from "../src/taskProjects.js";

const source = readFileSync(new URL("../src/TaskProjectManager.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const renameSource = source.slice(source.indexOf("  async function renameProject("), source.indexOf("  function toggleModels("));

function renameFixture(overrides = {}) {
  const calls = [];
  const state = {
    tasks: [{ id: "a", projectName: "原项目", status: "completed", cost: 3, downloadedAtMs: 100 }, { id: "b", projectName: "其他项目" }],
    historyProject: "原项目", expandedModels: ["原项目", "其他项目"], error: "旧错误",
    renamingProject: "", movingHistory: false, deletingProject: "", mutationBusy: false,
    UNCLASSIFIED_PROJECT: projects.UNCLASSIFIED_PROJECT,
    window: { prompt: (message, initial) => { calls.push(["prompt", message, initial]); return " 新项目 "; } },
    onRename: async (before, after) => { calls.push(["rename", before, after]); },
    ...overrides,
  };
  for (const key of ["tasks", "historyProject", "expandedModels", "error", "renamingProject"]) {
    state[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value) => {
      state[key] = typeof value === "function" ? value(state[key]) : value;
    };
  }
  const context = vm.createContext(state);
  vm.runInContext(renameSource, context);
  return { state, calls, rename: (name = "原项目") => context.renameProject(name) };
}

test("project rename UI waits for persistence before moving local task, history and expanded-model state", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const f = renameFixture({ onRename: () => pending });
  const originalTasks = f.state.tasks;
  const promise = f.rename();
  assert.equal(f.state.renamingProject, "原项目");
  assert.equal(f.state.tasks, originalTasks);
  assert.equal(f.state.historyProject, "原项目");
  assert.equal(f.state.error, "");
  await f.rename();
  assert.equal(f.calls.length, 1, "pending rename cannot open a second prompt");
  finish();
  await promise;
  assert.equal(f.state.tasks[0].projectName, "新项目");
  assert.equal(f.state.tasks[0].cost, 3);
  assert.equal(f.state.tasks[0].downloadedAtMs, 100);
  assert.equal(f.state.tasks[1], originalTasks[1]);
  assert.equal(originalTasks[0].projectName, "原项目");
  assert.equal(f.state.historyProject, "新项目");
  assert.deepEqual(Array.from(f.state.expandedModels), ["新项目", "其他项目"]);
  assert.equal(f.state.renamingProject, "");
});

test("project rename prompts with the old name and sends a trimmed new name", async () => {
  const f = renameFixture({ historyProject: "其他项目" });
  await f.rename();
  assert.deepEqual(f.calls, [["prompt", "输入新的项目名称", "原项目"], ["rename", "原项目", "新项目"]]);
  assert.equal(f.state.historyProject, "其他项目");
});

test("cancelled, unchanged and empty project names never call persistence", async () => {
  for (const entered of [null, " 原项目 ", "  "]) {
    const f = renameFixture({ window: { prompt: () => entered } });
    const original = f.state.tasks;
    await f.rename();
    assert.equal(f.calls.length, 0);
    assert.equal(f.state.tasks, original);
    assert.equal(f.state.renamingProject, "");
    if (entered === "  ") assert.match(f.state.error, /请输入项目名称/);
  }
});

test("a failed rename leaves all records and local selections intact and releases the pending state", async () => {
  const f = renameFixture({ onRename: async () => { throw new Error("保存失败"); } });
  const tasks = f.state.tasks;
  const expanded = f.state.expandedModels;
  await f.rename();
  assert.equal(f.state.tasks, tasks);
  assert.equal(f.state.expandedModels, expanded);
  assert.equal(f.state.historyProject, "原项目");
  assert.equal(f.state.error, "保存失败");
  assert.equal(f.state.renamingProject, "");
});

test("busy mutations and the unclassified system project cannot start renaming", async () => {
  for (const busy of [{ mutationBusy: true }, { renamingProject: "其他项目" }, { movingHistory: true }, { deletingProject: "其他项目" }, { onRename: undefined }]) {
    const f = renameFixture(busy);
    await f.rename();
    assert.equal(f.calls.length, 0);
  }
  const f = renameFixture();
  await f.rename(projects.UNCLASSIFIED_PROJECT);
  assert.equal(f.calls.length, 0);
});

test("create, delete and history regroup handlers do not run while a project is being renamed", async () => {
  const calls = [];
  const state = vm.createContext({
    renamingProject: "原项目", onCreate: () => calls.push("create"), onDelete: () => calls.push("delete"),
    window: { confirm: () => { calls.push("confirm"); return true; } },
  });
  vm.runInContext(source.slice(source.indexOf("  function createProject("), source.indexOf("  async function renameProject(")), state);
  state.createProject({ preventDefault: () => calls.push("preventDefault") });
  await state.moveHistory();
  await state.deleteProject("其他项目");
  assert.deepEqual(calls, ["preventDefault"]);
});

const renderSource = source.replace(/^import[\s\S]*?;\n/gm, "")
  .replace("export default function TaskProjectManager", "function TaskProjectManager")
  .replace("const [tasks, setTasks] = useState([])", "const [tasks, setTasks] = useState(fixture.tasks)")
  .replace("const [loading, setLoading] = useState(true)", "const [loading, setLoading] = useState(false)")
  .replace('const [renamingProject, setRenamingProject] = useState("")', 'const [renamingProject, setRenamingProject] = useState(fixture.renamingProject || "")');

test("project management renders rename buttons for current and other projects but never for unclassified", async () => {
  const transformed = await transformWithOxc(renderSource, "TaskProjectManager.jsx", { jsx: { runtime: "classic" } });
  const render = (changes = {}, fixtureChanges = {}) => {
    const context = vm.createContext({
      React, ...costs, ...projects, loadCostSettings: () => ({}),
      fixture: { tasks: [{ id: "a", projectName: "原项目", status: "completed", createdAtMs: 100 }, { id: "b", projectName: "其他项目", status: "failed", createdAtMs: 200 }], ...fixtureChanges },
      useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
      useMemo: (callback) => callback(), useEffect: () => {},
    });
    vm.runInContext(transformed.code, context);
    return renderToStaticMarkup(context.TaskProjectManager({ activeProject: "原项目", projects: ["原项目", "其他项目"], projectCreatedAtByName: {}, onRename: () => {}, ...changes }));
  };
  const articles = (html) => Array.from(html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g), ([card]) => card);
  const buttons = (html) => Array.from(html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g), ([button]) => button);
  const html = render();
  const cards = articles(html);
  for (const projectName of ["原项目", "其他项目"]) {
    const card = cards.find((value) => value.includes(`<strong>${projectName}</strong>`));
    assert.ok(card);
    const rename = buttons(card).find((value) => value.endsWith(">重命名</button>"));
    assert.ok(rename);
    assert.ok(!rename.includes("disabled"));
  }
  assert.ok(!cards.find((value) => value.includes("<strong>未归类</strong>")).includes(">重命名</button>"));
  const disabled = buttons(render({ mutationBusy: true })).filter((value) => value.endsWith(">重命名</button>"));
  assert.equal(disabled.length, 2);
  assert.ok(disabled.every((value) => value.includes('disabled=""') && value.includes("任务正在提交、下载或自动重试")));
  const pending = render({}, { renamingProject: "原项目" });
  for (const text of ["＋ 新建并使用", "切换到此项目", "删除项目", "归入目标项目", "重命名中…", "重命名"]) {
    const matching = buttons(pending).filter((value) => value.endsWith(`>${text}</button>`));
    assert.ok(matching.length, text);
    assert.ok(matching.every((value) => value.includes('disabled=""')), text);
  }
  assert.match(pending, /<input[^>]+placeholder="输入新剧本或项目名称"[^>]+disabled=""/);
  assert.match(pending, /<select[^>]+aria-label="历史任务目标项目"[^>]+disabled=""/);
});
