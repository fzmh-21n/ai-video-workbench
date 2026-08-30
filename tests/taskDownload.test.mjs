import assert from "node:assert/strict";
import test from "node:test";

import {
  batchItemDownloadCandidates,
  downloadTaskBuckets,
  orderedDownloadFilename,
  orderedDownloadTasks,
  preferredBatchDownloadTasks,
} from "../src/taskDownload.js";

test("downloads completed batch videos in numeric chapter order", () => {
  const ordered = orderedDownloadTasks([
    { title: "第89节-juzi_pool", batchSection: 89, batchOrder: 890 },
    { title: "第81节-juzi_pool", batchSection: 81, batchOrder: 810 },
    { title: "第86节-juzi_pool", batchSection: 86, batchOrder: 860 },
  ]);
  assert.deepEqual(ordered.map((task) => task.batchSection), [81, 86, 89]);
});

test("uses fixed-width sequence and chapter numbers in download filenames", () => {
  assert.equal(
    orderedDownloadFilename({ title: "第86节-juzi_pool" }, 9, 12),
    "010-第086节-juzi_pool.mp4",
  );
});

test("sorts a mixed batch by source chapter before section", () => {
  const ordered = orderedDownloadTasks([
    { title: "第1节-model", batchTitle: "第08章_15秒视频提示词.txt", batchSection: 1 },
    { title: "第2节-model", batchTitle: "第07章_15秒视频提示词.txt", batchSection: 2 },
    { title: "第1节-model", batchTitle: "第07章_15秒视频提示词.txt", batchSection: 1 },
  ]);
  assert.deepEqual(ordered.map((task) => `${task.batchTitle}:${task.batchSection}`), [
    "第07章_15秒视频提示词.txt:1",
    "第07章_15秒视频提示词.txt:2",
    "第08章_15秒视频提示词.txt:1",
  ]);
});

test("prefixes mixed-chapter downloads with the source chapter", () => {
  assert.equal(
    orderedDownloadFilename({ title: "第1节-feimiao-v2-fast-720p-15s", batchTitle: "第07章_15秒视频提示词_紧凑版" }, 0, 20),
    "07章-第01节-feimiao-v2-fast-720p-15s.mp4",
  );
  assert.equal(
    orderedDownloadFilename({ title: "第1节-feimiao-v2-fast-720p-15s", batchTitle: "第08章_15秒视频提示词_紧凑版" }, 9, 20),
    "08章-第01节-feimiao-v2-fast-720p-15s.mp4",
  );
});

test("uses chapter and section names for leading-number and Chinese chapter filenames", () => {
  assert.equal(
    orderedDownloadFilename({ title: "第1节-model", batchTitle: "02_第二章_15秒视频提示词_紧凑版", batchSection: 1 }, 0, 3),
    "02章-第01节-model.mp4",
  );
  assert.equal(
    orderedDownloadFilename({ title: "视频-model", batchTitle: "第十二章_15秒视频提示词", batchSection: 3 }, 1, 3),
    "12章-第03节-视频-model.mp4",
  );
});

test("skips videos that were already downloaded and keeps newly completed videos", () => {
  const result = downloadTaskBuckets([
    { id: "new", status: "completed", videoUrl: "/video/new", batchSection: 2 },
    { id: "proxy-only", status: "completed", batchSection: 3 },
    { id: "done", status: "completed", videoUrl: "/video/done", downloadedAtMs: 123, batchSection: 1 },
    { id: "failed", status: "failed", videoUrl: "" },
  ]);
  assert.deepEqual(result.pending.map((task) => task.id), ["new", "proxy-only"]);
  assert.deepEqual(result.alreadyDownloaded.map((task) => task.id), ["done"]);
  assert.deepEqual(result.unavailable.map((task) => task.id), ["failed"]);
});

test("can explicitly include already downloaded videos for a complete ordered redownload", () => {
  const result = downloadTaskBuckets([
    { id: "section-2", status: "completed", downloadedAtMs: 123, batchSection: 2 },
    { id: "section-1", status: "completed", downloadedAtMs: 456, batchSection: 1 },
  ], { includeDownloaded: true });
  assert.deepEqual(result.pending.map((task) => task.id), ["section-1", "section-2"]);
  assert.deepEqual(result.alreadyDownloaded, []);
});

test("final chapter download prefers the newest successful retry and keeps older successes as fallbacks", () => {
  const item = { section: 3, sourceName: "02_第二章_15秒视频提示词_紧凑版.txt", taskIds: ["old"] };
  const stored = [
    { id: "old", status: "completed", batchTitle: "02_第二章_15秒视频提示词_紧凑版", batchSection: 3, projectName: "项目甲", createdAtMs: 10 },
    { id: "new", status: "completed", batchTitle: "02_第二章_15秒视频提示词_紧凑版", batchSection: 3, projectName: "项目甲", sourceVideoUrl: "https://example.com/new.mp4", createdAtMs: 20 },
    { id: "other-project", status: "completed", batchTitle: "02_第二章_15秒视频提示词_紧凑版", batchSection: 3, projectName: "项目乙", createdAtMs: 30 },
  ];
  assert.deepEqual(batchItemDownloadCandidates(item, stored).map((task) => task.id), ["new", "old"]);
  const [selected] = preferredBatchDownloadTasks([item], stored);
  assert.equal(selected.id, "new");
  assert.deepEqual(selected.downloadAlternatives.map((task) => task.id), ["old"]);
});

test("one downloaded retry marks the chapter downloaded instead of requiring every old attempt", () => {
  const item = { section: 1, sourceName: "第八章.txt", taskIds: ["old"] };
  const stored = [
    { id: "old", status: "completed", batchTitle: "第八章", batchSection: 1, projectName: "项目甲", createdAtMs: 10 },
    { id: "downloaded", status: "completed", batchTitle: "第八章", batchSection: 1, projectName: "项目甲", downloadedAtMs: 99, createdAtMs: 20 },
  ];
  assert.equal(preferredBatchDownloadTasks([item], stored)[0].id, "downloaded");
});
