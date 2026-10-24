import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { lwaigcReferencePrompt, lwaigcVideoPayload } from "../src/lwaigcCatalog.js";
import { maxforaiReferencePrompt, maxforaiVideoPayload } from "../src/maxforaiCatalog.js";
import { suanliaiReferencePrompt, suanliaiVideoPayload } from "../src/suanliaiCatalog.js";

const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const mappingSource = server.slice(server.indexOf("function withReferenceMapping("), server.indexOf("function paipuPayload("));
const withReferenceMapping = vm.runInNewContext(`${mappingSource}\nwithReferenceMapping;`);
const materials = [
  { kind: "image", tag: "@Image1", name: "角色图_001_日常.png" },
  { kind: "image", tag: "@Image2", name: "角色图_002_样衣.png", noAutoMention: true },
  { kind: "audio", tag: "@Audio1", name: "声音1.wav", noAutoMention: true },
  { kind: "image", tag: "@Image3", name: "场景图_003_前厅.png" },
  { kind: "video", tag: "@Video1", name: "镜头.mp4" },
];
const outsidePrompt = "样衣取自角色图_002_样衣.png，不增加图中人物。";

test("generic mapping skips outside-reference declarations without changing materials or remaining tags", () => {
  const before = structuredClone(materials);
  const prompt = withReferenceMapping(outsidePrompt, materials, true);
  assert.ok(prompt.startsWith(outsidePrompt));
  assert.match(prompt, /@Image1 = image 参考素材（角色图_001_日常.png）/);
  assert.match(prompt, /@Image3 = image 参考素材（场景图_003_前厅.png）/);
  assert.doesNotMatch(prompt, /@Image2|@Audio1/);
  assert.deepEqual(materials, before);
});

test("LWAIGC counts outside references but does not prepend their declarations", () => {
  const prompt = lwaigcReferencePrompt(outsidePrompt, materials);
  assert.match(prompt, /^@图1是角色图_001_日常，@图3是场景图_003_前厅，@视频1是镜头。/);
  assert.ok(prompt.endsWith(outsidePrompt));
  assert.doesNotMatch(prompt, /@图2|@音频1/);
});

test("MaxForAI counts outside references but does not append their declarations", () => {
  const prompt = maxforaiReferencePrompt(outsidePrompt, materials);
  assert.ok(prompt.startsWith(outsidePrompt));
  assert.match(prompt, /@image1 是 角色图_001_日常/);
  assert.match(prompt, /@image3 是 场景图_003_前厅/);
  assert.doesNotMatch(prompt, /@image2|@audio1/);
});

test("SuanliAI preserves per-kind array positions across outside references in every mapping format", () => {
  for (const [model, first, third, skipped] of [
    ["002系列/test", "@图1=角色图_001_日常.png", "@图3=场景图_003_前厅.png", /@图2|@音频1/],
    ["004系列/test", "Image 1 = 角色图_001_日常.png", "Image 3 = 场景图_003_前厅.png", /Image 2|Audio 1/],
    ["003系列/test", "@Image1=角色图_001_日常.png", "@Image3=场景图_003_前厅.png", /@Image2|@Audio1/],
  ]) {
    const prompt = suanliaiReferencePrompt(model, outsidePrompt, materials, true);
    assert.ok(prompt.startsWith(outsidePrompt));
    assert.ok(prompt.includes(first));
    assert.ok(prompt.includes(third));
    assert.doesNotMatch(prompt, skipped);
  }
});

test("all-outside materials do not leave an empty mapping header or generated reference token", () => {
  const outside = materials.filter((item) => item.noAutoMention);
  assert.equal(withReferenceMapping(outsidePrompt, outside, true), outsidePrompt);
  assert.equal(lwaigcReferencePrompt(outsidePrompt, outside), outsidePrompt);
  assert.equal(maxforaiReferencePrompt(outsidePrompt, outside), outsidePrompt);
  for (const model of ["002系列/test", "004系列/test", "003系列/test"]) {
    assert.equal(suanliaiReferencePrompt(model, outsidePrompt, outside, true), outsidePrompt);
  }
});

test("explicit native references to outside materials remain available and can be normalized", () => {
  const prompt = "用户主动参考 @Image2 和 @Audio1。";
  assert.ok(withReferenceMapping(prompt, materials, true).startsWith(prompt));
  assert.ok(lwaigcReferencePrompt(prompt, materials).endsWith("用户主动参考 @图2 和 @音频1。"));
  assert.ok(maxforaiReferencePrompt(prompt, materials).startsWith("用户主动参考 @image2 和 @audio1。"));
  assert.ok(suanliaiReferencePrompt("002系列/test", prompt, materials, true).startsWith("用户主动参考 @图2 和 @音频1。"));
  assert.ok(suanliaiReferencePrompt("004系列/test", prompt, materials, true).startsWith("用户主动参考 Image 2 和 Audio 1。"));
});

test("disabled generic and SuanliAI auto-mapping still return the original prompt", () => {
  const prompt = "用户主动参考 @Image2。";
  assert.equal(withReferenceMapping(prompt, materials, false), prompt);
  assert.equal(suanliaiReferencePrompt("002系列/test", prompt, materials, false), prompt);
});

test("material preparation retains the outside marker and every array position", async () => {
  const materialSource = server.slice(server.indexOf("async function prepareMaterials("), server.indexOf("function withReferenceMapping("));
  const prepareMaterials = vm.runInNewContext(`${materialSource}\nprepareMaterials;`, { publicUrl: (url) => new URL(url) });
  const meta = materials.map((item, index) => ({ ...item, url: `https://assets.example/${index}` }));
  const prepared = await prepareMaterials({ adapter: "seedancevideo" }, [], meta, {});
  assert.deepEqual(Array.from(prepared, (item) => ({ ...item })), meta);
});

test("outside references remain in all provider media payloads in their original order", () => {
  const input = { prompt: outsidePrompt, duration: 15, resolution: "720p", aspectRatio: "16:9", syncAudio: true,
    materials: materials.map((item, index) => ({ ...item, url: `https://assets.example/${index}` })) };
  const imageUrls = input.materials.filter((item) => item.kind === "image").map((item) => item.url);
  const audioUrls = input.materials.filter((item) => item.kind === "audio").map((item) => item.url);
  const lwaigc = lwaigcVideoPayload("dbb-sd2.0-v2", input, "original-id");
  const maxforai = maxforaiVideoPayload("YB-sd-2.5满血", input);
  assert.deepEqual(lwaigc.image_urls, imageUrls);
  assert.deepEqual(lwaigc.audio_urls, audioUrls);
  assert.deepEqual(maxforai.images, imageUrls);
  assert.deepEqual(maxforai.audios, audioUrls);
  for (const model of ["004系列/test", "003系列/test", "002系列/test"]) {
    const payload = suanliaiVideoPayload(model, input);
    assert.deepEqual(payload.images || payload.referenceImages, imageUrls);
    assert.deepEqual(payload.audios || payload.reference_audios || payload.referenceAudios, audioUrls);
  }
});
