import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

import { downloadedChapterTaskIds, downloadTaskBuckets, orderedDownloadFilename } from "../src/taskDownload.js";
import { taskContentRequestUrl } from "../src/taskContent.js";

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const start = source.indexOf("  async function downloadTaskCollection(");
const end = source.indexOf("  async function downloadBatch(", start);
assert.ok(start >= 0 && end > start, "extract the real App download function");

const firstOpening = "第01集_仙人跳跳到了剑修头上_30秒视频提示词_剧情001";
const firstRemainder = "第01集_仙人跳跳到了剑修头上_30秒视频提示词_剧情002-006合集";
const secondEpisode = "第02集_老婆是我的灵气源泉_30秒视频提示词_剧情001-005合集";

function task(id, batchTitle, batchSection, createdAtMs = 0) {
  return {
    id, profileId: "mock", status: "completed", batchTitle, batchSection, createdAtMs,
    title: `第${String(batchSection).padStart(3, "0")}节-seedance-2.5`,
  };
}

function downloadContext(tasks, failedIds = []) {
  const blobs = new Map(tasks.map((item) => [item.id, new Blob([`video:${item.id}`], { type: "video/mp4" })]));
  const objectUrls = new Map();
  const calls = [];
  const links = [];
  const marks = [];
  const context = vm.createContext({
    downloadedChapterTaskIds, downloadTaskBuckets, orderedDownloadFilename, taskContentRequestUrl,
    profiles: [{ id: "mock" }], keyFor: () => "test-key", headersFor: () => ({ "x-test": "local" }),
    fetch: async (url) => {
      calls.push(url);
      const id = decodeURIComponent(url.match(/^\/api\/tasks\/([^/]+)\/content/)?.[1] || "");
      assert.ok(blobs.has(id), `unexpected content request ${url}`);
      const ok = !failedIds.includes(id);
      return { ok, status: ok ? 200 : 404, json: async () => ({ message: "mock unavailable" }), blob: async () => blobs.get(id) };
    },
    URL: {
      createObjectURL: (blob) => { const url = `blob:mock-${objectUrls.size}`; objectUrls.set(url, blob); return url; },
      revokeObjectURL: () => {},
    },
    document: {
      body: { appendChild: () => {} },
      createElement: () => ({ click() { links.push({ name: this.download, blob: objectUrls.get(this.href) }); }, remove() {} }),
    },
    window: { setTimeout: (callback, delay) => { if (delay === 150 || delay === 1000) callback(); } },
    markTasksDownloaded: async (ids) => {
      marks.push([...ids]);
      for (const item of tasks) if (ids.includes(item.id)) item.downloadedAtMs = 1;
    },
    setNotice: () => {}, setDownloadingBatchId: () => {}, setTaskRefreshVersion: () => {},
  });
  vm.runInContext(readFileSync(new URL("../src/downloadBlob.js", import.meta.url), "utf8").replace("export async function", "async function"), context);
  vm.runInContext(source.slice(start, end), context);
  return { download: context.downloadTaskCollection, blobs, calls, links, marks, context };
}

test("real download flow sorts split episode sources and keeps each filename attached to its own video bytes", async () => {
  const first = task("episode-1-opening", firstOpening, 1, 30);
  const sixth = task("episode-1-sixth", firstRemainder, 6, 40);
  const second = task("episode-2-opening", secondEpisode, 1, 10);
  const state = downloadContext([second, sixth, first]);
  const result = await state.download([second, sixth, first], "mixed");

  assert.deepEqual(state.calls, [first, sixth, second].map(taskContentRequestUrl));
  assert.deepEqual(state.links.map((link) => link.name), [
    "001-第001节-seedance-2.5.mp4", "001-第006节-seedance-2.5.mp4", "002-第001节-seedance-2.5.mp4",
  ]);
  assert.deepEqual(await Promise.all(state.links.map((link) => link.blob.text())), [
    "video:episode-1-opening", "video:episode-1-sixth", "video:episode-2-opening",
  ]);
  assert.deepEqual(state.links.map((link) => link.blob), [first, sixth, second].map((item) => state.blobs.get(item.id)));
  assert.deepEqual(state.marks, [[first.id], [sixth.id], [second.id]]);
  assert.deepEqual([...result.downloadedTaskIds], [first.id, sixth.id, second.id]);
});

test("episode filenames stay fixed when newly completed downloads and full redownloads change the list index", async () => {
  const first = { ...task("opening", firstOpening, 1, 10), status: "processing" };
  const sixth = task("sixth", firstRemainder, 6, 20);
  const second = { ...task("next-episode", secondEpisode, 1, 30), status: "processing" };
  const tasks = [second, sixth, first];
  const state = downloadContext(tasks);
  await state.download(tasks, "first-finished");
  assert.equal(state.links[0].name, "001-第006节-seedance-2.5.mp4");

  first.status = "completed";
  second.status = "completed";
  await state.download(tasks, "newly-finished");
  assert.deepEqual(state.calls.slice(1), [first, second].map(taskContentRequestUrl));
  assert.deepEqual(state.links.slice(1).map((link) => link.name), [
    "001-第001节-seedance-2.5.mp4", "002-第001节-seedance-2.5.mp4",
  ]);

  await state.download(tasks, "complete", "合集", { includeDownloaded: true });
  assert.deepEqual(state.calls.slice(3), [first, sixth, second].map(taskContentRequestUrl));
  assert.deepEqual(state.links.slice(3).map((link) => link.name), [
    "001-第001节-seedance-2.5.mp4", "001-第006节-seedance-2.5.mp4", "002-第001节-seedance-2.5.mp4",
  ]);
  assert.equal(state.links[0].name, state.links[4].name);
  assert.equal(state.links[0].blob, state.links[4].blob);
  assert.deepEqual(state.marks, [[sixth.id], [first.id], [second.id], [first.id], [sixth.id], [second.id]]);
});

test("a same-section fallback supplies its own bytes while keeping the requested episode and section name", async () => {
  const fallback = task("fallback", "备用记录", 1, 10);
  const requested = { ...task("requested", secondEpisode, 1, 20), downloadAlternatives: [fallback] };
  const state = downloadContext([requested, fallback], [requested.id]);
  const result = await state.download([requested], "fallback");

  assert.deepEqual(state.calls, [requested, fallback].map(taskContentRequestUrl));
  assert.equal(state.links[0].name, "002-第001节-seedance-2.5.mp4");
  assert.equal(state.links[0].blob, state.blobs.get(fallback.id));
  assert.equal(await state.links[0].blob.text(), "video:fallback");
  assert.deepEqual(state.marks, [[requested.id, fallback.id]]);
  assert.deepEqual([...result.downloadedTaskIds], [requested.id]);
});

test("an old sourceName-only episode record keeps its episode and section when falling back", async () => {
  const fallback = task("source-name-fallback", "备用记录", 6, 10);
  const requested = {
    ...task("source-name-requested", undefined, 6, 20),
    sourceName: secondEpisode,
    downloadAlternatives: [fallback],
  };
  const state = downloadContext([requested, fallback], [requested.id]);
  const result = await state.download([requested], "source-name-fallback");

  assert.deepEqual(state.calls, [requested, fallback].map(taskContentRequestUrl));
  assert.equal(state.links[0].name, "002-第006节-seedance-2.5.mp4");
  assert.equal(state.links[0].blob, state.blobs.get(fallback.id));
  assert.equal(await state.links[0].blob.text(), "video:source-name-fallback");
  assert.deepEqual(state.marks, [[requested.id, fallback.id]]);
  assert.deepEqual([...result.downloadedTaskIds], [requested.id]);
});

test("real download flow preserves existing chapter filenames", async () => {
  const chapter = { ...task("chapter", "第07章_15秒视频提示词", 6), title: "第6节-seedance-2.5" };
  const state = downloadContext([chapter]);
  await state.download([chapter], "legacy");

  assert.deepEqual(state.calls, [taskContentRequestUrl(chapter)]);
  assert.equal(state.links[0].name, "07章-第06节-seedance-2.5.mp4");
  assert.equal(state.links[0].blob, state.blobs.get(chapter.id));
  assert.deepEqual(state.marks, [[chapter.id]]);
});

test("both single-video download buttons use the persistent success-based download flow", () => {
  assert.equal((source.match(/downloadTaskCollection\(\[task\], `task-\$\{task.id\}`, "视频", \{ includeDownloaded: true \}\)/g) || []).length, 2);
  assert.ok(!source.includes('<a className="download-button"'));
});

test("a failed content download never marks a video as downloaded", async () => {
  const video = task("unavailable-video", firstOpening, 1);
  const state = downloadContext([video], [video.id]);
  const result = await state.download([video], "single-failed", "视频", { includeDownloaded: true });
  assert.equal(state.links.length, 0);
  assert.equal(state.marks.length, 0);
  assert.deepEqual([...result.downloadedTaskIds], []);
  assert.equal(video.downloadedAtMs, undefined);
});

test("a failed browser download never saves a success mark", async () => {
  const video = task("browser-failed", firstOpening, 1);
  const state = downloadContext([video]);
  state.context.downloadBlob = async () => { throw new Error("模拟下载失败"); };
  const result = await state.download([video], "single-browser-failed", "视频", { includeDownloaded: true });
  assert.equal(state.marks.length, 0);
  assert.deepEqual([...result.downloadedTaskIds], []);
});

test("a failed download-record write is reported instead of claiming a persisted success", async () => {
  const video = task("write-failed", firstOpening, 1);
  const state = downloadContext([video]);
  const notices = [];
  state.context.setNotice = (value) => notices.push(value);
  state.context.markTasksDownloaded = async () => { throw new Error("模拟数据库写入失败"); };
  const result = await state.download([video], "single-write-failed", "视频", { includeDownloaded: true });
  assert.equal(state.links.length, 1);
  assert.deepEqual([...result.downloadedTaskIds], []);
  assert.match(notices.at(-1), /下载记录未能保存/);
});
