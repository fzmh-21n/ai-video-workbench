import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

import { batchImageReferenceIssues, reindexBatchReferences as reindex, reconcileBatchReferenceTags } from "../src/batchReferences.js";
import { imageReferenceIssues, internalizeProjectAliases, normalizeImageReferenceBindings, planProjectReferences } from "../src/projectReferences.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
const filenames = [
  "角色图_001_陈凡现代旧装版.png", "角色图_010_苏清寒黑色职业装版.png",
  "角色图_039_警察甲.png", "角色图_040_警察乙.png", "场景图_005_警务机构门前外景.png",
];
const peopleNote = "四人均在门前同一空间，所有现场人物始终在场，未说话者保持倾听、目光和即时反应；黄毛留监室，红姐及同伙留酒店，不生成其他群众。";
const sceneNote = "白天；不转车内、不转新街景，停在第一集原稿尾节点。";

function sectionPrompt(people = peopleNote, scene = sceneNote) {
  return [
    "【出场人物】：", filenames.slice(0, 4).map((name) => `@${name.slice(0, -4)}=${name}`).join("、") + "。",
    people, "", "【出场场景】：", filenames[4], scene,
  ].join("\n");
}

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be extracted from the real BatchPanel`);
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

test("explicit four-character and one-scene declarations produce five correct batch uploads without treating direction notes as assets", async () => {
  const { ctx, requests } = context();
  const first = await ctx.matchItem({ id: "section", section: 1, prompt: sectionPrompt(), references: [] });
  const matched = await ctx.matchItem(first);
  assert.deepEqual(Array.from(matched.references, (reference) => reference.name), filenames);
  assert.equal(matched.prompt, first.prompt);
  assert.deepEqual(Array.from(matched.missingImages), []);
  assert.equal(ctx.issueFor(matched), "");
  assert.ok(matched.prompt.includes(peopleNote));
  assert.ok(matched.prompt.includes(sceneNote));
  await assert.rejects(ctx.submitOne(matched, "mock-batch", {}, 0, 0), /Local mock stops/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/tasks");
  const form = requests[0].options.body;
  const metadata = JSON.parse(form.get("referenceMeta"));
  const files = form.getAll("references");
  assert.equal(files.length, 5);
  assert.deepEqual(metadata.map(({ tag, kind, name, fileIndex }) => ({ tag, kind, name, fileIndex })), filenames.map((name, index) => ({
    tag: `@Image${index + 1}`, kind: "image", name, fileIndex: index,
  })));
  for (const [index, name] of filenames.entries()) {
    assert.equal(files[index].name, name);
    assert.equal(await files[index].text(), `fixture:${name}`);
    assert.ok(form.get("prompt").includes(`@Image${index + 1}=${name}`));
  }
  assert.ok(form.get("prompt").includes(peopleNote));
  assert.ok(form.get("prompt").includes(sceneNote));
});

test("a truly missing explicit character declaration blocks the real batch entry point before any request", async () => {
  const missingName = filenames[1];
  const { ctx, requests, notices } = context(filenames.filter((name) => name !== missingName));
  const matched = await ctx.matchItem({ id: "section", section: 1, prompt: sectionPrompt(), references: [] });
  assert.deepEqual(Array.from(matched.missingImages), [missingName]);
  assert.equal(ctx.issueFor(matched), `缺少图片：${missingName}`);
  await ctx.submitSelected([matched]);
  assert.equal(requests.length, 0);
  assert.deepEqual(notices, ["没有可提交章节，请先处理标红问题"]);
  assert.ok(matched.prompt.includes(peopleNote));
  assert.ok(matched.prompt.includes(sceneNote));
});

test("arbitrary new direction prose needs no recognized keywords when image declarations are explicit", async () => {
  const otherPeople = "构图采用两侧对称的关系；最后一个动作落在静止的目光上，节奏由稀疏的停顿支撑。边缘光保留细微层次。";
  const otherScene = "影调偏冷；墙面纹理与远处轮廓形成虚实对照，焦点落在台阶边缘。";
  const { ctx, requests } = context();
  const matched = await ctx.matchItem({ id: "section", section: 1, prompt: sectionPrompt(otherPeople, otherScene), references: [] });
  assert.deepEqual(Array.from(matched.references, (reference) => reference.name), filenames);
  assert.deepEqual(Array.from(matched.missingImages), []);
  assert.equal(ctx.issueFor(matched), "");
  await assert.rejects(ctx.submitOne(matched, "mock-batch", {}, 0, 0), /Local mock stops/);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].options.body.get("prompt").includes(otherPeople));
  assert.ok(requests[0].options.body.get("prompt").includes(otherScene));
});

test("a structured scene block matches only its asset and ignores bare people without blocking submission", async () => {
  const names = ["陈凡.png", "苏清寒.png", filenames[4]];
  const { ctx, requests } = context(names);
  const legacyPrompt = `【出场人物】陈凡、苏清寒、小明\n【出场场景】${filenames[4]}`;
  const matched = await ctx.matchItem({ id: "section", section: 1, prompt: legacyPrompt, references: [] });
  assert.deepEqual(Array.from(matched.references, (reference) => reference.name), [filenames[4]]);
  assert.deepEqual(Array.from(matched.missingImages), []);
  assert.equal(ctx.issueFor(matched), "");
  assert.ok(matched.prompt.includes("陈凡、苏清寒、小明"));
  await assert.rejects(ctx.submitOne(matched, "mock-batch", {}, 0, 0), /Local mock stops/);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].options.body.get("referenceMeta")).map((reference) => reference.name), [filenames[4]]);
});
