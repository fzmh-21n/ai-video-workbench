import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

import { reindexBatchReferences as reindex, reconcileBatchReferenceTags } from "../src/batchReferences.js";
import { imageReferenceIssues, internalizeProjectAliases, normalizeImageReferenceBindings } from "../src/projectReferences.js";

const oldName = "角色图_015_红姐豹纹吊带版.png";
const actualName = "角色图_015_红姐豹纹吊带版_龅牙备选.png";
const description = "（红姐，成年女性）";
const references = reindex([
  { id: "scene", source: "manual", kind: "image", name: "场景图_001_街边.png" },
  { id: "person", source: "manual", kind: "image", name: "角色图_001_陈凡现代旧装版.png" },
  { id: "variant", source: "manual", kind: "image", name: actualName },
]);

test("a connected image number binds an explicit filename to that exact reference while preserving its description", () => {
  for (const label of ["Image", "image", "IMAGE", "图", "图片"]) {
    const prompt = `【出场人物】@${label}3=${oldName}${description}`;
    assert.equal(normalizeImageReferenceBindings(prompt, references), `【出场人物】@${label}3=${actualName}${description}`);
  }
  assert.equal(references[2].name, actualName);
  assert.equal(references[2].tag, "@Image3");
});

test("image filename binding supports the image formats already recognized by reference matching", () => {
  for (const extension of ["png", "jpg", "jpeg", "webp", "PNG", "JPG"]) {
    const refs = [{ id: "one", kind: "image", name: `新角色.${extension}`, tag: "@Image1" }];
    assert.equal(normalizeImageReferenceBindings(`@Image1=旧角色.${extension}（成年女性）`, refs), `@Image1=新角色.${extension}（成年女性）`);
  }
});

test("a real project asset named Image1 is an exact alias declaration, not the current native image1 position", () => {
  const refs = [
    { kind: "image", name: "乙.png", tag: "@Image1", source: "manual" },
    { kind: "image", name: "Image1.png", alias: "Image1", tag: "@Image2", source: "automatic" },
  ];
  const prompt = "【出场人物】@Image1=Image1.png；动作参考 @Image2";
  assert.equal(normalizeImageReferenceBindings(prompt, refs), prompt);
  assert.equal(internalizeProjectAliases(prompt, refs), "【出场人物】@Image2=Image1.png；动作参考 @Image2");
});

test("number-like project aliases are converted once and bare native references keep their positions", () => {
  const refs = [
    { kind: "image", name: "Image2.png", alias: "Image2", tag: "@Image1" },
    { kind: "image", name: "Image3.png", alias: "Image3", tag: "@Image2" },
    { kind: "image", name: "Image1.png", alias: "Image1", tag: "@Image3" },
  ];
  const prompt = "【出场人物】@Image2=Image2.png；动作参考 @Image2";
  assert.equal(internalizeProjectAliases(prompt, refs), "【出场人物】@Image1=Image2.png；动作参考 @Image2");
});

test("unconnected and malformed native image numbers cannot pass validation just by naming an attached file", () => {
  for (const tag of ["@Image99", "@Image0", "@Image03"]) {
    const prompt = `【出场人物】@Image3=${oldName}、${tag}=${oldName}`;
    const normalized = normalizeImageReferenceBindings(prompt, references);
    assert.ok(normalized.includes(`${tag}=${oldName}`));
    assert.ok(imageReferenceIssues(prompt, [], references).includes(tag));
  }
});

test("filename synchronization preserves longer Chinese filenames instead of guessing their suffix", () => {
  const prompt = `@Image3=${oldName}\n另外文件 备用${oldName}、其他${oldName}；人物资产只使用${oldName}。`;
  const normalized = normalizeImageReferenceBindings(prompt, references);
  assert.ok(normalized.includes(`备用${oldName}、其他${oldName}`));
  assert.ok(normalized.includes(`只使用${actualName}。`));
  assert.ok(imageReferenceIssues(normalized, [], references).includes(oldName));
});

test("a cast declaration naming real people is prose unless it names a structured asset", () => {
  for (const prompt of ["【出场人物】本节只有小明", "【出场人物】本节现场只有小明和小红", "【出场人物】本节只有小明、小红"]) {
    assert.deepEqual(imageReferenceIssues(prompt, [], []), []);
  }
  assert.deepEqual(imageReferenceIssues("【出场人物】本节只有角色图_099_小明.png", [], []), ["角色图_099_小明.png"]);
});

test("bare tags, non-filename role labels and unrelated old filenames are not rewritten", () => {
  const prompt = `@Image3 @图3 @\n@Image3=红姐；@图片3=红姐\n不要出现 ${oldName}`;
  assert.equal(normalizeImageReferenceBindings(prompt, references), prompt);
});

test("unconnected, nameless and non-image numbered references cannot override a filename", () => {
  const prompt = `@Image3=${oldName}${description}`;
  for (const refs of [
    [], [{ id: "wrong-number", kind: "image", tag: "@Image2", name: actualName }],
    [{ id: "nameless", kind: "image", tag: "@Image3", name: "" }],
    [{ id: "wrong-kind", kind: "audio", tag: "@Image3", name: "声音3.wav" }],
  ]) {
    assert.equal(normalizeImageReferenceBindings(prompt, refs), prompt);
  }
  for (const tag of ["@Image99", "@Image0", "@Image03", "@Video3", "@Audio3"]) {
    const text = `${tag}=${oldName}`;
    assert.equal(normalizeImageReferenceBindings(text, references), text);
  }
});

test("a deliberate numbered binding does not hide an unconnected filename elsewhere in the prompt", () => {
  const missingName = "角色图_099_未连接人物.png";
  const prompt = `【出场人物】@Image3=${oldName}${description}、${missingName}`;
  const normalized = normalizeImageReferenceBindings(prompt, references);
  assert.ok(normalized.includes(`@Image3=${actualName}${description}`));
  assert.ok(normalized.includes(missingName));
  assert.ok(imageReferenceIssues(normalized, [], references).includes(missingName));
});

test("an explicit image binding synchronizes repeated narrative filenames without requiring excluded narrative files", () => {
  const missingName = "角色图_099_未连接人物.png";
  const prompt = `【出场人物】@Image3 =${oldName}${description}\n【剧情】人物资产只使用角色图_001_陈凡现代旧装版.png、${oldName}。不要出现${missingName}。`;
  const normalized = normalizeImageReferenceBindings(prompt, references);
  assert.ok(normalized.includes(`@Image3 =${actualName}${description}`));
  assert.ok(normalized.includes(`人物资产只使用角色图_001_陈凡现代旧装版.png、${actualName}。`));
  assert.ok(!normalized.includes(oldName));
  assert.ok(normalized.includes(missingName));
  assert.deepEqual(imageReferenceIssues(normalized, [], references), []);
});

test("conflicting explicit bindings preserve ambiguous narrative filenames without making them reference requirements", () => {
  const otherActualName = "角色图_015_红姐豹纹吊带版_另一备选.png";
  const refs = [{ ...references[1], name: otherActualName }, references[2]];
  const prompt = `【出场人物】@Image2=${oldName}、@Image3=${oldName}\n【剧情】人物资产只使用${oldName}。`;
  const normalized = normalizeImageReferenceBindings(prompt, refs);
  assert.ok(normalized.includes(`@Image2=${otherActualName}`));
  assert.ok(normalized.includes(`@Image3=${actualName}`));
  assert.ok(normalized.includes(`人物资产只使用${oldName}。`));
  assert.deepEqual(imageReferenceIssues(normalized, [], refs), []);
});

test("simultaneous A-to-B and B-to-C bindings do not rewrite an already corrected declaration a second time", () => {
  const refs = [
    { id: "one", kind: "image", tag: "@Image1", name: "B.png" },
    { id: "two", kind: "image", tag: "@Image2", name: "C.png" },
  ];
  const prompt = "@Image1=A.png、@Image2=B.png。\n【剧情】A.png 与 B.png";
  const expected = "@Image1=B.png、@Image2=C.png。\n【剧情】B.png 与 C.png";
  assert.equal(normalizeImageReferenceBindings(prompt, refs), expected);
  assert.equal(normalizeImageReferenceBindings(expected, refs), expected);
});

test("an exact bound filename does not replace a suffix inside a longer filename or a backup extension", () => {
  const longerName = `其他_${oldName}`;
  const backupName = `${oldName}.bak`;
  const prompt = `@Image3=${oldName}。\n【剧情】${oldName}；${longerName}；${backupName}`;
  const expected = `@Image3=${actualName}。\n【剧情】${actualName}；${longerName}；${backupName}`;
  assert.equal(normalizeImageReferenceBindings(prompt, references), expected);
});

test("the two-person cast pattern does not mistake presence and exclusion instructions for missing people", () => {
  const prompt = [
    "【出场人物】",
    "@Image2=角色图_001_陈凡现代旧装版.png（陈凡，成年男性）",
    `@Image3=${oldName}${description}`,
    "本节现场只有这两人，始终在场；壮汉和警察尚未进入，不生成其他实体。",
    "【出场场景】",
    "@Image1=场景图_001_街边.png",
    "【剧情】",
    `人物资产只使用角色图_001_陈凡现代旧装版.png、${oldName}。`,
  ].join("\n");
  const normalized = normalizeImageReferenceBindings(prompt, references);
  assert.deepEqual(imageReferenceIssues(normalized, [], references), []);
  assert.deepEqual(imageReferenceIssues(prompt, [], references), []);
  assert.ok(normalized.includes(description));
  assert.ok(normalized.includes("本节现场只有这两人，始终在场；壮汉和警察尚未进入，不生成其他实体。"));
  assert.equal(normalizeImageReferenceBindings(normalized, references), normalized);
});

test("actual batch form preparation keeps image3's prompt filename, metadata and uploaded file consistent", async () => {
  const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
  const files = references.map((reference) => new File([reference.id], reference.name, { type: "image/png" }));
  const refs = references.map((reference, index) => ({ ...reference, file: files[index] }));
  let captured;
  let calls = 0;
  const ctx = vm.createContext({
    reindex, reconcileBatchReferenceTags, internalizeProjectAliases, normalizeImageReferenceBindings,
    parametersFor: () => ({ duration: 15, resolution: "720p", ratio: "16:9", quantity: 1, syncAudio: true }),
    fixedContent: "", autoReference: true, FormData, performance, headers: {}, submissionMode: "ordered", uid: () => "mock-request",
    activeProfile: { id: "test", adapter: "lwaigc", name: "测试", model: "mock" }, recordDiagnostic: () => {}, diagnosticHeaders: () => ({}),
    uploadKey: (_item, reference) => reference.id, resolveFile: (reference) => reference.file,
    fetch: async (_url, options) => {
      calls += 1;
      captured = options.body;
      return { ok: false, status: 400, json: async () => ({ message: "Mock stops before creating any task" }) };
    },
  });
  const start = source.indexOf("  async function submitOne(");
  const end = source.indexOf("  async function submitSelected(", start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(source.slice(start, end), ctx);
  await assert.rejects(ctx.submitOne({ id: "section", prompt: `【出场人物】@Image3=${oldName}${description}`, references: refs }, "batch", {}, 0, 0), /Mock stops/);
  assert.equal(calls, 1);
  const meta = JSON.parse(captured.get("referenceMeta"));
  assert.equal(meta[2].tag, "@Image3");
  assert.equal(meta[2].name, actualName);
  assert.equal(meta[2].fileIndex, 2);
  assert.equal(captured.getAll("references")[2].name, actualName);
  assert.ok(captured.get("prompt").includes(`@Image3=${actualName}${description}`));
  assert.ok(!captured.get("prompt").includes(oldName));
});
