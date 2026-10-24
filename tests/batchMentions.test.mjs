import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { batchImageReferenceIssues, reindexBatchReferences as reindex, reconcileBatchReferenceTags } from "../src/batchReferences.js";
import { imageReferenceIssues, internalizeProjectAliases, normalizeImageReferenceBindings, planProjectReferences } from "../src/projectReferences.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
const refs = [
  { id: "image", kind: "image", source: "manual", tag: "@Image1", name: "角色.png" },
  { id: "audio", kind: "audio", source: "manual", tag: "@Audio1", name: "声音3.mp3" },
  { id: "video", kind: "video", source: "manual", tag: "@Video1", name: "运镜.mp4" },
];

test("mention suggestions come only from the active section and search manual filenames or numbered tags", () => {
  const start = source.indexOf("  const mentionSuggestions =");
  const end = source.indexOf("\n\n  useEffect", start);
  assert.ok(start > 0 && end > start);
  const ctx = vm.createContext({
    items: [{ id: "one", references: refs }, { id: "two", references: [{ ...refs[0], name: "另一节.png" }] }],
    mention: { itemId: "one", query: "" }, LABELS: { image: "图片", audio: "音频", video: "视频" },
  });
  const suggestions = () => vm.runInContext(`(() => { ${source.slice(start, end)}; return mentionSuggestions; })()`, ctx);
  assert.equal(suggestions().length, 3);
  for (const [query, expected] of [["角色", "image"], ["声音3", "audio"], ["运镜", "video"], ["image1", "image"], ["图1", "image"], ["另一节", null]]) {
    ctx.mention.query = query;
    assert.equal(suggestions()[0]?.id || null, expected);
  }
  ctx.mention = null;
  assert.equal(suggestions().length, 0);
});

function context(prompt = "前文 @ 后文") {
  const input = { selectionStart: 4, selectionEnd: 4, focus() { this.focused = true; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const ctx = vm.createContext({
    items: [{ id: "one", prompt, references: refs }, { id: "two", prompt: "另一节", references: [{ ...refs[0], id: "other", name: "其他节.png" }] }],
    mention: null, mentionIndex: 0, mentionSuggestions: refs, promptInputs: { current: new Map([["one", input]]) },
    requestAnimationFrame: (callback) => callback(),
    normalizeImageReferenceBindings, onNotice: () => {},
  });
  ctx.setItems = (updater) => { ctx.items = updater(ctx.items); };
  ctx.setMention = (value) => { ctx.mention = typeof value === "function" ? value(ctx.mention) : value; };
  ctx.setMentionIndex = (value) => { ctx.mentionIndex = typeof value === "function" ? value(ctx.mentionIndex) : value; };
  const start = source.indexOf("  function updateItem(");
  const end = source.indexOf("  async function cancelBatchItemGeneration(", start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(source.slice(start, end), ctx);
  return { ctx, input };
}

test("batch prompt exposes @ controls and clickable references rather than a plain textarea", () => {
  assert.match(source, /onChange=\{\(event\) => handlePromptChange\(item.id, event\)\}/);
  assert.match(source, /onKeyDown=\{\(event\) => handlePromptKeyDown\(item.id, event\)\}/);
  assert.match(source, /role="listbox" aria-label="本节参考素材引用"/);
  assert.match(source, /onClick=\{\(\) => chooseMention\(item.id, reference\)\}/);
});

test("manual image, audio and video mentions replace only the active query and preserve the other section", () => {
  for (const reference of refs) {
    const { ctx, input } = context();
    ctx.updateMention("one", "前文 @ 后文", 4);
    assert.equal(ctx.mention.itemId, "one");
    ctx.chooseMention("one", reference);
    assert.equal(ctx.items[0].prompt, `前文 ${reference.tag}  后文`);
    assert.equal(ctx.items[1].prompt, "另一节");
    assert.equal(input.selectionStart, 3 + reference.tag.length + 1);
    assert.equal(input.focused, true);
    assert.equal(ctx.mention, null);
  }
});

test("clicking a reference inserts at the caret or replaces selected text without dropping the suffix", () => {
  const { ctx, input } = context("角色站在桥边");
  input.selectionStart = 2;
  input.selectionEnd = 4;
  ctx.chooseMention("one", refs[0]);
  assert.equal(ctx.items[0].prompt, "角色@Image1 桥边");
});

test("leaving the prompt field visibly synchronizes a manually bound image without changing other sections", () => {
  const prompt = "【出场人物】@Image1=旧人物.png（成年女性）\n人物资产只使用旧人物.png。";
  const { ctx } = context(prompt);
  ctx.handlePromptBlur("one", { currentTarget: { value: prompt } });
  assert.equal(ctx.items[0].prompt, "【出场人物】@Image1=角色.png（成年女性）\n人物资产只使用角色.png。");
  assert.equal(ctx.items[1].prompt, "另一节");
});

test("matching again preserves a manual variant without attaching its old file or a duplicate project file", async () => {
  const oldName = "角色图_015_红姐豹纹吊带版.png";
  const actualName = "角色图_015_红姐豹纹吊带版_龅牙备选.png";
  const assets = ["场景图_001_街边.png", "角色图_001_小梅.png", oldName, actualName].map((name) => ({
    kind: "image", key: `image:${name}`, stem: name.slice(0, -4), name, file: new File([name], name, { type: "image/png" }),
  }));
  const references = reindex([
    ...assets.slice(0, 2).map((asset) => ({ id: asset.key, source: "automatic", kind: "image", name: asset.name, projectAssetKey: asset.key })),
    { id: "manual", source: "manual", kind: "image", name: actualName, file: assets[3].file },
  ]);
  const item = { id: "one", prompt: `【出场人物】@Image2=角色图_001_小梅.png、@Image3=${oldName}（红姐）\n【出场场景】@Image1=场景图_001_街边.png`, references };
  const ctx = vm.createContext({
    projectAssets: assets, normalizeImageReferenceBindings, planProjectReferences, imageReferenceIssues, batchImageReferenceIssues, reindex, reconcileBatchReferenceTags,
    capability: { images: 30 },
    readMediaDuration: async () => null, uid: () => `ref-${Math.random()}`,
  });
  const start = source.indexOf("  async function matchItem(");
  vm.runInContext(source.slice(start, source.indexOf("  async function matchAudioItem(", start)), ctx);
  const matched = await ctx.matchItem(item);
  assert.equal(matched.references.length, 3);
  assert.equal(matched.references.filter((reference) => reference.name === actualName).length, 1);
  assert.ok(!matched.references.some((reference) => reference.name === oldName));
  assert.equal(matched.references.find((reference) => reference.id === "manual").tag, "@Image3");
  assert.equal(matched.missingImages.length, 0);
  const submitted = internalizeProjectAliases(matched.prompt, matched.references);
  assert.ok(submitted.includes(`@Image3=${actualName}（红姐）`));
});

test("matching again preserves an already connected automatic image selected through a bare @ tag", async () => {
  const file = new File(["fixture"], "小明.png", { type: "image/png" });
  const asset = { key: "image:小明.png", kind: "image", name: file.name, stem: "小明", file };
  const item = { id: "one", prompt: "【出场人物】@Image1 是小明", references: [{ id: "old", projectAssetKey: asset.key, kind: "image", source: "automatic", name: file.name, tag: "@Image1" }] };
  const ctx = vm.createContext({ projectAssets: [asset], normalizeImageReferenceBindings, planProjectReferences, imageReferenceIssues, batchImageReferenceIssues,
    capability: { images: 30 },
    reindex, reconcileBatchReferenceTags, readMediaDuration: async () => null, uid: () => "new" });
  const start = source.indexOf("  async function matchItem(");
  vm.runInContext(source.slice(start, source.indexOf("  async function matchAudioItem(", start)), ctx);
  const matched = await ctx.matchItem(item);
  assert.equal(matched.references.length, 1);
  assert.equal(matched.references[0].projectAssetKey, asset.key);
  assert.equal(matched.prompt, item.prompt);
  assert.equal(matched.missingImages.length, 0);
});

test("@ query follows edits and cursor position; a different section cannot reuse a stale query start", () => {
  const { ctx } = context();
  ctx.handlePromptChange("one", { target: { value: "先 @声音3 后", selectionStart: 6 } });
  assert.equal(ctx.mention.query, "声音3");
  assert.equal(ctx.items[0].prompt, "先 @声音3 后");
  ctx.updateMention("one", "先 @声音3 后", 1);
  assert.equal(ctx.mention, null);
  ctx.updateMention("two", "@图", 2);
  ctx.chooseMention("one", refs[1]);
  assert.equal(ctx.items[0].prompt, "先 @声@Audio1 音3 后");
});

test("keyboard selection supports arrows, Enter, Tab and Escape without submitting or consuming IME Enter", () => {
  const { ctx } = context();
  ctx.updateMention("one", "前文 @ 后文", 4);
  let prevented = 0;
  const key = (value, changes = {}) => ctx.handlePromptKeyDown("one", { key: value, preventDefault() { prevented++; }, ...changes });
  key("ArrowDown");
  assert.equal(ctx.mentionIndex, 1);
  ctx.updateMention("one", "前文 @ 后文", 4);
  assert.equal(ctx.mentionIndex, 1, "a selection event at the same caret must not reset the highlighted option");
  key("Enter", { nativeEvent: { isComposing: true } });
  assert.equal(ctx.items[0].prompt, "前文 @ 后文");
  key("Enter");
  assert.equal(ctx.items[0].prompt, "前文 @Audio1  后文");
  assert.equal(prevented, 2);
  ctx.updateMention("one", "前文 @Audio1  后文", 4);
  key("Escape");
  assert.equal(ctx.mention, null);
  ctx.updateMention("one", "前文 @Audio1  后文", 4);
  key("ArrowUp");
  assert.equal(ctx.mentionIndex, 2);
  key("Tab");
  assert.equal(ctx.items[0].prompt, "前文 @Video1  后文");
});

test("manual upload adds all media kinds to only its own section and reconciles restored stale numbering", async () => {
  const { ctx } = context("声音参考 @Audio2");
  ctx.items[0].references = [{ id: "stored", kind: "audio", source: "automatic", tag: "@Audio2", name: "声音1.mp3" }];
  Object.assign(ctx, { reindex, reconcileBatchReferenceTags, uid: (prefix) => `${prefix}-${Math.random()}`, readMediaDuration: async () => null });
  const start = source.indexOf("  async function addManualFiles(");
  vm.runInContext(source.slice(start, source.indexOf("  function removeItemReference(", start)), ctx);
  const files = [new File(["image"], "角色.png", { type: "image/png" }), new File(["audio"], "声音3.mp3", { type: "audio/mpeg" }), new File(["video"], "运镜.mp4", { type: "video/mp4" })];
  await ctx.addManualFiles("one", files);
  assert.deepEqual(Array.from(ctx.items[0].references, (reference) => reference.tag), ["@Audio1", "@Image1", "@Audio2", "@Video1"]);
  assert.equal(ctx.items[0].prompt, "声音参考 @Audio1");
  assert.equal(ctx.items[0].references[2].file, files[1]);
  assert.equal(ctx.items[1].references.length, 1);
});

test("deleting a preceding manual image keeps a selected second image mapped to the right file in the request", async () => {
  const { ctx } = context("角色 @Image2，声音 @Audio1，运镜 @Video1");
  const files = [new File(["a"], "甲.png", { type: "image/png" }), new File(["b"], "乙.png", { type: "image/png" }), new File(["c"], "声音3.mp3", { type: "audio/mpeg" }), new File(["d"], "运镜.mp4", { type: "video/mp4" })];
  ctx.items[0].references = reindex(files.map((file, index) => ({ id: `ref-${index}`, source: "manual", kind: index < 2 ? "image" : index === 2 ? "audio" : "video", file, name: file.name })));
  Object.assign(ctx, { reindex, reconcileBatchReferenceTags });
  const removeStart = source.indexOf("  function removeItemReference(");
  vm.runInContext(source.slice(removeStart, source.indexOf("  function resolveFile(", removeStart)), ctx);
  ctx.removeItemReference("one", "ref-0");
  assert.equal(ctx.items[0].prompt, "角色 @Image1，声音 @Audio1，运镜 @Video1");
  let captured;
  Object.assign(ctx, {
    parametersFor: () => ({ duration: 15, resolution: "720p", ratio: "16:9", quantity: 1, syncAudio: true }), internalizeProjectAliases,
    fixedContent: "", autoReference: true, FormData, performance, headers: {}, submissionMode: "ordered", uid: () => "mock-request",
    activeProfile: { id: "test", adapter: "lwaigc", name: "测试", model: "mock" }, recordDiagnostic: () => {}, diagnosticHeaders: () => ({}),
    uploadKey: (_item, reference) => reference.id, resolveFile: (reference) => reference.file,
    fetch: async (_url, options) => { captured = options.body; return { ok: false, status: 400, json: async () => ({ message: "Mock stops before creating any task" }) }; },
  });
  const submitStart = source.indexOf("  async function submitOne(");
  vm.runInContext(source.slice(submitStart, source.indexOf("  async function submitSelected(", submitStart)), ctx);
  await assert.rejects(ctx.submitOne(ctx.items[0], "batch", {}, 0, 0), /Mock stops/);
  const meta = JSON.parse(captured.get("referenceMeta"));
  assert.deepEqual(meta.map(({ tag, name, fileIndex }) => ({ tag, name, fileIndex })), [
    { tag: "@Image1", name: "乙.png", fileIndex: 0 }, { tag: "@Audio1", name: "声音3.mp3", fileIndex: 1 }, { tag: "@Video1", name: "运镜.mp4", fileIndex: 2 },
  ]);
  assert.equal(captured.getAll("references")[0].name, "乙.png");
  assert.equal(captured.get("prompt"), "角色 @Image1，声音 @Audio1，运镜 @Video1");
});
