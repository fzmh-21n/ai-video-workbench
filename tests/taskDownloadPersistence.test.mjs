import assert from "node:assert/strict";
import test from "node:test";
import { taskDatabase } from "./helpers/taskDatabase.mjs";

let moduleNumber = 0;

function harness(t, tasks, { failPutAt = 0 } = {}) {
  const { indexedDB, stats } = taskDatabase(tasks, { failPutAt, errorMessage: "模拟下载标记写入失败" });
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = indexedDB;
  t.after(() => {
    if (previous === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previous;
  });
  const loadStore = () => import(new URL(`../src/taskStore.js?download-persistence=${++moduleNumber}`, import.meta.url));
  return { loadStore, stats };
}

const task = (id, changes = {}) => ({
  id, status: "completed", title: `任务${id}`, projectName: "下载项目", profileId: "mock",
  createdAtMs: 100, updatedAtMs: 200, resultUrl: `https://example.invalid/${id}.mp4`,
  ...changes,
});

test("download-state merge preserves the latest valid timestamp only for the same task", async (t) => {
  const { loadStore } = harness(t, []);
  const { mergeTaskDownloadState } = await loadStore();
  assert.equal(typeof mergeTaskDownloadState, "function");
  for (const value of [undefined, null, 0, -1, NaN, Infinity, 400]) {
    const update = { id: "a", downloadedAtMs: value, title: "新版" };
    assert.deepEqual(mergeTaskDownloadState({ id: "a", downloadedAtMs: 500 }, update), { ...update, downloadedAtMs: 500 });
  }
  assert.deepEqual(mergeTaskDownloadState({ id: "a", downloadedAtMs: 500 }, { id: "a", downloadedAtMs: 700 }), { id: "a", downloadedAtMs: 700 });
  for (const stored of [undefined, { id: "a" }, { id: "a", downloadedAtMs: 0 }, { id: "other", downloadedAtMs: 500 }]) {
    const update = { id: "a", title: "未下载" };
    assert.deepEqual(mergeTaskDownloadState(stored, update), update);
    assert.equal(Object.hasOwn(mergeTaskDownloadState(stored, update), "downloadedAtMs"), false);
  }
  assert.deepEqual(mergeTaskDownloadState({ id: "a", downloadedAtMs: 0 }, { id: "a", downloadedAtMs: null }), { id: "a", downloadedAtMs: null });
});

test("putTasks reads and merges each stored task inside its one write transaction", async (t) => {
  const { loadStore, stats } = harness(t, [task("a", { downloadedAtMs: 500 }), task("b", { downloadedAtMs: 600 })]);
  const store = await loadStore();
  await store.putTasks([task("a", { title: "新标题" }), task("b", { downloadedAtMs: 0 })]);
  assert.equal(stats.commits, 1);
  assert.equal(stats.transactions.length, 1);
  assert.equal(stats.transactions[0].mode, "readwrite");
  for (const id of ["a", "b"]) {
    const operations = stats.transactions[0].operations;
    const get = operations.findIndex((operation) => operation.type === "get" && operation.id === id);
    const put = operations.findIndex((operation) => operation.type === "put" && operation.id === id);
    assert.ok(get >= 0 && put > get, `${id} must be read before it is written in the same transaction`);
  }
  const rows = await store.getTasksByIds(["a", "b"]);
  assert.deepEqual(rows.map((row) => row.downloadedAtMs), [500, 600]);
  assert.equal(rows[0].title, "新标题");
});

test("stale full snapshots cannot erase a persisted download mark, including after a cold module reload", async (t) => {
  const { loadStore, stats } = harness(t, [task("a", { downloadedAtMs: 500 })]);
  const store = await loadStore();
  for (const snapshot of [{}, { downloadedAtMs: null }, { downloadedAtMs: 0 }, { downloadedAtMs: undefined }, { downloadedAtMs: 400 }]) {
    await store.putTasks([task("a", snapshot)]);
    assert.equal((await store.getTasksByIds(["a"]))[0].downloadedAtMs, 500);
  }
  await store.putTask(task("a", { downloadedAtMs: 700 }));
  await store.putTasks([task("new")]);
  const reloaded = await loadStore();
  const rows = await reloaded.getTasksByIds(["a", "new"]);
  assert.equal(stats.opens, 2, "cold import must reopen the same persisted database");
  assert.equal(rows[0].downloadedAtMs, 700);
  assert.equal(Object.hasOwn(rows[1], "downloadedAtMs"), false);
});

test("polling merges and persisted polling updates preserve download marks while updating status", async (t) => {
  const original = task("a", { status: "processing", downloadedAtMs: 500 });
  const { loadStore } = harness(t, [original]);
  const store = await loadStore();
  for (const downloadedAtMs of [undefined, null, 0, 400, 700]) {
    const merged = store.mergePolledTaskUpdate(original, { id: "a", status: "completed", downloadedAtMs });
    assert.equal(merged.downloadedAtMs, downloadedAtMs === 700 ? 700 : 500);
    assert.equal(merged.status, "completed");
    assert.equal(merged.title, original.title);
    assert.equal(merged.projectName, original.projectName);
  }
  await store.putPolledTaskUpdates([{ id: "a", status: "completed", downloadedAtMs: 0 }]);
  const persisted = (await store.allTasks())[0];
  assert.equal(persisted.downloadedAtMs, 500);
  assert.equal(persisted.status, "completed");
});

test("download marking patches archived and manually cancelled tasks without reviving or dropping their state", async (t) => {
  const originals = [
    task("archived", { archivedAtMs: 300 }),
    task("cancelled", { status: "failed", cancelledByUser: true, cancelledAtMs: 400, error: "手动取消" }),
    task("normal", { downloadedAtMs: 800, usage: { credits: 3 } }),
  ];
  const { loadStore, stats } = harness(t, originals);
  const store = await loadStore();
  await store.markTasksDownloaded(["archived", "cancelled", "normal", "archived"], 700);
  assert.equal(stats.commits, 1);
  assert.equal(stats.transactions[0].mode, "readwrite");
  assert.equal(stats.transactions[0].operations.filter((operation) => operation.type === "get").length, 3);
  const rows = await store.getTasksByIds(originals.map((row) => row.id));
  for (const [index, original] of originals.entries()) {
    const { updatedAtMs: _before, ...before } = original;
    const { updatedAtMs: _after, ...after } = rows[index];
    assert.deepEqual(after, { ...before, downloadedAtMs: index === 2 ? 800 : 700 });
  }
  await store.markTaskDownloaded("cancelled", 900);
  assert.equal((await store.getTasksByIds(["cancelled"]))[0].downloadedAtMs, 900);
});

test("a missing requested task rejects the entire download-mark transaction without partial persistence", async (t) => {
  const originals = [task("a"), task("b", { downloadedAtMs: 300 })];
  const { loadStore, stats } = harness(t, originals);
  const store = await loadStore();
  await assert.rejects(store.markTasksDownloaded(["a", "b", "missing"], 700));
  assert.equal(stats.commits, 0);
  assert.equal(stats.aborts, 1);
  assert.deepEqual(await store.allTasks(), originals);
});

test("download-mark write failures reject and roll back all earlier records", async (t) => {
  const originals = [task("a"), task("b"), task("c")];
  const { loadStore, stats } = harness(t, originals, { failPutAt: 2 });
  const store = await loadStore();
  await assert.rejects(store.markTasksDownloaded(["a", "b", "c"], 700), /模拟下载标记写入失败/);
  assert.equal(stats.commits, 0);
  assert.equal(stats.aborts, 1);
  assert.deepEqual(await store.allTasks(), originals);
});
