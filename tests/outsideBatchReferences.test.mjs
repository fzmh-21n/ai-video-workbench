import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

import { batchImageReferenceIssues, reindexBatchReferences as reindex, reconcileBatchReferenceTags } from "../src/batchReferences.js";
import { batchSerializable } from "../src/batchPrompts.js";
import { internalizeProjectAliases, normalizeImageReferenceBindings, planProjectReferences } from "../src/projectReferences.js";
import { taskReuseSnapshot } from "../src/taskReuse.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
const personName = "角色图_001_许小禾日常.png";
const sceneName = "场景图_003_望春前厅日间四视角.png";
const outfitName = "角色图_002_许小禾样衣_v2.png";
const outsideNote = `【场景环境】\n${outfitName}仅提取浅绿碎花样衣和纸包糖作为道具外观；图中试穿人物不作为现场角色。`;
const prompt = `【出场人物】${personName}\n【出场场景】${sceneName}\n${outsideNote}`;

function asset(name) {
  return { key: `image:${name}`, kind: "image", name, stem: name.slice(0, -4), file: new File([`fixture:${name}`], name, { type: "image/png" }) };
}

function extract(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `must load actual BatchPanel function ${start}`);
  return source.slice(first, last);
}

function context(names = [personName, sceneName, outfitName], images = 9) {
  const projectAssets = names.map(asset);
  const requests = [];
  let nextId = 0;
  const ctx = vm.createContext({
    projectAssets, batchImageReferenceIssues, reindex, reconcileBatchReferenceTags, internalizeProjectAliases,
    normalizeImageReferenceBindings, planProjectReferences, readMediaDuration: async () => null,
    uid: (prefix) => `${prefix}-${++nextId}`, capability: { images, audios: 3, videos: 3 },
    KINDS: ["image", "audio", "video"], LABELS: { image: "图片", audio: "音频", video: "视频" }, allowMissingImages: false,
    parametersFor: () => ({ duration: 15, resolution: "720p", ratio: "16:9", quantity: 1, syncAudio: true }),
    fixedContent: "", autoReference: true, FormData, performance, headers: {}, submissionMode: "ordered",
    activeProfile: { id: "fixture", adapter: "lwaigc", name: "本地隔离测试", model: "fixture" },
    recordDiagnostic: () => {}, diagnosticHeaders: () => ({}),
    uploadKey: (_item, reference) => reference.id,
    resolveFile: (reference) => reference.file || projectAssets.find((entry) => entry.key === reference.projectAssetKey)?.file,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: false, status: 400, json: async () => ({ message: "Fixture stops before creating a paid task" }) };
    },
  });
  for (const [start, end] of [
    ["function countsFor(", "function withDownloadedFlags("],
    ["  async function matchItem(", "  async function matchAudioItem("],
    ["  function issueFor(", "  async function submitOne("],
    ["  async function submitOne(", "  async function submitSelected("],
  ]) vm.runInContext(extract(start, end), ctx);
  return { ctx, projectAssets, requests };
}

function row(text = prompt, references = []) {
  return { id: "outside-batch", section: 1, title: "衣架被夺", prompt: text, references, status: "unmatched" };
}

const visibleReferences = (references) => Array.from(references, ({ kind, name, projectAssetKey, tag, alias, source, noAutoMention }) =>
  ({ kind, name, projectAssetKey, tag, alias, source, noAutoMention: Boolean(noAutoMention) }));

async function captureForm(ctx, requests, item, cache = {}) {
  await assert.rejects(ctx.submitOne(item, "fixture-batch", cache, 0, 0), /Fixture stops before creating a paid task/);
  assert.equal(requests.length, 1, "all requests are captured by the local stub; no upstream service is called");
  assert.equal(requests[0].url, "/api/tasks");
  return requests[0].options.body;
}

test("actual batch matching and submission attach outside images with flags and real files without inserting an outside mention", async () => {
  const { ctx, requests } = context();
  const matched = await ctx.matchItem(row());
  assert.deepEqual(Array.from(matched.references, (entry) => entry.name), [personName, sceneName, outfitName]);
  assert.equal(matched.references.at(-1).noAutoMention, true);
  assert.ok(matched.prompt.endsWith(outsideNote));
  assert.doesNotMatch(matched.prompt, /@角色图_002_许小禾样衣_v2/);
  assert.equal(ctx.issueFor(matched), "");

  const form = await captureForm(ctx, requests, matched);
  const metadata = JSON.parse(form.get("referenceMeta"));
  const files = form.getAll("references");
  assert.deepEqual(metadata.map((entry) => entry.name), [personName, sceneName, outfitName]);
  assert.deepEqual(metadata.map((entry) => entry.fileIndex), [0, 1, 2]);
  assert.equal(metadata[2].noAutoMention, true);
  assert.equal(metadata[0].noAutoMention, undefined);
  assert.equal(metadata[1].noAutoMention, undefined);
  assert.equal(files.length, 3);
  for (const [index, name] of [personName, sceneName, outfitName].entries()) {
    assert.equal(files[index].name, name);
    assert.equal(await files[index].text(), `fixture:${name}`);
  }
  assert.ok(form.get("prompt").endsWith(outsideNote));
  assert.match(form.get("prompt"), /【出场人物】@Image1=/);
  assert.match(form.get("prompt"), /【出场场景】@Image2=/);
  assert.doesNotMatch(form.get("prompt"), /@Image3|@角色图_002_许小禾样衣_v2/);
});

test("a manually attached outside image is reused once with its original file and receives the outside flag", async () => {
  const { ctx, projectAssets, requests } = context();
  const file = projectAssets.at(-1).file;
  const manual = reindex([{ id: "manual-outfit", source: "manual", kind: "image", name: outfitName, file }]);
  const matched = await ctx.matchItem(row(prompt, manual));
  const outfit = matched.references.find((entry) => entry.name === outfitName);
  assert.equal(matched.references.length, 3);
  assert.equal(matched.references.filter((entry) => entry.name === outfitName).length, 1);
  assert.equal(outfit.id, "manual-outfit");
  assert.equal(outfit.source, "manual");
  assert.equal(outfit.projectAssetKey, projectAssets.at(-1).key);
  assert.equal(outfit.file, file);
  assert.equal(outfit.noAutoMention, true);
  assert.ok(matched.prompt.endsWith(outsideNote));
  const form = await captureForm(ctx, requests, matched);
  assert.equal(JSON.parse(form.get("referenceMeta")).filter((entry) => entry.name === outfitName).length, 1);
  assert.equal(JSON.parse(form.get("referenceMeta")).at(-1).noAutoMention, true);
  assert.equal(await form.getAll("references").at(-1).text(), `fixture:${outfitName}`);
});

test("automatic outside matching is idempotent and promotes a moved cast image then removes an unmentioned automatic image", async () => {
  const { ctx } = context();
  const first = await ctx.matchItem(row());
  const second = await ctx.matchItem(first);
  assert.equal(second.prompt, first.prompt);
  assert.deepEqual(visibleReferences(second.references), visibleReferences(first.references));

  const castPrompt = second.prompt.replace("【出场人物】", `【出场人物】${outfitName}、`);
  const promoted = await ctx.matchItem({ ...second, prompt: castPrompt });
  const outfit = promoted.references.find((entry) => entry.name === outfitName);
  assert.equal(Boolean(outfit.noAutoMention), false);
  assert.equal(promoted.references.filter((entry) => entry.name === outfitName).length, 1);
  assert.match(promoted.prompt, /【出场人物】@角色图_002_许小禾样衣_v2=/);
  assert.ok(promoted.prompt.endsWith(outsideNote));

  const outsideAgain = await ctx.matchItem({ ...promoted, prompt });
  assert.equal(outsideAgain.references.find((entry) => entry.name === outfitName).noAutoMention, true);
  const removed = await ctx.matchItem({ ...outsideAgain, prompt: outsideAgain.prompt.replace(outsideNote, "【场景环境】只保留当前衣架。") });
  assert.deepEqual(Array.from(removed.references, (entry) => entry.name), [personName, sceneName]);
  assert.deepEqual(Array.from(removed.missingImages), []);
  assert.equal(ctx.issueFor(removed), "");
});

test("moving a manual outside image into the cast clears its outside flag while keeping manual identity", async () => {
  const { ctx, projectAssets } = context();
  const manual = reindex([{ id: "manual-outfit", source: "manual", kind: "image", name: outfitName, file: projectAssets.at(-1).file }]);
  const first = await ctx.matchItem(row(prompt, manual));
  const promoted = await ctx.matchItem({ ...first, prompt: first.prompt.replace("【出场人物】", `【出场人物】${outfitName}、`) });
  const outfit = promoted.references.find((entry) => entry.id === "manual-outfit");
  assert.equal(Boolean(outfit.noAutoMention), false);
  assert.equal(outfit.source, "manual");
  assert.equal(outfit.file, projectAssets.at(-1).file);
  assert.equal(promoted.references.filter((entry) => entry.name === outfitName).length, 1);
  assert.match(promoted.prompt, /【出场人物】@角色图_002_许小禾样衣_v2=/);
});

test("outside images count toward the actual model image limit and can be manually removed without a missing-image warning", async () => {
  const declared = Array.from({ length: 9 }, (_, index) => `角色图_${String(index + 101).padStart(3, "0")}_人物${index + 1}.png`);
  const { ctx, requests } = context([...declared, outfitName]);
  const text = `【出场人物】${declared.join("、")}\n${outsideNote}`;
  const matched = await ctx.matchItem(row(text));
  assert.equal(matched.references.length, 10);
  assert.equal(ctx.issueFor(matched), "图片 10/9");
  assert.equal(requests.length, 0);
  const pruned = { ...matched, references: reindex(matched.references.filter((entry) => !entry.noAutoMention)) };
  assert.equal(pruned.references.length, 9);
  assert.equal(ctx.issueFor(pruned), "");
  assert.deepEqual(Array.from(batchImageReferenceIssues(pruned, ctx.projectAssets, 9)), []);
});

test("removing an optional outside image below model capacity still does not turn it into a required image", async () => {
  const { ctx } = context();
  const matched = await ctx.matchItem(row());
  const removed = { ...matched, references: reindex(matched.references.filter((entry) => !entry.noAutoMention)) };
  assert.equal(removed.references.length, 2);
  assert.equal(ctx.issueFor(removed), "");
  assert.deepEqual(Array.from(batchImageReferenceIssues(removed, ctx.projectAssets, 9)), []);
  assert.ok(removed.prompt.endsWith(outsideNote));
});

test("batch persistence and task reuse snapshots preserve automatic outside-image metadata", async () => {
  const { ctx } = context();
  const matched = await ctx.matchItem(row());
  const persisted = JSON.parse(JSON.stringify(batchSerializable([matched])))[0];
  const restored = persisted.references.find((entry) => entry.name === outfitName);
  assert.equal(restored.noAutoMention, true);
  assert.equal(restored.projectAssetKey, `image:${outfitName}`);
  assert.equal(restored.tag, "@Image3");
  assert.ok(persisted.prompt.endsWith(outsideNote));

  const snapshot = JSON.parse(JSON.stringify(taskReuseSnapshot({
    prompt: matched.prompt, references: matched.references, duration: 15, resolution: "720p", ratio: "16:9", quantity: 1,
  })));
  const reused = snapshot.references.find((entry) => entry.name === outfitName);
  assert.equal(reused.noAutoMention, true);
  assert.equal(reused.projectAssetKey, `image:${outfitName}`);
  assert.equal(reused.alias, outfitName.slice(0, -4));
  assert.ok(snapshot.prompt.endsWith(outsideNote));
  assert.equal(snapshot.references.find((entry) => entry.name === personName).noAutoMention, undefined);
});

test("cached outside-image submission preserves its flag and signed URL without uploading its file again", async () => {
  const { ctx, requests } = context();
  const matched = await ctx.matchItem(row());
  const outside = matched.references.find((entry) => entry.noAutoMention);
  const url = "https://fixture.invalid/asset.png?signature=keep-this&expires=123";
  const form = await captureForm(ctx, requests, matched, { [outside.id]: { url, assetId: "fixture-asset", sizeBytes: 123 } });
  const metadata = JSON.parse(form.get("referenceMeta"));
  assert.equal(metadata[2].noAutoMention, true);
  assert.equal(metadata[2].url, url);
  assert.equal(metadata[2].assetId, "fixture-asset");
  assert.equal(metadata[2].fileIndex, null);
  assert.equal(metadata[2].sizeBytes, 123);
  assert.deepEqual(form.getAll("references").map((file) => file.name), [personName, sceneName]);
  assert.ok(form.get("prompt").endsWith(outsideNote));
});
