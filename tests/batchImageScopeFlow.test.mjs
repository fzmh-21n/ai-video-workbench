import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { batchImageReferenceIssues, reindexBatchReferences, reconcileBatchReferenceTags } from "../src/batchReferences.js";
import { normalizeImageReferenceBindings, planProjectReferences } from "../src/projectReferences.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
const filenames = ["角色图_001_许小禾日常.png", "角色图_006_岑月娘.png", "角色图_007_方桂枝日常.png", "角色图_011_苏芙蓉_v2.png", "场景图_003_望春前厅日间四视角.png"];
const propImage = "角色图_002_许小禾样衣_v2.png";
const prompt = `【出场人物】：\n${filenames.slice(0, 4).map((name) => `@${name.slice(0, -4)}=${name}`).join("、")}。现场四人，不增加其他人物。\n【出场场景】：\n${filenames[4]}\n【场景环境】：\n${propImage}仅提取浅绿碎花样衣和纸包糖作为道具外观；图中试穿人物不作为现场角色。\n【镜头】：\n人物资产只使用${filenames.slice(0, 4).join("、")}；${propImage}仅提取样衣作为道具外观。`;
const projectAssets = [...filenames, propImage].map((name) => ({ key: `image:${name}`, kind: "image", name, stem: name.slice(0, -4), file: new File([name], name, { type: "image/png" }) }));
const references = reindexBatchReferences(projectAssets.slice(0, 5).map((asset) => ({ id: asset.key, projectAssetKey: asset.key, source: "automatic", kind: "image", name: asset.name, alias: asset.stem })));
const row = { id: "one", section: 1, title: "衣架被夺，岑月娘伸手取回", sourceName: "第1集.txt", prompt, status: "matched", references, missingImages: [propImage], expanded: true };
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function context() {
  const ctx = vm.createContext({ projectAssets, batchImageReferenceIssues, normalizeImageReferenceBindings, planProjectReferences,
    reindex: reindexBatchReferences, reconcileBatchReferenceTags, readMediaDuration: async () => null,
    uid: (() => { let next = 0; return () => `ref-${++next}`; })(), capability: { images: 9, audios: 3, videos: 3 },
    KINDS: ["image", "audio", "video"], LABELS: { image: "图片", audio: "音频", video: "视频" }, allowMissingImages: false,
  });
  vm.runInContext(extract("function countsFor(", "function withDownloadedFlags("), ctx);
  vm.runInContext(extract("  async function matchItem(", "  async function matchAudioItem("), ctx);
  vm.runInContext(extract("  function issueFor(", "  async function submitOne("), ctx);
  return ctx;
}

test("the actual batch matcher connects declared images and adds the prop-only outfit without mentioning it", async () => {
  const ctx = context();
  const matched = await ctx.matchItem({ ...row, references: [], status: "unmatched" });
  assert.deepEqual(Array.from(matched.references, (reference) => reference.name), [...filenames, propImage]);
  assert.equal(matched.references.at(-1).noAutoMention, true);
  assert.deepEqual(Array.from(matched.missingImages), []);
  assert.ok(matched.prompt.includes(`${propImage}仅提取`), "do not delete or rewrite the user's prop instructions");
  assert.ok(!matched.prompt.includes(`@${propImage.slice(0, -4)}=`), "do not auto-connect a character merely mentioned outside the declared modules");
  assert.equal(ctx.issueFor(matched), "");
  assert.equal(ctx.issueFor(row), "", "stale persisted missing-image results must not revive the warning");
});

test("below-capacity submission checks still block a real declared missing image and an unconnected native reference", () => {
  const ctx = context();
  const declared = { ...row, prompt: prompt.replace("现场四人", `${propImage}。现场四人`) };
  assert.equal(ctx.issueFor(declared), `缺少图片：${propImage}`);
  assert.equal(ctx.issueFor({ ...row, prompt: `${prompt}\n【其他说明】动作参考@Image6。` }), "缺少图片：@Image6");
});

test("the actual saved batch card removes false warnings without rematching or editing its prompt", async () => {
  const previousStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  globalThis.window = {};
  globalThis.localStorage = { getItem: (key) => key === "video-workbench-batch-v1" ? JSON.stringify({ items: [row] }) : null };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { default: BatchPanel } = await vite.ssrLoadModule("/src/BatchPanel.jsx");
    const html = renderToStaticMarkup(React.createElement(BatchPanel, {
      activeProfile: { id: "mock", adapter: "mock", name: "mock", model: "mock" }, apiKey: "",
      capability: { images: 9, audios: 3, videos: 3, durations: [30], resolutions: ["720p"], ratios: ["16:9"] },
      duration: 30, resolution: "720p", ratio: "16:9", quantity: 1, seed: "", syncAudio: false,
      fixedContent: "", fixedContentTemplates: [], fixedContentTemplateId: "", projectAssets, taskDatabaseReady: false,
    }));
    const card = html.match(/<article\b[\s\S]*?<\/article>/)[0];
    assert.ok(!card.includes("batch-missing-badge"));
    assert.ok(!card.includes("has-issue"));
    assert.ok(!card.includes("缺少图片"));
    assert.ok(card.includes(propImage));
    assert.match(card, /图5/);
    assert.match(card, /<button(?![^>]*disabled)[^>]*>开始生成本节/);
  } finally {
    await vite.close();
    globalThis.localStorage = previousStorage;
    globalThis.window = previousWindow;
  }
});
