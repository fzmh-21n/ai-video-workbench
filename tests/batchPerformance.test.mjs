import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { batchItemDownloadCandidates, createBatchTaskLookup, recoverBatchItemTaskIds } from "../src/taskDownload.js";
import { reconciledBatchTerminalState } from "../src/batchPrompts.js";
import { normalizedTaskProgress } from "../src/taskProgress.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");

test("batch pagination bounds rendered rows without changing the complete list", async () => {
  const { batchItemPage } = await import("../src/batchPerformance.js");
  const items = Array.from({ length: 123 }, (_, index) => ({ id: index }));
  assert.deepEqual(batchItemPage(items, 1).items, items.slice(0, 50));
  assert.deepEqual(batchItemPage(items, 2).items, items.slice(50, 100));
  assert.deepEqual(batchItemPage(items, 3).items, items.slice(100));
  assert.equal(batchItemPage(items, 10).page, 3);
  assert.equal(batchItemPage(items, 3).totalPages, 3);
  assert.equal(items.length, 123);
  assert.deepEqual(batchItemPage([], 5), { items: [], page: 1, totalPages: 1 });
});

test("terminal failures do not keep the periodic batch synchronization alive", async () => {
  const { needsBatchStatusSync } = await import("../src/batchPerformance.js");
  for (const status of ["submitting", "submitted", "generating"]) {
    assert.equal(needsBatchStatusSync({ status, taskIds: ["task"] }), true);
    assert.equal(needsBatchStatusSync({ status, taskIds: [] }), false);
  }
  for (const status of ["generated", "generation_failed", "failed", "submission_unknown"]) {
    assert.equal(needsBatchStatusSync({ status, taskIds: ["task"] }), false);
  }
});

test("an unchanged sync preserves array and item identity", async () => {
  const { syncBatchTaskStates } = await import("../src/batchPerformance.js");
  const item = { id: "row", status: "generating", progress: 45, taskIds: ["task"] };
  const failed = { id: "failed", status: "generation_failed", error: "已失败", taskIds: ["old"] };
  const items = [item, failed];
  const result = syncBatchTaskStates(items, [{ id: "task", status: "processing", progress: 45 }]);
  assert.equal(result, items);
  assert.equal(result[0], item);
  assert.equal(result[1], failed);
});

test("a real progress or terminal update changes only the affected row", async () => {
  const { syncBatchTaskStates } = await import("../src/batchPerformance.js");
  const items = [
    { id: "first", status: "generating", progress: 40, taskIds: ["first-task"] },
    { id: "second", status: "generated", progress: 100, taskIds: ["second-task"] },
  ];
  const progress = syncBatchTaskStates(items, [{ id: "first-task", status: "processing", progress: 60 }]);
  assert.equal(progress[0].progress, 60);
  assert.equal(progress[1], items[1]);
  const completed = syncBatchTaskStates(items, [{ id: "first-task", status: "completed", progress: 100 }]);
  assert.equal(completed[0].status, "generated");
  assert.equal(completed[0].error, "");
  assert.equal(completed[1], items[1]);
  const failed = syncBatchTaskStates(items, [{ id: "first-task", status: "failed", error: "真实失败", progress: 20 }]);
  assert.equal(failed[0].status, "generation_failed");
  assert.equal(failed[0].error, "真实失败");
});

test("status synchronization schedules its next check only after the current check finishes", () => {
  const effect = source.slice(source.indexOf("const hasTrackedTasks ="), source.indexOf("const summary ="));
  assert.doesNotMatch(effect, /setInterval/);
  assert.match(effect, /finally\s*\{\s*if \(!cancelled\) timer = window\.setTimeout\(syncGeneratedStatuses, 3000\)/);
  assert.match(effect, /getTasksByIds\(/);
});

test("the real batch sync does not overlap slow reads and stops scheduling after cleanup", async () => {
  const { needsBatchStatusSync, syncBatchTaskStates } = await import("../src/batchPerformance.js");
  let items = [{ id: "first", status: "generating", taskIds: ["first-task"], progress: 20 }];
  const itemsRef = { current: items };
  const requested = [];
  let resolveRead;
  let callback;
  let cleanup;
  const ctx = vm.createContext({
    items, itemsRef, needsBatchStatusSync, syncBatchTaskStates,
    useEffect: (effect) => { cleanup = effect(); },
    setItems: (update) => { items = update(items); itemsRef.current = items; },
    getTasksByIds: (ids) => { requested.push(Array.from(ids)); return new Promise((resolve) => { resolveRead = resolve; }); },
    window: {
      setTimeout: (next) => { callback = next; return 1; },
      clearTimeout: () => { callback = undefined; },
    },
  });
  const start = source.lastIndexOf("  useEffect(() => {", source.indexOf("const hasTrackedTasks ="));
  vm.runInContext(source.slice(start, source.indexOf("  const summary =", start)), ctx);
  assert.equal(requested.length, 1);
  assert.equal(callback, undefined, "slow reads must not queue another timer");
  resolveRead([{ id: "first-task", status: "processing", progress: 20 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof callback, "function");
  itemsRef.current = [...items, { id: "second", status: "generating", taskIds: ["second-task"] }];
  const next = callback;
  callback = undefined;
  const pending = next();
  assert.deepEqual(requested[1], ["first-task", "second-task"], "new rows must not be lost to the first effect's closure");
  assert.equal(callback, undefined);
  cleanup();
  resolveRead([{ id: "second-task", status: "completed" }]);
  await pending;
  assert.equal(callback, undefined, "a detached page must not schedule or update again");
  assert.equal(items.length, 1);
});

test("pagination never limits batch selection, matching, submission or download candidates", () => {
  assert.match(source, /const selectableItems = visibleItems\.filter\(canBatchDefer\)/);
  assert.match(source, /pageItems\.map\(\(item\) =>/);
  assert.doesNotMatch(source, /visibleItems\.map\(\(item\) =>/);
  assert.match(source, /preuploadItems\(items\.filter/);
  assert.match(source, /submitSelected\(items\.filter\(canBatchResubmit\)/);
  assert.match(source, /preferredBatchDownloadTasks\(items, stored\)/);
});

test("download reconciliation preserves unchanged rows, task IDs and the full array", () => {
  const ctx = vm.createContext({ Map, Math, createBatchTaskLookup, batchItemDownloadCandidates,
    recoverBatchItemTaskIds, reconciledBatchTerminalState, normalizedTaskProgress });
  vm.runInContext(source.slice(source.indexOf("function withDownloadedFlags("), source.indexOf("function persistedState()")), ctx);
  const item = { id: "row", status: "generated", progress: 100, error: "", recoveryNote: "",
    taskIds: ["task"], section: 1, prompt: "原提示词", references: [], downloadedCount: 1, downloaded: true };
  const pending = { id: "pending", status: "matched", recoveryNote: "", downloadedCount: 0, downloaded: false };
  const items = [item, pending];
  const tasks = [{ id: "task", status: "completed", batchSection: 1, prompt: "原提示词", downloadedAtMs: 100 }];
  const unchanged = ctx.withDownloadedFlags(items, tasks);
  assert.equal(unchanged, items);
  assert.equal(unchanged[0].taskIds, item.taskIds);
  assert.equal(unchanged[1].taskIds, undefined);
  const updated = ctx.withDownloadedFlags(items, [{ ...tasks[0], downloadedAtMs: undefined }]);
  assert.equal(updated[0].downloaded, false);
  assert.equal(updated[1], pending);
});

test("rapid refreshes coalesce project reads and keep explicitly linked tasks moved to another project", async () => {
  const requests = [];
  const trackedReads = [];
  let resolveRead;
  let cleanup;
  let reconciled;
  const loader = { running: false, refresh: null };
  const items = [{ id: "row", taskIds: ["moved-task"] }];
  const ctx = vm.createContext({
    taskDatabaseReady: true, trackedDownloadKey: "moved-task", taskRefreshVersion: 1,
    taskProjectName: "项目A", itemsRef: { current: items }, downloadSyncLoadRef: { current: loader },
    useEffect: (effect) => { cleanup = effect(); },
    getProjectTasks: (name) => { requests.push(name); return new Promise((resolve) => { resolveRead = resolve; }); },
    getTasksByIds: async (ids) => { trackedReads.push(Array.from(ids)); return [{ id: "moved-task", projectName: "项目B" }]; },
    allTasks: () => { throw new Error("a named project must not read all history"); },
    setItems: (update) => { update(items); },
    withDownloadedFlags: (values, stored) => { reconciled = stored; return values; },
  });
  const start = source.indexOf("  useEffect(() => {\n    if (!taskDatabaseReady || !trackedDownloadKey)");
  assert.ok(start >= 0);
  const effect = source.slice(start, source.indexOf("  async function importText(", start));
  vm.runInContext(effect, ctx);
  assert.deepEqual(requests, ["项目A"]);
  for (let index = 0; index < 10; index += 1) {
    cleanup();
    vm.runInContext(effect, ctx);
  }
  assert.equal(requests.length, 1, "in-flight database reads must not pile up per task update");
  resolveRead([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2, "only the latest queued refresh needs to run");
  resolveRead([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(trackedReads, [["moved-task"]]);
  assert.equal(reconciled[0].id, "moved-task");
  assert.equal(loader.running, false);
  cleanup();
  assert.equal(loader.refresh, null);
});

test("large batch server rendering includes only 50 cards but counts all 240 rows", async () => {
  const previousStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (key) => key === "video-workbench-batch-v1" ? JSON.stringify({
      items: Array.from({ length: 240 }, (_, index) => ({
        id: `item-${index}`, section: index + 1, title: `测试${index + 1}`, status: "generated",
        prompt: "本条提示词".repeat(1000), references: [], expanded: true,
      })),
    }) : null,
  };
  const vite = await createServer({ optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { default: BatchPanel } = await vite.ssrLoadModule("/src/BatchPanel.jsx");
    const html = renderToStaticMarkup(React.createElement(BatchPanel, {
      activeProfile: { id: "mock", adapter: "mock", name: "mock", model: "mock" }, apiKey: "",
      capability: { durations: [15], resolutions: ["720p"], ratios: ["16:9"], images: 9, audios: 3, videos: 3 },
      duration: 15, resolution: "720p", ratio: "16:9", quantity: 1, seed: "", syncAudio: false,
      fixedContent: "", fixedContentTemplates: [], fixedContentTemplateId: "", fixedContentVersionLabel: "测试",
      projectAssets: [], taskDatabaseReady: false,
    }));
    assert.equal((html.match(/<article\b/g) || []).length, 50);
    const cards = html.match(/<article\b[\s\S]*?<\/article>/g) || [];
    assert.equal(cards.filter((card) => card.includes("<textarea")).length, 50);
    assert.ok(html.includes("全部（240）"));
    assert.ok(html.includes("已生成（240）"));
    assert.ok(html.includes("共 240 节"));
  } finally {
    await vite.close();
    if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});
