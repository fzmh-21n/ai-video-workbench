import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { BATCH_PAGE_SIZE } from "../src/batchPerformance.js";
import { batchSerializable } from "../src/batchPrompts.js";
import { completedBatchSource, importBatchTextFiles, removeCompletedBatchTextState } from "../src/batchTextFiles.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const file = (name, text = "剧情[1]：第一节\n提示词") => ({ name, text: async () => text });
const done = (id, sourceName, extra = {}) => ({ id, sourceName, section: 1, title: "测试", prompt: "提示词", status: "generated", downloaded: true, taskIds: [`task-${id}`], references: [], ...extra });
const keyFor = (item, reference) => reference.projectAssetKey || `manual:${item.id}:${reference.id}`;

test("multiple selected TXT files are read sequentially in stable natural numeric filename order", async () => {
  const reads = [];
  const files = ["第10集.txt", "第2集.txt", "第1集.txt"].map((name) => ({ name, text: async () => { reads.push(name); return "剧情[1]：第一节\n正文\n剧情[2]：第二节\n正文"; } }));
  const imported = await importBatchTextFiles(files, "import-a");
  assert.deepEqual(reads, ["第1集.txt", "第2集.txt", "第10集.txt"]);
  assert.deepEqual(imported.sourceNames, reads);
  assert.deepEqual(imported.additions.map((item) => [item.sourceName, item.section]), reads.flatMap((name) => [[name, 1], [name, 2]]));
  assert.equal(new Set(imported.additions.map((item) => item.id)).size, 6);
  assert.deepEqual(imported.failures, []);
  assert.ok(imported.additions.every((item) => item.status === "unmatched"));
});

test("imports OUTPUT-wrapped collections whose filename supplies the missing plot section range", async () => {
  const wrapped = (text) => `_::~OUTPUT_START::~_\n_::~FIELD::~_\n${text}\n_::~OUTPUT_END::~_`;
  const text = [
    wrapped("【本组目标时长】：30秒\n第一节的完整提示词"),
    wrapped("【本组目标时长】：30秒\n第二节的完整提示词"),
  ].join("\n\n");
  const imported = await importBatchTextFiles([
    file("第01集_灵堂上，大伯抢走了存折_30秒视频提示词_紧凑节奏_剧情001-002合集.txt", text),
  ], "wrapped-import");

  assert.deepEqual(imported.failures, []);
  assert.deepEqual(imported.additions.map((item) => item.section), [1, 2]);
  assert.match(imported.additions[0].prompt, /第一节的完整提示词/);
  assert.match(imported.additions[1].prompt, /第二节的完整提示词/);
  assert.doesNotMatch(imported.additions.map((item) => item.prompt).join("\n"), /_::~/);
});

test("duplicate filenames and section numbers cannot collide across one selection or later imports", async () => {
  const files = [file("第1集.txt"), file("第1集.txt")];
  const first = await importBatchTextFiles(files, "import-a");
  const second = await importBatchTextFiles(files, "import-b");
  assert.equal(new Set([...first.additions, ...second.additions].map((item) => item.id)).size, 4);
});

test("a bad-format TXT and an unreadable TXT are reported without discarding the other selected files", async () => {
  const result = await importBatchTextFiles([
    file("第1集.txt"), file("第2集.txt", "没有任何分节标记"),
    { name: "第3集.txt", text: async () => { throw new Error("read failed"); } },
    file("第4集.txt"),
  ], "import-a");
  assert.deepEqual(result.sourceNames, ["第1集.txt", "第4集.txt"]);
  assert.deepEqual(result.failures.map((entry) => entry.name), ["第2集.txt", "第3集.txt"]);
  assert.match(result.failures[0].error, /分节/);
  assert.match(result.failures[1].error, /read failed/);
  assert.equal(result.additions.length, 2);
});

test("empty file selection makes no changes and the legacy single-file call remains supported", async () => {
  assert.deepEqual(await importBatchTextFiles([], "empty"), { additions: [], sourceNames: [], failures: [] });
  assert.equal((await importBatchTextFiles(file("单条.txt"), "single")).additions.length, 1);
});

test("the real importer merges once and retains updates to existing running and deferred rows made during file reading", async () => {
  const active = { id: "active", status: "generating", sourceName: "第1集.txt", taskIds: ["original-task"], progress: 20 };
  const deferred = { id: "deferred", status: "failed", sourceName: "第2集.txt", taskIds: ["failed-task"], deferred: true };
  const state = { items: [active, deferred], notices: [], itemUpdates: 0 };
  const itemsRef = { current: state.items };
  const ctx = vm.createContext({ importBatchTextFiles, uid: () => "actual-import", itemsRef, BATCH_PAGE_SIZE,
    setItems: (update) => { state.items = update(state.items); state.itemUpdates += 1; }, setBatchPage: (page) => { state.page = page; }, setStatusFilter: (filter) => { state.filter = filter; }, setSourceName: (name) => { state.sourceName = name; }, onNotice: (message) => state.notices.push(message),
  });
  const start = source.indexOf("  async function importText(");
  vm.runInContext(source.slice(start, source.indexOf("  function removeCompletedText(", start)), ctx);
  let finishRead;
  const pending = ctx.importText([{ name: "第3集.txt", text: () => new Promise((resolve) => { finishRead = resolve; }) }, file("第4集.txt")]);
  const updatedActive = { ...active, progress: 80 };
  state.items = [updatedActive, deferred];
  itemsRef.current = state.items;
  finishRead("剧情[1]：新剧情\n正文");
  await pending;
  assert.equal(state.itemUpdates, 1);
  assert.equal(state.items[0], updatedActive);
  assert.equal(state.items[1], deferred);
  assert.deepEqual(state.items[0].taskIds, ["original-task"]);
  assert.deepEqual(Array.from(state.items.slice(2), (item) => item.sourceName), ["第3集.txt", "第4集.txt"]);
  assert.equal(state.items.length, 4);
  assert.equal(state.sourceName, "第4集.txt");
});

test("the delete button is eligible only for a nonempty source where every section is generated and downloaded", () => {
  assert.equal(completedBatchSource([]), false);
  assert.equal(completedBatchSource([done("a", "第一集.txt"), done("b", "第一集.txt")]), true);
  assert.equal(completedBatchSource([done("a", "第一集.txt", { downloaded: false, manuallyMarkedDownloaded: true })]), true);
  assert.equal(completedBatchSource([done("a", "第一集.txt", { downloaded: false, downloadedCount: 1 })]), false);
  for (const status of ["pending", "matched", "submitting", "generating", "submitted", "failed", "generation_failed", "submission_unknown", "not_submitted"]) {
    assert.equal(completedBatchSource([done("a", "第一集.txt"), done("b", "第一集.txt", { status })]), false, status);
  }
});

test("removing a completed TXT preserves unrelated active and deferred rows, task IDs and shared upload URLs", () => {
  const deleted = done("finished", "第1集.txt", { references: [{ projectAssetKey: "shared" }, { projectAssetKey: "exclusive" }, { id: "manual" }] });
  const active = done("active", "第2集.txt", { status: "generating", downloaded: false, references: [{ projectAssetKey: "shared" }] });
  const deferred = done("deferred", "第3集.txt", { status: "failed", downloaded: false, deferred: true });
  const state = { items: [deleted, active, deferred], sourceName: "第1集.txt", selectedItemIds: ["finished", "deferred"], uploaded: { shared: { url: "shared-url" }, exclusive: { url: "old-url" }, "manual:finished:manual": { url: "manual-url" }, unknown: { url: "unrelated-url" } }, overnightPlan: { itemIds: ["finished", "active"], baselineTaskIds: { finished: ["old-task"], active: [] }, autoRetryFailures: true, providerName: "unchanged" } };
  const snapshot = structuredClone(state);
  const result = removeCompletedBatchTextState(state, "第1集.txt", keyFor);
  assert.deepEqual(result.items, [active, deferred]);
  assert.equal(result.items[0], active);
  assert.equal(result.items[1], deferred);
  assert.deepEqual(result.selectedItemIds, ["deferred"]);
  assert.deepEqual(result.overnightPlan, { ...state.overnightPlan, itemIds: ["active"], baselineTaskIds: { active: [] } });
  assert.deepEqual(result.uploaded, { shared: state.uploaded.shared, unknown: state.uploaded.unknown });
  assert.equal(result.sourceName, "第3集.txt");
  assert.deepEqual(state, snapshot);
  const persisted = JSON.parse(JSON.stringify({ items: batchSerializable(result.items), sourceName: result.sourceName }));
  assert.equal(persisted.items.some((item) => item.sourceName === "第1集.txt"), false);
});

test("an unfinished or absent TXT cannot be removed and deleting the last completed TXT leaves no fallback source", () => {
  const state = { items: [done("a", "第1集.txt", { downloaded: false })], sourceName: "第1集.txt", selectedItemIds: [], uploaded: {}, overnightPlan: null };
  assert.equal(removeCompletedBatchTextState(state, "第1集.txt", keyFor), null);
  assert.equal(removeCompletedBatchTextState(state, "不存在.txt", keyFor), null);
  const empty = removeCompletedBatchTextState({ ...state, items: [done("a", "第1集.txt")] }, "第1集.txt", keyFor);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.sourceName, "");
  assert.equal(empty.overnightPlan, null);
  assert.equal(removeCompletedBatchTextState({ ...state, sourceName: "陈旧文件名.txt", items: [done("a", "第1集.txt")] }, "第1集.txt", keyFor).sourceName, "");
});

function removeContext({ confirm = true, fullStorage = false, busy = "", downloading = false, retrying = false } = {}) {
  const state = { items: [done("a", "第1集.txt")], sourceName: "第1集.txt", selectedItemIds: ["a"], uploaded: {}, overnightPlan: null };
  const events = [];
  let saved;
  const ctx = vm.createContext({ ...state, itemsRef: { current: state.items }, busy, finalDownloading: downloading, autoRetryRunningRef: { current: retrying }, window: { confirm: (message) => { events.push(`confirm:${message}`); return confirm; } }, removeCompletedBatchTextState, uploadKey: keyFor, batchSerializable, STORAGE_KEY: "batch", concurrency: 3, submissionMode: "strict_order", uploadedProfileId: "relay", JSON,
    localStorage: { setItem: (key, value) => { assert.equal(key, "batch"); if (fullStorage) throw new Error("storage unavailable"); saved = JSON.parse(value); events.push("persist"); } },
    setItems: (value) => { state.items = value; events.push("items"); }, setSourceName: (value) => { state.sourceName = value; }, setSelectedItemIds: (value) => { state.selectedItemIds = value; }, setUploaded: (value) => { state.uploaded = value; }, setOvernightPlan: (value) => { state.overnightPlan = value; }, setBatchPage: () => {}, setMention: () => {}, onNotice: (value) => events.push(`notice:${value}`),
  });
  const start = source.indexOf("  function removeCompletedText(");
  const end = source.indexOf("  function clearBatch()", start);
  assert.ok(start >= 0 && end > start, "uses the actual delete handler");
  vm.runInContext(source.slice(start, end), ctx);
  return { ctx, state, events, saved: () => saved };
}

test("the real TXT removal requires confirmation and persists before removing left-side records", () => {
  const { ctx, state, events, saved } = removeContext();
  ctx.removeCompletedText("第1集.txt");
  assert.equal(state.items.length, 0);
  assert.equal(saved().items.length, 0);
  assert.ok(events.indexOf("persist") < events.indexOf("items"));
  assert.match(events[0], /右侧.*本地/);
  assert.ok(!source.slice(source.indexOf("  function removeCompletedText("), source.indexOf("  function clearBatch()")).match(/deleteTasks|putTasks|fetch\(/));
});

test("cancelled confirmation or failed persistence preserves TXT and makes no deletion", () => {
  for (const options of [{ confirm: false }, { fullStorage: true }]) {
    const { ctx, state, events } = removeContext(options);
    ctx.removeCompletedText("第1集.txt");
    assert.equal(state.items.length, 1);
    assert.ok(!events.includes("items"));
  }
});

test("the real TXT removal is blocked during bulk work, downloading or managed automatic retry", () => {
  for (const options of [{ busy: "submitting" }, { downloading: true }, { retrying: true }]) {
    const { ctx, state, events } = removeContext(options);
    ctx.removeCompletedText("第1集.txt");
    assert.equal(state.items.length, 1);
    assert.deepEqual(events, []);
  }
});

test("the real UI accepts multiple TXT files and only exposes removal for a completed downloaded source", () => {
  assert.match(source, /ref=\{textInput\}[^>]*type="file"[^>]*multiple/);
  assert.match(source, /importText\(event\.target\.files\)/);
  assert.match(source, /source\.canRemove &&[\s\S]*?removeCompletedText\(source\.name\)[\s\S]*?>删除本条TXT</);
});

test("the actual source list renders TXT deletion only after every section is downloaded", async () => {
  const previousStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  globalThis.window = {};
  globalThis.localStorage = { getItem: (key) => key === "video-workbench-batch-v1" ? JSON.stringify({ items: [
    done("a", "第1集.txt", { section: 1 }), done("b", "第1集.txt", { section: 2 }),
    done("c", "第2集.txt", { section: 1, downloaded: false }), done("d", "第2集.txt", { section: 2 }),
    done("e", "第3集.txt", { section: 1, status: "generating", downloaded: false }),
  ] }) : null };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { default: BatchPanel } = await vite.ssrLoadModule("/src/BatchPanel.jsx");
    const html = renderToStaticMarkup(React.createElement(BatchPanel, {
      activeProfile: { id: "mock", adapter: "mock", name: "mock", model: "mock" }, apiKey: "",
      capability: { durations: [15], resolutions: ["720p"], ratios: ["16:9"], images: 9, audio: 3, videos: 3 }, duration: 15, resolution: "720p", ratio: "16:9", quantity: 1,
      seed: "", syncAudio: false, fixedContent: "", fixedContentTemplates: [], fixedContentTemplateId: "", fixedContentVersionLabel: "测试", projectAssets: [], taskDatabaseReady: false,
    }));
    const rows = [...html.matchAll(/<div class="batch-source-row">[\s\S]*?<\/div>/g)].map(([row]) => row);
    assert.equal(rows.length, 3);
    assert.match(rows[0], /第1集.txt[\s\S]*删除本条TXT/);
    assert.ok(!rows[1].includes("删除本条TXT"));
    assert.ok(!rows[2].includes("删除本条TXT"));
    assert.equal((html.match(/删除本条TXT/g) || []).length, 1);
  } finally {
    await vite.close();
    globalThis.localStorage = previousStorage;
    globalThis.window = previousWindow;
  }
});

test("the optional busy notification lets task cleanup stay disabled during batch submission or download", () => {
  const start = source.indexOf("  useEffect(() => {\n    onBusyChange?");
  const end = source.indexOf("\n\n", start);
  assert.ok(start >= 0 && end > start);
  for (const [busy, finalDownloading, expected] of [["submitting", false, true], ["", true, true], ["", false, false]]) {
    const calls = [];
    let cleanup;
    vm.runInNewContext(source.slice(start, end), { busy, finalDownloading, seedanceRecovering: false, overnightPlan: null, onBusyChange: (value) => calls.push(value), useEffect: (callback) => { cleanup = callback(); } });
    assert.deepEqual(calls, [expected]);
    cleanup();
    assert.deepEqual(calls, [expected, false]);
  }
  vm.runInNewContext(source.slice(start, end), { busy: "", finalDownloading: false, seedanceRecovering: false, overnightPlan: null, onBusyChange: undefined, useEffect: (callback) => callback()() });
  for (const extra of [{ seedanceRecovering: true }, { overnightPlan: { autoRetryFailures: true } }]) {
    const calls = [];
    vm.runInNewContext(source.slice(start, end), { busy: "", finalDownloading: false, seedanceRecovering: false, overnightPlan: null, ...extra, onBusyChange: (value) => calls.push(value), useEffect: (callback) => callback() });
    assert.deepEqual(calls, [true]);
  }
});

test("batch initialization restores settings once then releases the obsolete full snapshot without rereading on rerender", () => {
  const snapshot = { items: [done("removed", "第1集.txt"), done("remaining", "第2集.txt")], sourceName: "第2集.txt", concurrency: 5, submissionMode: "single_like", uploaded: { shared: { url: "retained-url" }, old: { url: "old-url" } }, uploadedProfileId: "original-relay" };
  const slots = [];
  const ref = { current: undefined };
  let slotIndex = 0;
  let reads = 0;
  const context = vm.createContext({
    useRef: () => ref,
    useState: (initial) => {
      const index = slotIndex++;
      if (index >= slots.length) slots.push(initial);
      return [slots[index], (value) => { slots[index] = value; }];
    },
    persistedState: () => { reads += 1; return snapshot; },
  });
  const start = source.indexOf("  const restoredStateRef = useRef(");
  const end = source.indexOf("  const [overnightPlan,", start);
  assert.ok(start >= 0 && end > start, "the real initializer must not retain useMemo(persistedState)");
  const initialize = vm.runInContext(`(function () { ${source.slice(start, end)} return { items, setItems, sourceName, concurrency, submissionMode, uploaded, setUploaded, uploadedProfileId }; })`, context);
  const first = initialize();
  assert.equal(reads, 1);
  assert.equal(first.items, snapshot.items);
  assert.equal(first.uploaded, snapshot.uploaded);
  assert.equal(first.sourceName, "第2集.txt");
  assert.equal(first.concurrency, 5);
  assert.equal(first.submissionMode, "single_like");
  assert.equal(first.uploadedProfileId, "original-relay");
  assert.equal(ref.current, null, "the ref must release the initial all-row/all-cache snapshot");
  const remaining = [snapshot.items[1]];
  const retainedUploads = { shared: snapshot.uploaded.shared };
  first.setItems(remaining);
  first.setUploaded(retainedUploads);
  slotIndex = 0;
  const rerendered = initialize();
  assert.equal(reads, 1, "subsequent renders must not reread browser storage or recover deleted rows");
  assert.equal(rerendered.items, remaining);
  assert.equal(rerendered.uploaded, retainedUploads);
  assert.equal(ref.current, null);
});
