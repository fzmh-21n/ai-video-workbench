import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

import { batchImageReferenceIssues, reindexBatchReferences as reindex, reconcileBatchReferenceTags } from "../src/batchReferences.js";
import { imageReferenceIssues, internalizeProjectAliases, normalizeImageReferenceBindings, planProjectReferences } from "../src/projectReferences.js";

const batchSource = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const filenames = ["角色图_047_学生家属群像.png", "角色图_002_学生.png", "场景图_008_教室四视角.png"];
const stems = filenames.map((name) => name.slice(0, -4));
const prompt = `【出场人物】：始终只使用${stems[0]}中的S.B.C；(${stems[1]})站在前排。\n【出场场景】：将${stems[2]}作为唯一背景，原文句号.英文ABC不改。\n【镜头】：现有素材@Image1；音频@Audio1。`;
const annotatedPrompt = `【出场人物】：始终只使用@${stems[0]}=${stems[0]}中的S.B.C；(@${stems[1]}=${stems[1]})站在前排。\n【出场场景】：将@${stems[2]}=${stems[2]}作为唯一背景，原文句号.英文ABC不改。\n【镜头】：现有素材@Image1；音频@Audio1。`;

function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must come from the actual component`);
  return source.slice(start, end);
}

function context(single = false, images = 30) {
  const projectAssets = filenames.map((name) => ({
    key: `image:${name}`, kind: "image", name, stem: name.slice(0, -4),
    file: new File([`fixture:${name}`], name, { type: "image/png" }),
  }));
  const manual = reindex(["image", "audio"].map((kind) => ({
    id: `manual-${kind}`, source: "manual", kind, name: kind === "image" ? "手工插图.png" : "声音3.mp3",
    file: new File([`fixture:manual-${kind}`], kind === "image" ? "手工插图.png" : "声音3.mp3"),
  })));
  const requests = [];
  const notices = [];
  let sequence = 0;
  const ctx = vm.createContext({
    projectAssets, references: single && images === 30 ? manual : [], prompt, reindex, reconcileBatchReferenceTags,
    imageReferenceIssues, batchImageReferenceIssues, internalizeProjectAliases, normalizeImageReferenceBindings, planProjectReferences,
    readMediaDuration: async () => null, uid: (prefix) => `${prefix}-${++sequence}`,
    parametersFor: () => ({ duration: 15, resolution: "720p", ratio: "16:9", quantity: 1, syncAudio: true }),
    duration: 15, resolution: "720p", ratio: "16:9", seed: "", quantity: 1, syncAudio: true,
    fixedContent: "", autoReference: true, FormData, performance, headers: {}, submissionMode: "ordered",
    activeProfile: { id: "mock", adapter: "lwaigc", name: "本地测试", model: "mock" },
    recordDiagnostic: () => {}, diagnosticHeaders: () => ({}), headersFor: () => ({}), keyFor: () => "local-mock-only",
    uploadKey: (_item, reference) => reference.id,
    resolveFile: (reference) => reference.file || projectAssets.find((asset) => asset.key === reference.projectAssetKey)?.file,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: false, status: 400, json: async () => ({ message: "Local mock stops before task creation" }) };
    },
    KINDS: ["image", "audio", "video"], LABELS: { image: "图片", audio: "音频", video: "视频" },
    capability: { images, audios: 10, videos: 10 }, allowMissingImages: false,
    REFERENCE_LIMITS: { image: 30, audio: 10, video: 10 }, MAX_TOTAL_BYTES: 200 * 1024 * 1024,
    URL: { createObjectURL: () => "blob:local-fixture" }, setSubmitting: () => {},
    setNotice: (notice) => notices.push(notice), onNotice: (notice) => notices.push(notice),
    setPrompt: (value) => { ctx.prompt = value; },
    setReferences: (update) => {
      ctx.references = update(ctx.references);
      ctx.referenceCounts = Object.fromEntries(["image", "audio", "video"].map((kind) => [kind, ctx.references.filter((item) => item.kind === kind).length]));
    },
  });
  if (single) {
    for (const [start, end] of [
      ["function reindexReferences(", "function visibleReferenceTag("],
      ["  async function applyProjectReferencePlan(", "  async function runOneClickAudioReference("],
      ["  async function submitTask(", "  async function loadVideo("],
    ]) vm.runInContext(extract(appSource, start, end), ctx);
  } else {
    for (const [start, end] of [
      ["function countsFor(", "function withDownloadedFlags("],
      ["  async function matchItem(", "  async function matchAudioItem("],
      ["  function issueFor(", "  async function submitOne("],
      ["  async function submitOne(", "  async function submitSelected("],
    ]) vm.runInContext(extract(batchSource, start, end), ctx);
  }
  return { ctx, manual, requests, notices };
}

async function assertForm(request, references, expectedPrompt) {
  assert.equal(request.url, "/api/tasks");
  const form = request.options.body;
  assert.equal(form.get("prompt"), expectedPrompt);
  const metadata = JSON.parse(form.get("referenceMeta"));
  const files = form.getAll("references");
  assert.deepEqual(metadata.map(({ tag, kind, name, fileIndex }) => ({ tag, kind, name, fileIndex })), Array.from(references, ({ tag, kind, name }, index) => ({ tag, kind, name, fileIndex: index })));
  assert.equal(files.length, references.length);
  for (const [index, reference] of references.entries()) {
    assert.equal(files[index].name, reference.name);
    assert.equal(await files[index].text(), reference.file ? await reference.file.text() : `fixture:${reference.name}`);
  }
}

test("real batch embedded-name matching, rematching and form submission preserve prose and reconcile existing numbered materials", async () => {
  const { ctx, manual, requests } = context();
  const first = await ctx.matchItem({ id: "embedded", section: 1, prompt, references: manual });
  assert.deepEqual(Array.from(first.references, (item) => item.name), [...filenames, ...manual.map((item) => item.name)]);
  assert.equal(first.prompt, annotatedPrompt.replace("现有素材@Image1", "现有素材@Image4"));
  const second = await ctx.matchItem(first);
  assert.equal(second.prompt, first.prompt);
  assert.deepEqual(Array.from(second.references, ({ tag, name }) => ({ tag, name })), Array.from(first.references, ({ tag, name }) => ({ tag, name })));
  assert.deepEqual(Array.from(second.missingImages), []);
  assert.equal(ctx.issueFor(second), "");
  await assert.rejects(ctx.submitOne(second, "local-mock", {}, 0, 0), /Local mock stops/);
  assert.equal(requests.length, 1);
  const expected = first.prompt.replace(`@${stems[0]}`, "@Image1").replace(`@${stems[1]}`, "@Image2").replace(`@${stems[2]}`, "@Image3");
  await assertForm(requests[0], second.references, expected);
});

test("real single one-click reference and submission attach embedded names without shifting existing image or audio numbers", async () => {
  const { ctx, manual, requests } = context(true);
  await ctx.runOneClickReference();
  assert.equal(ctx.prompt, annotatedPrompt);
  assert.deepEqual(Array.from(ctx.references, (item) => item.name), [...manual.map((item) => item.name), ...filenames]);
  assert.deepEqual(imageReferenceIssues(ctx.prompt, ctx.projectAssets, ctx.references), []);
  const firstPrompt = ctx.prompt;
  await ctx.runOneClickReference();
  assert.equal(ctx.prompt, firstPrompt);
  await ctx.submitTask();
  assert.equal(requests.length, 1);
  const expected = annotatedPrompt.replace(`@${stems[0]}`, "@Image2").replace(`@${stems[1]}`, "@Image3").replace(`@${stems[2]}`, "@Image4");
  await assertForm(requests[0], ctx.references, expected);
});

test("batch matching annotates an embedded project image already uploaded manually without duplicating it or losing its binding", async () => {
  const { ctx, manual, requests } = context();
  const manualFamily = { ...manual[0], name: filenames[0], file: ctx.projectAssets[0].file };
  const first = await ctx.matchItem({ id: "manual-embedded", section: 1, prompt, references: [manualFamily, manual[1]] });
  assert.equal(first.prompt, annotatedPrompt.replace("现有素材@Image1", "现有素材@Image3"));
  assert.equal(first.references.filter((item) => item.name === filenames[0]).length, 1);
  const family = first.references.find((item) => item.id === manualFamily.id);
  assert.equal(family.source, "manual");
  assert.equal(family.alias, stems[0]);
  assert.equal(family.file, manualFamily.file);
  const second = await ctx.matchItem(first);
  assert.equal(second.prompt, first.prompt);
  assert.deepEqual(Array.from(second.references, ({ tag, name, source, alias }) => ({ tag, name, source, alias })), Array.from(first.references, ({ tag, name, source, alias }) => ({ tag, name, source, alias })));
  assert.equal(ctx.issueFor(second), "");
  await assert.rejects(ctx.submitOne(second, "local-mock", {}, 0, 0), /Local mock stops/);
  assert.equal(requests.length, 1);
  const expected = first.prompt.replace(`@${stems[0]}`, "@Image3").replace(`@${stems[1]}`, "@Image1").replace(`@${stems[2]}`, "@Image2");
  await assertForm(requests[0], second.references, expected);
});

test("single submission blocks embedded aliases that were annotated but could not be attached due to image capacity", async () => {
  const { ctx, requests, notices } = context(true, 1);
  ctx.prompt = prompt.replace("【镜头】：现有素材@Image1；音频@Audio1。", "【镜头】：无额外参考。");
  await ctx.runOneClickReference();
  assert.equal(ctx.references.length, 1);
  assert.ok(ctx.prompt.includes(`@${stems[1]}=${stems[1]}`));
  assert.deepEqual(imageReferenceIssues(ctx.prompt, ctx.projectAssets, ctx.references), filenames.slice(1));
  await ctx.submitTask();
  assert.equal(requests.length, 0);
  assert.ok(notices.at(-1).startsWith("参考图片尚未全部连接，未提交任务："));
});
