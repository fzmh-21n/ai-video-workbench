import assert from "node:assert/strict";
import test from "node:test";

import { batchImageReferenceIssues } from "../src/batchReferences.js";
import { imageReferenceIssues, planProjectReferences } from "../src/projectReferences.js";

const oldName = "角色图_002_许小禾样衣_v2.png";
const names = [
  "角色图_001_许小禾日常.png",
  "角色图_006_岑月娘.png",
  "角色图_007_方桂枝日常.png",
  "角色图_011_苏芙蓉_v2.png",
  "场景图_003_望春前厅日间四视角.png",
];
const image = (name) => ({ kind: "image", key: `image:${name}`, name });
const assets = names.map(image);
const references = assets.map((asset, index) => ({
  kind: "image", name: asset.name, projectAssetKey: asset.key,
  alias: asset.name.slice(0, -4), tag: `@Image${index + 1}`,
}));
const cast = names.slice(0, 4).map((name) => `@${name.slice(0, -4)}=${name}`).join("、");
const modules = `【出场人物】${cast}\n【出场场景】${names[4]}`;
const outsideNotes = `【场景环境】衣架上的样衣取材自${oldName}，不新增人物。\n【风格总述】保留${oldName}的衣纹细节。`;

test("cast and scene validation ignores a costume filename used only by environment and style modules", () => {
  const prompt = `${modules}\n${outsideNotes}`;
  for (const projectAssets of [assets, [...assets, image(oldName)]]) {
    const plan = planProjectReferences(prompt, projectAssets);
    assert.deepEqual(plan.missing, []);
    assert.deepEqual([...new Set(plan.matches.map((entry) => entry.asset.key))], assets.map((asset) => asset.key));
    assert.deepEqual(imageReferenceIssues(prompt, projectAssets, references), []);
    assert.ok(plan.annotatedPrompt.includes(outsideNotes));
  }
});

test("filenames before the reference modules or after later headings are not additional reference requirements", () => {
  const prompt = `固定说明：${oldName}只是版式示例。\n${modules}\n【镜头设计】不要出现${oldName}。`;
  assert.deepEqual(imageReferenceIssues(prompt, assets, references), []);
});

test("a cast module alone scopes filename requirements without needing a scene module", () => {
  const prompt = `【出场人物】${cast}\n【场景环境】${oldName}是衣服取样。`;
  assert.deepEqual(imageReferenceIssues(prompt, assets, references.slice(0, 4)), []);
});

test("a scene module alone scopes filename requirements without needing a cast module", () => {
  const prompt = `【出场场景】${names[4]}\n【风格总述】${oldName}只是色彩参考。`;
  assert.deepEqual(imageReferenceIssues(prompt, assets, references.slice(4)), []);
});

test("legacy cast and background headings use the same bounded filename validation", () => {
  for (const heading of ["本节出场的所有人物", "本节的所有背景"]) {
    const connected = heading.includes("人物") ? references[0] : references[4];
    const prompt = `【${heading}】${connected.name}\n【镜头设计】${oldName}只是原文。`;
    assert.deepEqual(imageReferenceIssues(prompt, assets, [connected]), []);
  }
});

test("the same missing costume filename is still required when it occurs inside the cast module", () => {
  const prompt = `【出场人物】${cast}、${oldName}\n【出场场景】${names[4]}\n${outsideNotes}`;
  assert.deepEqual(imageReferenceIssues(prompt, assets, references), [oldName]);
  assert.deepEqual(imageReferenceIssues(prompt, [...assets, image(oldName)], references), [oldName]);
});

test("missing scene filenames and extensionless structured names remain required inside reference modules", () => {
  const missingScene = "场景图_099_未上传后院.png";
  const missingPerson = "角色图_099_未上传来客";
  const prompt = `【出场人物】${cast}、${missingPerson}\n【出场场景】${missingScene}\n${outsideNotes}`;
  assert.deepEqual(imageReferenceIssues(prompt, assets, references), [missingPerson, missingScene]);
});

test("plain text and unfamiliar headings retain filename validation when no reference module exists", () => {
  for (const prompt of [oldName, `【画面素材】${names[0]}、${oldName}`, `【场景环境】${oldName}`]) {
    assert.deepEqual(imageReferenceIssues(prompt, assets, references), [oldName]);
  }
});

test("native image tags are validated everywhere even outside recognized reference modules", () => {
  for (const tag of ["@Image99", "@图9", "@图片9", "@Image1错误后缀"]) {
    assert.deepEqual(imageReferenceIssues(`${modules}\n【镜头】动作参考${tag}`, assets, references), [tag]);
  }
  for (const tag of ["@Image1", "@图1", "@图片1"]) {
    assert.deepEqual(imageReferenceIssues(`${modules}\n【镜头】动作参考 ${tag}`, assets, references), []);
  }
});

test("below-capacity matched batches ignore outside filenames but still report genuine module omissions", () => {
  const row = { status: "matched", prompt: `${modules}\n${outsideNotes}`, references };
  assert.ok(references.length < 9);
  assert.deepEqual(batchImageReferenceIssues(row, assets, 9), []);
  const missing = { ...row, prompt: `【出场人物】${cast}、${oldName}\n【出场场景】${names[4]}` };
  assert.deepEqual(batchImageReferenceIssues(missing, assets, 9), [oldName]);
});

test("the existing full-image exemption remains model-capacity-aware after scoping filenames", () => {
  const extra = Array.from({ length: 4 }, (_, index) => image(`角色图_${String(index + 20).padStart(3, "0")}_群像${index}.png`));
  const fullAssets = [...assets, ...extra];
  const fullReferences = fullAssets.map((asset, index) => ({ kind: "image", name: asset.name, projectAssetKey: asset.key, tag: `@Image${index + 1}` }));
  const row = { status: "matched", prompt: `【出场人物】${oldName}\n【出场场景】${names[4]}\n【镜头】角色图_098_示例.png`, references: fullReferences };
  assert.deepEqual(batchImageReferenceIssues(row, fullAssets, 9), []);
  assert.deepEqual(batchImageReferenceIssues(row, fullAssets, 30), [oldName]);
});
