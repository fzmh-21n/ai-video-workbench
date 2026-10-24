import assert from "node:assert/strict";
import test from "node:test";

import { reconcileBatchReferenceTags, reindexBatchReferences } from "../src/batchReferences.js";

test("batch reference numbering keeps media order and independent counters without mutating references", () => {
  const references = [
    { id: "image-a", kind: "image" }, { id: "audio-a", kind: "audio" },
    { id: "video-a", kind: "video" }, { id: "image-b", kind: "image" },
    { id: "audio-b", kind: "audio" }, { id: "video-b", kind: "video" },
  ];
  const numbered = reindexBatchReferences(references);
  assert.deepEqual(numbered.map((reference) => reference.tag), ["@Image1", "@Audio1", "@Video1", "@Image2", "@Audio2", "@Video2"]);
  assert.deepEqual(numbered.map((reference) => reference.id), references.map((reference) => reference.id));
  assert.ok(references.every((reference) => !reference.tag));
});

test("deleting the first image restores its name and keeps the second image attached to its new number", () => {
  const previous = reindexBatchReferences([
    { id: "a", kind: "image", name: "角色甲.png" },
    { id: "b", kind: "image", name: "角色乙.png" },
  ]);
  const next = reindexBatchReferences([previous[1]]);
  assert.equal(reconcileBatchReferenceTags("@Image1 在左，@Image2 在右，未知 @Image10。", previous, next), "角色甲 在左，@Image1 在右，未知 @Image10。");
});

test("reordering images replaces their old numbers once instead of cascading replacements", () => {
  const previous = reindexBatchReferences([{ id: "a", kind: "image" }, { id: "b", kind: "image" }]);
  const next = reindexBatchReferences([previous[1], previous[0]]);
  assert.equal(reconcileBatchReferenceTags("@Image1、@Image2、@Image10", previous, next), "@Image2、@Image1、@Image10");
});

test("automatic rematching uses the asset key when IDs change and keeps manual references by ID", () => {
  const previous = reindexBatchReferences([
    { id: "old-auto", projectAssetKey: "image:甲.png", kind: "image", source: "automatic" },
    { id: "manual", kind: "image", source: "manual", name: "手动图.png" },
    { id: "audio", kind: "audio", source: "manual", name: "声音1.wav" },
    { id: "video", kind: "video", source: "manual", name: "运镜.mp4" },
  ]);
  const next = reindexBatchReferences([
    { id: "new-auto", projectAssetKey: "image:甲.png", kind: "image", source: "automatic" },
    { id: "added-auto", projectAssetKey: "image:乙.png", kind: "image", source: "automatic" },
    previous[1], previous[2], previous[3],
  ]);
  assert.equal(reconcileBatchReferenceTags("@Image1 @Image2 @Audio1 @Video1", previous, next), "@Image1 @Image3 @Audio1 @Video1");
});

test("English case and Chinese tag spellings keep their style while audio and video are renumbered independently", () => {
  const previous = reindexBatchReferences([
    { id: "image-a", kind: "image", name: "甲.png" }, { id: "image-b", kind: "image" },
    { id: "audio-a", kind: "audio", alias: "甲声线", name: "声音1.wav" }, { id: "audio-b", kind: "audio" },
    { id: "video-a", kind: "video", name: "运镜.mp4" }, { id: "video-b", kind: "video" },
  ]);
  const next = reindexBatchReferences([previous[1], previous[3], previous[5]]);
  const prompt = "@image2 @IMAGE2 @图2 @图片2 / @audio2 @音频2 @声音2 / @video2 @视频2 / @Audio1 @视频1";
  assert.equal(reconcileBatchReferenceTags(prompt, previous, next), "@image1 @IMAGE1 @图1 @图片1 / @audio1 @音频1 @声音1 / @video1 @视频1 / 甲声线 运镜");
});

test("reference identity is scoped to media kind and exact IDs take priority over matching asset keys", () => {
  const previous = reindexBatchReferences([
    { id: "shared", projectAssetKey: "same-key", kind: "image", name: "甲.png" },
    { id: "shared", projectAssetKey: "same-key", kind: "audio", name: "甲.wav" },
  ]);
  const next = reindexBatchReferences([
    { id: "other", projectAssetKey: "same-key", kind: "image" },
    { id: "shared", projectAssetKey: "same-key", kind: "image" },
  ]);
  assert.equal(reconcileBatchReferenceTags("@Image1 @Audio1", previous, next), "@Image2 甲");
});

test("number boundaries distinguish 1 and 10 and leave unknown or zero indices unchanged", () => {
  const previous = reindexBatchReferences(Array.from({ length: 10 }, (_, index) => ({ id: `image-${index}`, kind: "image" })));
  const next = reindexBatchReferences([...previous.slice(1), previous[0]]);
  assert.equal(reconcileBatchReferenceTags("@Image1 @Image10 @Image100 @Image0 @Audio1", previous, next), "@Image10 @Image9 @Image100 @Image0 @Audio1");
});

test("an empty reference list leaves unknown prompt tags alone", () => {
  assert.deepEqual(reindexBatchReferences([]), []);
  assert.equal(reconcileBatchReferenceTags("@Image1 @声音1", [], []), "@Image1 @声音1");
});

test("numbered asset aliases are names, not reference positions, during renumbering", () => {
  const previous = reindexBatchReferences([
    { id: "first", kind: "audio", alias: "声音2", name: "声音2.mp3" },
    { id: "second", kind: "audio", alias: "声音9", name: "声音9.mp3" },
  ]);
  const next = reindexBatchReferences([previous[1], previous[0]]);
  assert.equal(reconcileBatchReferenceTags("【声音】@声音2=声音2、@声音9=声音9；动作节奏 @Audio2", previous, next), "【声音】@声音2=声音2、@声音9=声音9；动作节奏 @Audio1");
});

test("an asset named Image1 does not stop a bare native image number from following its file", () => {
  const previous = reindexBatchReferences([
    { id: "auto", kind: "image", alias: "Image1", name: "Image1.png" },
    { id: "manual", kind: "image", name: "乙.png" },
  ]);
  const next = reindexBatchReferences([previous[1], previous[0]]);
  assert.equal(reconcileBatchReferenceTags("人物 @Image1=Image1.png；动作参考 @Image1", previous, next), "人物 @Image1=Image1.png；动作参考 @Image2");
});
