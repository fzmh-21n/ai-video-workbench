import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import * as batchReferences from "../src/batchReferences.js";
import { imageReferenceIssues, normalizeImageReferenceBindings, planProjectReferences } from "../src/projectReferences.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
const names = Array.from({ length: 31 }, (_, index) => `角色图_${String(index + 1).padStart(3, "0")}_人物${index + 1}.png`);
const assets = names.map((name) => ({ key: `image:${name}`, kind: "image", name, stem: name.slice(0, -4), file: new File([name], name, { type: "image/png" }) }));
const references = (count) => batchReferences.reindexBatchReferences(assets.slice(0, count).map((asset) => ({ id: asset.key, kind: "image", name: asset.name, alias: asset.stem, projectAssetKey: asset.key, source: "automatic" })));
const item = (count, total = 10) => ({ id: "row", section: 1, title: "容量测试", sourceName: "第1集.txt", status: "matched", prompt: `【出场人物】\n${names.slice(0, total).join("、")}`, references: references(count) });
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function context(images = 9) {
  const ctx = vm.createContext({
    capability: { images, audios: 3, videos: 3 }, allowMissingImages: false, projectAssets: assets,
    KINDS: ["image", "audio", "video"], LABELS: { image: "图片", audio: "音频", video: "视频" },
    imageReferenceIssues, batchImageReferenceIssues: batchReferences.batchImageReferenceIssues,
    reindex: batchReferences.reindexBatchReferences, reconcileBatchReferenceTags: batchReferences.reconcileBatchReferenceTags,
    normalizeImageReferenceBindings, planProjectReferences, readMediaDuration: async () => null,
    uid: (() => { let next = 0; return () => `ref-${++next}`; })(),
  });
  vm.runInContext(extract("function countsFor(", "function withDownloadedFlags("), ctx);
  vm.runInContext(extract("  function issueFor(", "  async function submitOne("), ctx);
  vm.runInContext(extract("  async function matchItem(", "  async function matchAudioItem("), ctx);
  return ctx;
}

test("deleting an over-limit image down to nine clears the warning; deleting another restores genuine missing-image checks", () => {
  const ctx = context();
  let rows = [item(10)];
  ctx.setItems = (update) => { rows = update(rows); };
  vm.runInContext(extract("  function removeItemReference(", "  function resolveFile("), ctx);
  assert.equal(ctx.issueFor(rows[0]), "图片 10/9");
  ctx.removeItemReference("row", rows[0].references[9].id);
  assert.equal(rows[0].references.length, 9);
  assert.equal(ctx.issueFor(rows[0]), "");
  assert.deepEqual(batchReferences.batchImageReferenceIssues(rows[0], assets, 9), []);
  ctx.removeItemReference("row", rows[0].references[8].id);
  assert.match(ctx.issueFor(rows[0]), /缺少图片/);
  assert.deepEqual(batchReferences.batchImageReferenceIssues(rows[0], assets, 9), names.slice(8, 10));
});

test("only image references count toward capacity, and a full image set does not swallow audio/video limits", () => {
  const ctx = context();
  const full = item(9);
  full.references.push(...Array.from({ length: 4 }, (_, index) => ({ kind: "audio", name: `声音${index}.wav` })));
  assert.equal(ctx.issueFor(full), "音频 4/3");
  const notFull = item(8);
  notFull.references.push({ kind: "audio", name: "声音.wav" }, { kind: "video", name: "动作.mp4" });
  assert.match(ctx.issueFor(notFull), /缺少图片/);
  ctx.capability.videos = 0;
  assert.equal(ctx.issueFor(notFull), "视频 1/0");
});

test("the current model's capacity is reapplied after a model switch rather than caching a nine-image exemption", () => {
  const ctx = context();
  const row = item(9);
  assert.equal(ctx.issueFor(row), "");
  ctx.capability.images = 30;
  assert.match(ctx.issueFor(row), /缺少图片/);
  assert.equal(ctx.issueFor(item(30, 31)), "");
  ctx.capability.images = 9;
  assert.equal(ctx.issueFor(item(30, 31)), "图片 30/9");
});

test("zero and unknown image capacities keep validation, and the single-task image validator is unchanged", () => {
  for (const limit of [0, undefined]) assert.deepEqual(batchReferences.batchImageReferenceIssues(item(0), assets, limit), names.slice(0, 10));
  assert.equal(context(0).issueFor(item(1)), "图片 1/0");
  assert.deepEqual(imageReferenceIssues(item(9).prompt, assets, item(9).references), [names[9]]);
});

test("newly imported unmatched rows do not report missing images before matching", () => {
  assert.deepEqual(batchReferences.batchImageReferenceIssues({ ...item(0), status: "unmatched" }, assets, 9), []);
  assert.equal(context().issueFor({ ...item(0), status: "unmatched" }), "");
});

test("matching notifications store capacity-aware missing results, but retain missing names below the limit", async () => {
  const ctx = context();
  ctx.projectAssets = assets.slice(0, 9);
  const matched = await ctx.matchItem({ ...item(0), status: "unmatched" });
  assert.equal(matched.references.length, 9);
  assert.deepEqual(Array.from(matched.missingImages), []);
  ctx.projectAssets = assets.slice(0, 8);
  const missing = await ctx.matchItem({ ...item(0), status: "unmatched" });
  assert.deepEqual(Array.from(missing.missingImages), names.slice(8, 10));
});

test("every below-limit row is blocked even when array filtering passes an index as the second argument", async () => {
  const ctx = context();
  const rows = [item(8), { ...item(8), id: "second", section: 2 }];
  assert.equal(rows.filter(ctx.issueFor).length, 2);
  const notices = [];
  ctx.apiKey = "local-fixture";
  ctx.canBatchSubmit = () => true;
  ctx.onNotice = (message) => notices.push(message);
  ctx.fetch = () => { throw new Error("No paid request should occur"); };
  vm.runInContext(extract("  async function submitSelected(", "\n  useEffect(() => {"), ctx);
  await ctx.submitSelected(rows);
  assert.deepEqual(notices, ["没有可提交章节，请先处理标红问题"]);
});

test("the real cards, missing badges and generation button share the capacity-aware result", async () => {
  const previousStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  let row;
  globalThis.window = {};
  globalThis.localStorage = { getItem: (key) => key === "video-workbench-batch-v1" ? JSON.stringify({ items: [row] }) : null };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { default: BatchPanel } = await vite.ssrLoadModule("/src/BatchPanel.jsx");
    const render = (count, images = 9, status = "matched") => {
      row = { ...item(count), expanded: true, status };
      return renderToStaticMarkup(React.createElement(BatchPanel, {
        activeProfile: { id: "mock", adapter: "mock", name: "mock", model: "mock" }, apiKey: "",
        capability: { images, audios: 3, videos: 3, durations: [15], resolutions: ["720p"], ratios: ["16:9"] },
        duration: 15, resolution: "720p", ratio: "16:9", quantity: 1, seed: "", syncAudio: false,
        fixedContent: "", fixedContentTemplates: [], fixedContentTemplateId: "", projectAssets: assets, taskDatabaseReady: false,
      })).match(/<article\b[\s\S]*?<\/article>/)[0];
    };
    const full = render(9);
    assert.ok(!full.includes("batch-missing-badge"));
    assert.ok(!full.includes("has-issue"));
    assert.ok(!full.includes("缺少图片"));
    assert.match(full, /<button(?![^>]*disabled)[^>]*>开始生成本节/);
    const below = render(8);
    assert.match(below, /batch-missing-badge/);
    assert.match(below, /缺少图片/);
    assert.match(below, /<button[^>]*disabled[^>]*>开始生成本节/);
    assert.match(render(10), /图片 10\/9/);
    assert.match(render(9, 30), /缺少图片/);
    assert.ok(!render(0, 9, "unmatched").includes("batch-missing-badge"));
  } finally {
    await vite.close();
    globalThis.localStorage = previousStorage;
    globalThis.window = previousWindow;
  }
});
