import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function effectContaining(marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, marker);
  const start = source.lastIndexOf("  useEffect(", markerIndex);
  const closingLine = source.indexOf("\n  }, [", markerIndex);
  return source.slice(start, source.indexOf("\n", closingLine + 1));
}

function folderFunctions() {
  const start = source.indexOf("  function selectProjectFolder(");
  const end = source.indexOf("  async function applyProjectReferencePlan(", start);
  assert.ok(start >= 0 && end > start, "real project-folder handlers must be present");
  return source.slice(start, end);
}

function harness(overrides = {}) {
  const state = { assets: [], name: "", handle: null, needsPermission: false, loading: false, notices: [], saved: [], removed: [], reads: [], events: [], inputClicks: 0 };
  let cleanup;
  const assign = (field) => (value) => {
    state[field] = typeof value === "function" ? value(state[field]) : value;
    state.events.push([field, state[field]]);
  };
  const context = vm.createContext({
    activeTaskProject: "项目A",
    activeTaskProjectRef: { current: "项目A" },
    projectFolderInitialProjectRef: { current: "项目A" },
    projectFolderLoadRef: { current: 0 },
    projectFolderTargetRef: { current: "项目A" },
    projectFolderInput: { current: { click() { state.inputClicks += 1; } } },
    projectFolderLoading: false,
    projectDirectoryHandle: null,
    setProjectName: assign("name"),
    setProjectAssets: assign("assets"),
    setProjectDirectoryHandle: assign("handle"),
    setProjectNeedsPermission: assign("needsPermission"),
    setProjectFolderLoading: (value) => { state.loading = value; context.projectFolderLoading = value; },
    setNotice: (value) => state.notices.push(value),
    kindFromFile: (file) => /\.png$/i.test(file.name) ? "image" : null,
    fileStem: (name) => name.replace(/\.[^.]+$/, ""),
    loadTaskProjectDirectory: async (projectName, options) => {
      state.reads.push({ projectName, options });
      return { name: `${projectName}素材` };
    },
    saveTaskProjectDirectory: async (projectName, handle) => state.saved.push({ projectName, handle }),
    removeTaskProjectDirectory: async (projectName) => state.removed.push(projectName),
    projectDirectoryPermission: async () => "granted",
    filesFromProjectDirectory: async (handle) => [{ file: { name: `${handle.name}.png`, size: 1, lastModified: 2 }, relativePath: "角色.png" }],
    window: {},
    useEffect: (callback) => { cleanup = callback(); },
    ...overrides,
  });
  vm.runInContext(folderFunctions(), context);
  return {
    state, context,
    effect(projectName = context.activeTaskProject) {
      cleanup?.();
      context.activeTaskProject = projectName;
      context.activeTaskProjectRef.current = projectName;
      vm.runInContext(effectContaining("await loadTaskProjectDirectory("), context);
    },
    cleanup: () => cleanup?.(),
  };
}

test("startup restores only the active task project's saved directory and keeps legacy migration scoped", async () => {
  const flow = harness();
  flow.effect();
  await settle();
  assert.equal(flow.state.reads[0].projectName, "项目A");
  assert.equal(flow.state.reads[0].options.migrateLegacy, true);
  assert.equal(flow.state.name, "项目A素材");
  assert.equal(flow.state.assets.length, 1);
  assert.equal(flow.state.saved.length, 0, "restore must not overwrite the saved binding");
  flow.effect("项目B");
  await settle();
  assert.equal(flow.state.reads[1].projectName, "项目B");
  assert.equal(flow.state.reads[1].options.migrateLegacy, false);
  assert.equal(flow.state.name, "项目B素材");
});

test("switching to an unbound project clears the previous directory instead of inheriting it", async () => {
  const flow = harness({ loadTaskProjectDirectory: async (name) => name === "项目A" ? { name: "A素材" } : null });
  flow.effect();
  await settle();
  assert.equal(flow.state.assets.length, 1);
  flow.effect("新项目");
  await settle();
  assert.equal(flow.state.assets.length, 0);
  assert.equal(flow.state.name, "");
  assert.equal(flow.state.handle, null);
  assert.equal(flow.state.needsPermission, false);
});

test("a slow directory lookup from a former project cannot overwrite the new project", async () => {
  const slow = deferred();
  const flow = harness({ loadTaskProjectDirectory: async (name) => name === "项目A" ? slow.promise : { name: "B素材" } });
  flow.effect();
  flow.effect("项目B");
  await settle();
  slow.resolve({ name: "旧A素材" });
  await settle();
  assert.equal(flow.state.name, "B素材");
  assert.equal(flow.state.assets[0].file.name, "B素材.png");
});

test("a stale permission response does not mutate a different project's folder state", async () => {
  const permission = deferred();
  const flow = harness({ projectDirectoryPermission: async () => permission.promise });
  let current = true;
  const opening = flow.context.openRememberedProject({ name: "A素材" }, false, () => current);
  current = false;
  permission.resolve("prompt");
  await opening;
  assert.deepEqual(flow.state.events, []);
  assert.equal(flow.state.notices.length, 0);
});

test("a slow recursive folder scan does not restore old assets after a project switch", async () => {
  const scan = deferred();
  const flow = harness({ filesFromProjectDirectory: async () => scan.promise });
  let current = true;
  const opening = flow.context.openRememberedProject({ name: "A素材" }, false, () => current);
  await settle();
  current = false;
  flow.state.name = "B素材";
  flow.state.assets = [{ file: { name: "B.png" } }];
  scan.resolve([{ file: { name: "A.png", size: 1, lastModified: 2 }, relativePath: "A.png" }]);
  await opening;
  assert.equal(flow.state.name, "B素材");
  assert.equal(flow.state.assets[0].file.name, "B.png");
});

test("choosing a directory saves its binding under the initiating task project", async () => {
  const handle = { name: "手选素材" };
  const flow = harness({ window: { showDirectoryPicker: async () => handle } });
  await flow.context.chooseProjectFolder();
  assert.equal(flow.state.saved.length, 1);
  assert.equal(flow.state.saved[0].projectName, "项目A");
  assert.equal(flow.state.saved[0].handle, handle);
  assert.equal(flow.state.name, "手选素材");
});

test("a picker finishing after switching projects cannot replace the new project's folder", async () => {
  const picker = deferred();
  const handle = { name: "A手选素材" };
  const flow = harness({ window: { showDirectoryPicker: async () => picker.promise } });
  const choosing = flow.context.chooseProjectFolder();
  flow.effect("项目B");
  await settle();
  picker.resolve(handle);
  await choosing;
  assert.equal(flow.state.name, "项目B素材");
  assert.ok(flow.state.saved.every((entry) => entry.projectName === "项目A"));
});

test("canceling folder selection or receiving an empty fallback selection preserves the current folder", async () => {
  const flow = harness({ window: { showDirectoryPicker: async () => { throw Object.assign(new Error("cancel"), { name: "AbortError" }); } } });
  flow.state.name = "原素材";
  flow.state.assets = [{ file: { name: "原图.png" } }];
  await flow.context.chooseProjectFolder();
  flow.context.selectProjectFolder([]);
  assert.equal(flow.state.name, "原素材");
  assert.equal(flow.state.assets[0].file.name, "原图.png");
  assert.equal(flow.state.saved.length, 0);
  assert.equal(flow.state.notices.length, 0);
});

test("saved directory without permission keeps its identity and requests restoration without exposing former assets", async () => {
  const flow = harness({ projectDirectoryPermission: async () => "prompt" });
  flow.state.assets = [{ file: { name: "old.png" } }];
  flow.effect();
  await settle();
  assert.equal(flow.state.name, "项目A素材");
  assert.equal(flow.state.assets.length, 0);
  assert.equal(flow.state.needsPermission, true);
  assert.equal(flow.state.loading, false);
  assert.match(flow.state.notices[0], /恢复项目/);
});

test("restoring permissions reads the bound handle without choosing or changing a directory", async () => {
  const requests = [];
  const handle = { name: "已绑定目录" };
  const flow = harness({ projectDirectoryHandle: handle, projectDirectoryPermission: async (value, request) => { requests.push([value, request]); return "granted"; } });
  await flow.context.restoreProjectFolder();
  assert.deepEqual(requests, [[handle, true]]);
  assert.equal(flow.state.name, "已绑定目录");
  assert.equal(flow.state.saved.length, 0);
  assert.equal(flow.state.loading, false);
});

test("failed directory persistence leaves the displayed selection unchanged", async () => {
  const flow = harness({ window: { showDirectoryPicker: async () => ({ name: "新目录" }) }, saveTaskProjectDirectory: async () => { throw new Error("storage full"); } });
  flow.state.name = "原目录";
  flow.state.assets = [{ file: { name: "original.png" } }];
  await flow.context.chooseProjectFolder();
  assert.equal(flow.state.name, "原目录");
  assert.equal(flow.state.assets[0].file.name, "original.png");
  assert.equal(flow.state.loading, false);
  assert.match(flow.state.notices[0], /storage full/);
});

test("fallback replacement forgets the old persistent handle and explicitly warns that this browser cannot remember permissions", async () => {
  const flow = harness();
  await flow.context.chooseProjectFolder();
  assert.equal(flow.state.inputClicks, 1);
  await flow.context.selectLegacyProjectFolder([{ name: "new.png", webkitRelativePath: "新目录/new.png", size: 1, lastModified: 2 }]);
  assert.deepEqual(flow.state.removed, ["项目A"]);
  assert.equal(flow.state.name, "新目录");
  assert.equal(flow.state.handle, null);
  assert.match(flow.state.notices.at(-1), /需重新选择/);
});

test("a fallback selection for a previous project cannot cancel or overwrite the new project's pending scan", async () => {
  const lookup = deferred();
  const flow = harness({ loadTaskProjectDirectory: async () => lookup.promise });
  await flow.context.chooseProjectFolder();
  flow.effect("项目B");
  const version = flow.context.projectFolderLoadRef.current;
  await flow.context.selectLegacyProjectFolder([{ name: "old.png", size: 1, lastModified: 2 }]);
  assert.equal(flow.context.projectFolderLoadRef.current, version);
  assert.equal(flow.state.loading, true);
  lookup.resolve({ name: "B目录" });
  await settle();
  assert.equal(flow.state.name, "B目录");
  assert.equal(flow.state.loading, false);
});
