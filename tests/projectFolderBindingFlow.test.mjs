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
  const state = { assets: [], name: "", handle: null, needsPermission: false, loading: false, folderDiagnostic: null, diagnostics: [], notices: [], saved: [], removed: [], reads: [], events: [], inputClicks: 0 };
  const timers = new Map();
  let timerId = 0;
  let now = Date.now();
  const setTimer = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; };
  const clearTimer = (id) => timers.delete(id);
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
    projectFolderPickerRef: { current: false },
    projectFolderInput: { current: { click() { state.inputClicks += 1; } } },
    projectFolderLoading: false,
    projectNeedsPermission: false,
    projectDirectoryHandle: null,
    setProjectName: assign("name"),
    setProjectAssets: assign("assets"),
    setProjectDirectoryHandle: assign("handle"),
    setProjectNeedsPermission: (value) => { assign("needsPermission")(value); context.projectNeedsPermission = value; },
    setProjectFolderLoading: (value) => { state.loading = value; context.projectFolderLoading = value; },
    setProjectFolderDiagnostic: assign("folderDiagnostic"),
    recordDiagnostic: (entry) => { state.diagnostics.push(entry); return entry; },
    Date: class extends Date { static now() { return now; } },
    setTimeout: setTimer,
    clearTimeout: clearTimer,
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
    window: { setTimeout: setTimer, clearTimeout: clearTimer },
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
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    timers,
  };
}

function useRealPermission(flow) {
  const context = vm.createContext({
    setTimeout: flow.context.setTimeout,
    clearTimeout: flow.context.clearTimeout,
    Date: flow.context.Date,
    DOMException,
  });
  vm.runInContext(readFileSync(new URL("../src/projectFolderStore.js", import.meta.url), "utf8").replace(/export /g, ""), context);
  flow.context.projectDirectoryPermission = context.projectDirectoryPermission;
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
  const eventCount = flow.state.events.length;
  current = false;
  permission.resolve("prompt");
  await opening;
  assert.equal(flow.state.events.length, eventCount);
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

test("ten seconds of pending folder lookup only reports its latest stage and never unlocks or changes a binding", async () => {
  let report;
  const lookup = deferred();
  const flow = harness({ loadTaskProjectDirectory: (_name, options) => { report = options.onDiagnostic; report({ stage: "project_folder_db_open_started" }); return lookup.promise; } });
  flow.effect();
  assert.equal(flow.state.folderDiagnostic.stage, "project_folder_db_open_started");
  flow.advance(9999);
  assert.equal(flow.state.diagnostics.some((entry) => entry.stage === "project_folder_waiting"), false);
  report({ stage: "project_folder_db_open_blocked" });
  flow.advance(10_000);
  assert.equal(flow.state.folderDiagnostic.stage, "project_folder_waiting");
  assert.equal(flow.state.folderDiagnostic.waitingStage, "project_folder_db_open_blocked");
  assert.equal(flow.state.folderDiagnostic.stepWaitMs, 10_000);
  assert.match(flow.state.folderDiagnostic.message, /仅记录，不中断读取/);
  assert.equal(flow.state.loading, true);
  assert.equal(flow.state.name, "");
  assert.deepEqual(flow.state.saved, []);
  assert.deepEqual(flow.state.removed, []);
  lookup.resolve(null);
  await settle();
  assert.equal(flow.state.loading, false);
  assert.equal(flow.state.folderDiagnostic.stage, "project_folder_restore_completed");
  assert.equal(flow.timers.size, 0);
});

test("permission-query waits are diagnosed without requesting permission or changing the original pending state", async () => {
  const pendingPermission = deferred();
  const calls = [];
  const flow = harness({ projectDirectoryPermission: (_handle, request, report) => { calls.push(request); report({ stage: "project_folder_permission_query_started" }); return pendingPermission.promise; } });
  flow.effect();
  await settle();
  flow.advance(10_000);
  assert.equal(flow.state.folderDiagnostic.waitingStage, "project_folder_permission_query_started");
  assert.deepEqual(calls, [false]);
  assert.equal(flow.state.name, "项目A素材");
  assert.equal(flow.state.loading, true);
  assert.equal(flow.state.diagnostics.at(-1).scope, "workbench");
  assert.equal(flow.state.diagnostics.at(-1).taskProjectName, "项目A");
  pendingPermission.resolve("prompt");
  await settle();
  assert.equal(flow.state.loading, false);
  assert.equal(flow.state.needsPermission, true);
  assert.equal(flow.state.name, "项目A素材");
  assert.equal(flow.timers.size, 0);
});

test("an unsampled getFile wait still reports the precise file-information stage after ten seconds", async () => {
  const pendingScan = deferred();
  const flow = harness({ filesFromProjectDirectory: (_handle, report) => { report({ stage: "project_folder_scan_file_started", fileCount: 7, directoryCount: 1 }); return pendingScan.promise; } });
  flow.effect();
  await settle();
  assert.notEqual(flow.state.folderDiagnostic.stage, "project_folder_scan_file_started", "routine per-file updates should stay sampled");
  flow.advance(10_000);
  assert.equal(flow.state.folderDiagnostic.waitingStage, "project_folder_scan_file_started");
  assert.equal(flow.state.folderDiagnostic.fileCount, 7);
  assert.equal(flow.state.loading, true);
  assert.equal(flow.state.name, "项目A素材");
  assert.equal(flow.state.assets.length, 0);
  pendingScan.resolve([]);
  await settle();
  assert.equal(flow.state.loading, false);
});

test("former-project observers and diagnostic timers cannot overwrite a new project's diagnostic", async () => {
  const pendingLookup = deferred();
  let formerObserver;
  const flow = harness({ loadTaskProjectDirectory: (name, options) => {
    if (name !== "项目A") return Promise.resolve(null);
    formerObserver = options.onDiagnostic;
    formerObserver({ stage: "project_folder_db_open_started" });
    return pendingLookup.promise;
  } });
  flow.effect();
  flow.effect("项目B");
  await settle();
  const diagnostic = flow.state.folderDiagnostic;
  const logCount = flow.state.diagnostics.length;
  formerObserver({ stage: "project_folder_db_open_failed" });
  flow.advance(20_000);
  assert.equal(flow.state.folderDiagnostic, diagnostic);
  assert.equal(flow.state.folderDiagnostic.taskProjectName, "项目B");
  assert.equal(flow.state.diagnostics.length, logCount);
  assert.equal(flow.timers.size, 0);
  pendingLookup.resolve({ name: "旧目录" });
  await settle();
  assert.equal(flow.state.folderDiagnostic, diagnostic);
});

test("diagnostic recorder failures cannot reject normal folder restoration and completion removes wait timers", async () => {
  const flow = harness({ recordDiagnostic() { throw new Error("diagnostic storage unavailable"); } });
  flow.effect();
  await settle();
  assert.equal(flow.state.name, "项目A素材");
  assert.equal(flow.state.assets.length, 1);
  assert.equal(flow.state.loading, false);
  assert.equal(flow.state.folderDiagnostic.stage, "project_folder_restore_completed");
  assert.equal(flow.state.notices.some((notice) => /diagnostic storage unavailable/.test(notice)), false);
  assert.equal(flow.timers.size, 0);
  flow.advance(30_000);
  assert.equal(flow.state.folderDiagnostic.stage, "project_folder_restore_completed");
});

test("per-file diagnostic updates stay sampled instead of writing a record for every asset", async () => {
  const flow = harness({ filesFromProjectDirectory: async (_handle, report) => {
    for (let fileCount = 0; fileCount <= 99; fileCount += 1) {
      report({ stage: "project_folder_scan_file_started", fileCount, directoryCount: 1 });
      report({ stage: "project_folder_scan_directory_started", fileCount: fileCount + 1, directoryCount: 1 });
    }
    return [];
  } });
  flow.effect();
  await settle();
  const scanRecords = flow.state.diagnostics.filter((entry) => /^project_folder_scan_/.test(entry.stage));
  assert.equal(scanRecords.length, 8);
  assert.equal(flow.state.loading, false);
  assert.equal(flow.timers.size, 0);
});

test("folder failure diagnostics retain the error type without exporting paths or changing the original notice", async () => {
  const message = "Cannot read C:\\SECRET_DIRECTORY\\SECRET_FILE.png";
  const failure = Object.assign(new Error(message), { name: "NotAllowedError" });
  const flow = harness({ loadTaskProjectDirectory: async () => { throw failure; } });
  flow.effect();
  await settle();
  assert.equal(flow.state.folderDiagnostic.stage, "project_folder_restore_failed");
  assert.equal(flow.state.folderDiagnostic.errorName, "NotAllowedError");
  assert.doesNotMatch(JSON.stringify(flow.state.diagnostics), /SECRET_DIRECTORY|SECRET_FILE|C:\\\\/);
  assert.equal(flow.state.notices.some((notice) => notice.includes(message)), true);
  assert.equal(flow.state.loading, false);
  assert.equal(flow.timers.size, 0);
});

test("automatic permission timeout releases the folder buttons while preserving the saved directory and ignoring late grants", async () => {
  let resolvePermission;
  let scans = 0;
  const handle = {
    name: "原素材目录",
    queryPermission: () => new Promise((resolve) => { resolvePermission = resolve; }),
  };
  const flow = harness({
    loadTaskProjectDirectory: async () => handle,
    filesFromProjectDirectory: async () => { scans += 1; return []; },
  });
  useRealPermission(flow);
  flow.effect();
  await settle();
  assert.equal(flow.state.name, handle.name, "the remembered identity must be visible before permission returns");
  assert.equal(flow.state.handle, handle);
  assert.equal(flow.state.loading, true);
  flow.advance(10_000);
  await settle();
  assert.equal(flow.state.loading, false);
  assert.equal(flow.state.needsPermission, true);
  assert.equal(flow.state.handle, handle);
  assert.equal(flow.state.name, handle.name);
  assert.equal(scans, 0);
  assert.deepEqual(flow.state.saved, []);
  assert.deepEqual(flow.state.removed, []);
  assert.equal(flow.state.diagnostics.some((entry) => entry.stage === "project_folder_permission_query_timeout"), true);
  const eventCount = flow.state.events.length;
  const diagnosticCount = flow.state.diagnostics.length;
  resolvePermission("granted");
  await settle();
  assert.equal(flow.state.events.length, eventCount);
  assert.equal(flow.state.diagnostics.length, diagnosticCount);
  assert.equal(scans, 0);
});

test("a directory freshly granted by the picker is read without repeating a hung permission query", async () => {
  let queried = 0;
  let scanned;
  const handle = { name: "重新选择素材", queryPermission: () => { queried += 1; return new Promise(() => {}); } };
  const flow = harness({
    window: { showDirectoryPicker: async () => handle },
    projectDirectoryPermission: () => { queried += 1; return new Promise(() => {}); },
    filesFromProjectDirectory: async (directory) => { scanned = directory; return [{ file: { name: "new.png", size: 1, lastModified: 2 }, relativePath: "new.png" }]; },
  });
  const choosing = flow.context.chooseProjectFolder();
  await settle();
  assert.equal(queried, 0);
  assert.equal(scanned, handle);
  await choosing;
  assert.equal(flow.state.name, handle.name);
  assert.equal(flow.state.loading, false);
  assert.equal(flow.state.assets.length, 1);
  assert.equal(flow.state.saved[0].handle, handle);
  assert.deepEqual(flow.state.removed, []);
});

test("reselecting while a manual permission request is pending prevents its late result from replacing the new selection", async () => {
  const pendingPermission = deferred();
  const pendingPicker = deferred();
  let pickerCalls = 0;
  const oldHandle = { name: "原绑定素材" };
  const newHandle = { name: "重新选择素材" };
  const scans = [];
  const flow = harness({
    projectDirectoryHandle: oldHandle,
    projectNeedsPermission: true,
    projectDirectoryPermission: (_handle, request) => { assert.equal(request, true); return pendingPermission.promise; },
    window: { showDirectoryPicker: () => { pickerCalls += 1; return pendingPicker.promise; } },
    filesFromProjectDirectory: async (handle) => { scans.push(handle); return [{ file: { name: `${handle.name}.png`, size: 1, lastModified: 2 }, relativePath: "role.png" }]; },
  });
  flow.state.needsPermission = true;
  const restoring = flow.context.restoreProjectFolder();
  await settle();
  assert.equal(flow.state.loading, true);
  const choosing = flow.context.chooseProjectFolder();
  await settle();
  assert.equal(pickerCalls, 1, "the separate picker must remain available while the original authorization is pending");
  await flow.context.chooseProjectFolder();
  assert.equal(pickerCalls, 1, "a second click must not start another picker");
  pendingPermission.resolve("granted");
  await restoring;
  assert.equal(flow.state.loading, true, "a stale permission request cannot unlock an active picker");
  assert.equal(scans.length, 0);
  pendingPicker.resolve(newHandle);
  await choosing;
  assert.equal(flow.state.name, newHandle.name);
  assert.equal(flow.state.handle, newHandle);
  assert.equal(flow.state.loading, false);
  assert.equal(flow.state.needsPermission, false);
  assert.deepEqual(scans, [newHandle]);
  assert.equal(flow.state.saved.length, 1);
  assert.equal(flow.state.saved[0].handle, newHandle);
  assert.deepEqual(flow.state.removed, []);
});

test("canceling a replacement picker leaves the original binding recoverable and ignores the superseded authorization", async () => {
  const pendingPermission = deferred();
  const oldHandle = { name: "应保留的原目录" };
  let pickerCalls = 0;
  let scans = 0;
  const flow = harness({
    projectDirectoryHandle: oldHandle,
    projectNeedsPermission: true,
    projectDirectoryPermission: () => pendingPermission.promise,
    window: { showDirectoryPicker: async () => { pickerCalls += 1; throw Object.assign(new Error("cancel"), { name: "AbortError" }); } },
    filesFromProjectDirectory: async () => { scans += 1; return []; },
  });
  flow.state.needsPermission = true;
  const restoring = flow.context.restoreProjectFolder();
  await settle();
  await flow.context.chooseProjectFolder();
  assert.equal(pickerCalls, 1);
  assert.equal(flow.state.handle, oldHandle);
  assert.equal(flow.state.name, oldHandle.name);
  assert.equal(flow.state.needsPermission, true);
  assert.equal(flow.state.loading, false);
  assert.deepEqual(flow.state.saved, []);
  assert.deepEqual(flow.state.removed, []);
  pendingPermission.resolve("granted");
  await restoring;
  assert.equal(flow.state.handle, oldHandle);
  assert.equal(flow.state.needsPermission, true);
  assert.equal(flow.state.loading, false);
  assert.equal(scans, 0);
});
