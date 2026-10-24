import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

import { batchImageReferenceIssues, reindexBatchReferences as reindex, reconcileBatchReferenceTags } from "../src/batchReferences.js";
import { imageReferenceIssues, internalizeProjectAliases, normalizeImageReferenceBindings, planProjectReferences } from "../src/projectReferences.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
const filenames = [
  "角色图_001_陈凡现代旧装版.png",
  "角色图_015_红姐豹纹吊带版.png",
  "角色图_037_纹身壮汉甲.png",
  "角色图_038_纹身壮汉乙.png",
  "场景图_001_低价酒店客房原状.png",
  "场景图_002_低价酒店客房开门版.png",
];
const peopleDirection = "01—05只有陈凡和红姐；06甲乙从门口实际进入，06—08四人始终在场。不开口者保持倾听、目光和即时反应；警察尚未到场。";
const roomDirection = "同一客房的门状态变化，不另换房间。";
const prompt = [
  "【出场人物】：",
  "@角色图_001_陈凡现代旧装版=角色图_001_陈凡现代旧装版.png、@角色图_015_红姐豹纹吊带版=角色图_015_红姐豹纹吊带版.png、@角色图_037_纹身壮汉甲=角色图_037_纹身壮汉甲.png、@角色图_038_纹身壮汉乙=角色图_038_纹身壮汉乙.png。",
  peopleDirection,
  "",
  "【出场场景】：",
  `场景图_001_低价酒店客房原状.png→06踹门后使用场景图_002_低价酒店客房开门版.png；${roomDirection}`,
].join("\n");

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be extracted from the real batch component`);
  return source.slice(start, end);
}

function context(names = filenames) {
  const projectAssets = names.map((name) => ({
    key: `image:${name}`, kind: "image", name, stem: name.slice(0, -4),
    file: new File([`fixture:${name}`], name, { type: "image/png" }),
  }));
  const requests = [];
  const notices = [];
  let uidSequence = 0;
  const ctx = vm.createContext({
    projectAssets, reindex, reconcileBatchReferenceTags, imageReferenceIssues, batchImageReferenceIssues,
    internalizeProjectAliases, normalizeImageReferenceBindings, planProjectReferences,
    readMediaDuration: async () => null, uid: (prefix) => `${prefix}-${++uidSequence}`,
    parametersFor: () => ({ duration: 15, resolution: "720p", ratio: "16:9", quantity: 1, syncAudio: true }),
    fixedContent: "", autoReference: true, FormData, performance, headers: {}, submissionMode: "ordered",
    activeProfile: { id: "mock", adapter: "lwaigc", name: "本地测试", model: "mock" },
    recordDiagnostic: () => {}, diagnosticHeaders: () => ({}),
    uploadKey: (_item, reference) => reference.id,
    resolveFile: (reference) => reference.file || projectAssets.find((asset) => asset.key === reference.projectAssetKey)?.file,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: false, status: 400, json: async () => ({ message: "Local mock stops before task creation" }) };
    },
    KINDS: ["image", "audio", "video"], LABELS: { image: "图片", audio: "音频", video: "视频" },
    capability: { images: 30, audios: 10, videos: 10 }, allowMissingImages: false,
    apiKey: "local-mock-only", canBatchSubmit: (item) => item.status === "matched", canBatchResubmit: () => false,
    onNotice: (notice) => notices.push(notice),
  });
  vm.runInContext(extract("function countsFor(", "function withDownloadedFlags("), ctx);
  vm.runInContext(extract("  async function matchItem(", "  async function matchAudioItem("), ctx);
  vm.runInContext(extract("  function issueFor(", "  async function submitOne("), ctx);
  vm.runInContext(extract("  async function submitOne(", "  async function submitSelected("), ctx);
  vm.runInContext(extract("  async function submitSelected(", "\n  useEffect(() => {"), ctx);
  return { ctx, requests, notices };
}

function bindings(item) {
  return Array.from(item.references, ({ tag, name, projectAssetKey }) => ({ tag, name, projectAssetKey }));
}

test("real batch matching separates four declared people and two arrow-linked scene states without losing direction text", async () => {
  const { ctx } = context();
  const matched = await ctx.matchItem({ id: "section", section: 1, prompt, references: [], status: "unmatched" });
  assert.deepEqual(Array.from(matched.references, (reference) => reference.name), filenames);
  assert.deepEqual(Array.from(matched.references, (reference) => reference.tag), filenames.map((_name, index) => `@Image${index + 1}`));
  assert.deepEqual(Array.from(matched.missingImages), []);
  assert.equal(ctx.issueFor(matched), "");
  assert.ok(matched.prompt.includes(peopleDirection), "shot-presence, silent reactions and excluded police must remain verbatim");
  assert.ok(matched.prompt.includes(roomDirection));
  const translated = internalizeProjectAliases(matched.prompt, matched.references);
  assert.ok(translated.includes(`@Image5=${filenames[4]}→06踹门后使用@Image6=${filenames[5]}`));
});

test("real batch submission aligns all six image indices with metadata and the uploaded files, and rematching is idempotent", async () => {
  const { ctx, requests } = context();
  const first = await ctx.matchItem({ id: "section", section: 1, prompt, references: [], status: "unmatched" });
  const second = await ctx.matchItem(first);
  const third = await ctx.matchItem(second);
  assert.deepEqual(bindings(second), bindings(first));
  assert.deepEqual(bindings(third), bindings(first));
  assert.equal(second.prompt, first.prompt);
  assert.equal(third.prompt, first.prompt);
  assert.deepEqual(Array.from(third.missingImages), []);
  assert.equal(ctx.issueFor(third), "");
  await assert.rejects(ctx.submitOne(third, "mock-batch", {}, 0, 0), /Local mock stops/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/tasks");
  const form = requests[0].options.body;
  const metadata = JSON.parse(form.get("referenceMeta"));
  const files = form.getAll("references");
  assert.equal(metadata.length, 6);
  assert.equal(files.length, 6);
  assert.deepEqual(metadata.map(({ tag, kind, name, fileIndex }) => ({ tag, kind, name, fileIndex })), filenames.map((name, index) => ({
    tag: `@Image${index + 1}`, kind: "image", name, fileIndex: index,
  })));
  for (const [index, name] of filenames.entries()) {
    assert.equal(files[index].name, name);
    assert.equal(await files[index].text(), `fixture:${name}`);
    assert.ok(form.get("prompt").includes(`@Image${index + 1}=${name}`));
  }
  assert.ok(form.get("prompt").includes(peopleDirection));
  assert.ok(form.get("prompt").includes(roomDirection));
});

test("a missing second scene is reported by exact filename and the real batch entry point refuses to send any request", async () => {
  const { ctx, requests, notices } = context(filenames.slice(0, 5));
  const matched = await ctx.matchItem({ id: "section", section: 1, prompt, references: [], status: "unmatched" });
  assert.deepEqual(Array.from(matched.references, (reference) => reference.name), filenames.slice(0, 5));
  assert.deepEqual(Array.from(matched.missingImages), [filenames[5]]);
  assert.equal(ctx.issueFor(matched), `缺少图片：${filenames[5]}`);
  await ctx.submitSelected([matched]);
  assert.equal(requests.length, 0);
  assert.deepEqual(notices, ["没有可提交章节，请先处理标红问题"]);
  assert.ok(matched.prompt.includes(peopleDirection));
  assert.ok(matched.prompt.includes(roomDirection));
});

test("an already numbered first scene preserves its arrow, timing and second filename during validation and real form preparation", async () => {
  const numberedPrompt = prompt.replace(filenames[4], `@Image5=${filenames[4]}`);
  const transition = `@Image5=${filenames[4]}→06踹门后使用${filenames[5]}`;
  for (const hasSecondScene of [true, false]) {
    const { ctx, requests, notices } = context(hasSecondScene ? filenames : filenames.slice(0, 5));
    const references = reindex(ctx.projectAssets.map((asset) => ({
      id: asset.key, projectAssetKey: asset.key, kind: "image", source: "automatic", name: asset.name, alias: asset.stem,
    })));
    const item = { id: "section", section: 1, prompt: numberedPrompt, references, status: "matched" };
    assert.equal(normalizeImageReferenceBindings(item.prompt, references), numberedPrompt);
    if (hasSecondScene) {
      assert.equal(ctx.issueFor(item), "");
      await assert.rejects(ctx.submitOne(item, "mock-batch", {}, 0, 0), /Local mock stops/);
      assert.equal(requests.length, 1);
      const submittedPrompt = requests[0].options.body.get("prompt");
      assert.ok(submittedPrompt.includes(transition));
      assert.ok(submittedPrompt.includes(peopleDirection));
      assert.ok(submittedPrompt.includes(roomDirection));
    } else {
      assert.deepEqual(imageReferenceIssues(item.prompt, ctx.projectAssets, references), [filenames[5]]);
      assert.equal(ctx.issueFor(item), `缺少图片：${filenames[5]}`);
      await ctx.submitSelected([item]);
      assert.equal(requests.length, 0);
      assert.deepEqual(notices, ["没有可提交章节，请先处理标红问题"]);
      assert.ok(item.prompt.includes(transition));
    }
  }
});
