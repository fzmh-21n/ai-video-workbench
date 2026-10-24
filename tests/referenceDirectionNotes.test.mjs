import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

import { batchImageReferenceIssues, reindexBatchReferences as reindex, reconcileBatchReferenceTags } from "../src/batchReferences.js";
import { imageReferenceIssues, internalizeProjectAliases, normalizeImageReferenceBindings, planProjectReferences } from "../src/projectReferences.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
const filenames = [
  "角色图_001_陈凡现代旧装版.png", "角色图_042_拘留黄毛.png", "角色图_039_警察甲.png",
  "角色图_040_警察乙.png", "角色图_010_苏清寒黑色职业装版.png", "场景图_004_拘留监室内部空镜.png",
];
const peopleDirection = "陈凡与黄毛从首帧起均在监室内部，始终在场；两名警察与苏清寒只在07末段进入栏外通道、08明确入画，此前不生成在室内的分身。红姐与两壮汉留在酒店，不进入本组场景。";
const sceneDirection = "白天，监室内部与其铁栅栏外相邻通道为同一个连续空间。";

function sectionPrompt(names = filenames, people = peopleDirection, scene = sceneDirection) {
  return [
    "【出场人物】：", names.slice(0, 5).map((name) => `@${name.slice(0, -4)}=${name}`).join("、") + "。",
    people, "", "【出场场景】：", names[5], scene,
  ].join("\n");
}

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must come from the actual BatchPanel`);
  return source.slice(start, end);
}

function context(names = filenames) {
  const projectAssets = names.map((name) => ({
    key: `image:${name}`, kind: "image", name, stem: name.slice(0, -4),
    file: new File([`fixture:${name}`], name, { type: "image/png" }),
  }));
  const requests = [];
  const notices = [];
  let sequence = 0;
  const ctx = vm.createContext({
    projectAssets, reindex, reconcileBatchReferenceTags, imageReferenceIssues, batchImageReferenceIssues,
    internalizeProjectAliases, normalizeImageReferenceBindings, planProjectReferences,
    readMediaDuration: async () => null, uid: (prefix) => `${prefix}-${++sequence}`,
    parametersFor: () => ({ duration: 15, resolution: "720p", ratio: "16:9", quantity: 1, syncAudio: true }),
    fixedContent: "", autoReference: true, FormData, performance, headers: {}, submissionMode: "ordered",
    activeProfile: { id: "mock", adapter: "lwaigc", name: "本地测试", model: "mock" },
    recordDiagnostic: () => {}, diagnosticHeaders: () => ({}), uploadKey: (_item, reference) => reference.id,
    resolveFile: (reference) => projectAssets.find((asset) => asset.key === reference.projectAssetKey)?.file,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: false, status: 400, json: async () => ({ message: "Local mock stops before task creation" }) };
    },
    KINDS: ["image", "audio", "video"], LABELS: { image: "图片", audio: "音频", video: "视频" },
    capability: { images: 30, audios: 10, videos: 10 }, allowMissingImages: false,
    apiKey: "local-mock-only", canBatchSubmit: (item) => item.status === "matched", canBatchResubmit: () => false,
    onNotice: (notice) => notices.push(notice),
  });
  for (const [start, end] of [
    ["function countsFor(", "function withDownloadedFlags("],
    ["  async function matchItem(", "  async function matchAudioItem("],
    ["  function issueFor(", "  async function submitOne("],
    ["  async function submitOne(", "  async function submitSelected("],
    ["  async function submitSelected(", "\n  useEffect(() => {"],
  ]) vm.runInContext(extract(start, end), ctx);
  return { ctx, requests, notices };
}

test("real batch matching recognizes five declared people and one continuous-space scene while preserving every direction word", async () => {
  const { ctx } = context();
  const matched = await ctx.matchItem({ id: "section", section: 1, prompt: sectionPrompt(), references: [] });
  assert.deepEqual(Array.from(matched.references, (reference) => reference.name), filenames);
  assert.deepEqual(Array.from(matched.references, (reference) => reference.tag), filenames.map((_name, index) => `@Image${index + 1}`));
  assert.deepEqual(Array.from(matched.missingImages), []);
  assert.equal(ctx.issueFor(matched), "");
  assert.ok(matched.prompt.includes(peopleDirection));
  assert.ok(matched.prompt.includes(sceneDirection));
  const translated = internalizeProjectAliases(matched.prompt, matched.references);
  assert.ok(translated.includes(peopleDirection));
  assert.ok(translated.includes(sceneDirection));
});

test("real form preparation keeps all six numbered references aligned with metadata and uploaded bytes after rematching", async () => {
  const { ctx, requests } = context();
  const first = await ctx.matchItem({ id: "section", section: 1, prompt: sectionPrompt(), references: [] });
  const matched = await ctx.matchItem(first);
  assert.equal(matched.prompt, first.prompt);
  assert.deepEqual(Array.from(matched.missingImages), []);
  assert.equal(ctx.issueFor(matched), "");
  await assert.rejects(ctx.submitOne(matched, "mock-batch", {}, 0, 0), /Local mock stops/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/tasks");
  const form = requests[0].options.body;
  const metadata = JSON.parse(form.get("referenceMeta"));
  const files = form.getAll("references");
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
  assert.ok(form.get("prompt").includes(sceneDirection));
});

test("an explicitly declared missing police image still blocks the real batch entry point before any request", async () => {
  const missingName = filenames[3];
  const { ctx, requests, notices } = context(filenames.filter((name) => name !== missingName));
  const matched = await ctx.matchItem({ id: "section", section: 1, prompt: sectionPrompt(), references: [] });
  assert.deepEqual(Array.from(matched.missingImages), [missingName]);
  assert.equal(ctx.issueFor(matched), `缺少图片：${missingName}`);
  await ctx.submitSelected([matched]);
  assert.equal(requests.length, 0);
  assert.deepEqual(notices, ["没有可提交章节，请先处理标红问题"]);
  assert.ok(matched.prompt.includes(peopleDirection));
  assert.ok(matched.prompt.includes(sceneDirection));
});

test("equivalent direction prose works for different names, locations and entrance roles instead of relying on character-specific exceptions", async () => {
  const otherNames = [
    "角色图_001_林遥现代旧装版.png", "角色图_042_拘留金发.png", "角色图_039_保安甲.png",
    "角色图_040_保安乙.png", "角色图_010_赵岚黑色职业装版.png", "场景图_004_船舱内部空镜.png",
  ];
  const otherPeople = "林遥与金发从首帧起均在船舱内部，始终在场；两名保安与赵岚只在07末段进入栏外通道、08明确入画，此前不生成在室内的分身。阿兰与两侍卫留在码头，不进入本组场景。";
  const otherScene = "清晨，船舱内部与其栅栏外相邻通道为同一个连续空间。";
  const { ctx } = context(otherNames);
  const matched = await ctx.matchItem({ id: "section", section: 1, prompt: sectionPrompt(otherNames, otherPeople, otherScene), references: [] });
  assert.deepEqual(Array.from(matched.references, (reference) => reference.name), otherNames);
  assert.deepEqual(Array.from(matched.missingImages), []);
  assert.equal(ctx.issueFor(matched), "");
  assert.ok(matched.prompt.includes(otherPeople));
  assert.ok(matched.prompt.includes(otherScene));
});
