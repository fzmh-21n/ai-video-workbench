import assert from "node:assert/strict";
import test from "node:test";

import { imageReferenceIssues, planProjectReferences } from "../src/projectReferences.js";

function image(name, key = `image:${name}`) {
  return { key, kind: "image", name, file: { name } };
}

function audio(name) {
  return { key: `audio:${name}`, kind: "audio", name, file: { name } };
}

function attached(asset, number) {
  return { kind: asset.kind, name: asset.name, projectAssetKey: asset.key, tag: `@Image${number}` };
}

test("attaches an existing costume image mentioned in environment notes without declaring another cast member", () => {
  const person = image("角色图_001_许小禾日常.png");
  const scene = image("场景图_003_望春前厅日间四视角.png");
  const costume = image("角色图_002_许小禾样衣_v2.png");
  const environment = `【场景环境】\n衣架上的浅绿碎花样衣参照${costume.name}，只取衣物外观，不添加人物。`;
  const prompt = `【出场人物】${person.name}\n【出场场景】${scene.name}\n${environment}`;
  const plan = planProjectReferences(prompt, [person, scene, costume]);

  assert.deepEqual(plan.matches.map((entry) => entry.asset.key), [person.key, scene.key]);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.outsideMatches.length, 1);
  assert.deepEqual(
    Object.fromEntries(["requested", "kind", "role", "noAutoMention", "heading", "asset"].map((name) => [name, plan.outsideMatches[0][name]])),
    { requested: costume.name, kind: "image", role: "outside", noAutoMention: true, heading: "__outside_image__", asset: costume },
  );
  assert.equal(plan.annotatedPrompt.slice(plan.annotatedPrompt.indexOf("【场景环境】")), environment);
  assert.doesNotMatch(plan.annotatedPrompt, /@角色图_002_许小禾样衣_v2/);
  assert.deepEqual(imageReferenceIssues(plan.annotatedPrompt, [person, scene, costume], [attached(person, 1), attached(scene, 2)]), []);
});

test("finds outside images before the cast block and under unrelated headings while preserving those passages exactly", () => {
  const first = image("角色图_002_样衣.png");
  const second = image("场景图_012_旧客房.png");
  const prefix = `开场只参考${first.name}的布料，不添加人物。\n`;
  const ending = `【镜头说明】\n门板质感参考${second.name}，仍是当前客房。`;
  const prompt = `${prefix}【出场人物】无新增人物\n【出场场景】沿用当前房间\n${ending}`;
  const plan = planProjectReferences(prompt, [first, second]);

  assert.deepEqual(plan.outsideMatches.map((entry) => entry.asset.key), [first.key, second.key]);
  assert.deepEqual(plan.matches, []);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.annotatedPrompt, prompt);
});

test("deduplicates repeated outside mentions with and without filename extensions", () => {
  const asset = image("角色图_002_许小禾样衣_v2.png");
  const stem = asset.name.slice(0, -4);
  const prompt = `【出场人物】无新增人物\n【场景环境】${asset.name}只参考布料；${stem}的S.B.C不改变；${asset.name}同上。`;
  const plan = planProjectReferences(prompt, [asset]);

  assert.deepEqual(plan.outsideMatches.map((entry) => entry.asset.key), [asset.key]);
  assert.equal(plan.annotatedPrompt, prompt);
});

test("a cast or scene declaration takes precedence over every outside mention of the same image", () => {
  const person = image("角色图_001_许小禾日常.png");
  const scene = image("场景图_003_望春前厅日间四视角.png");
  const outside = image("角色图_002_许小禾样衣_v2.png");
  const prompt = `先参考${person.name}。\n【出场人物】${person.name}\n【出场场景】${scene.name}\n【场景环境】${scene.name}门板不变；衣服参考${outside.name}。`;
  const plan = planProjectReferences(prompt, [person, scene, outside]);

  assert.deepEqual(plan.matches.map((entry) => entry.asset.key), [person.key, scene.key]);
  assert.deepEqual(plan.outsideMatches.map((entry) => entry.asset.key), [outside.key]);
  assert.ok(plan.annotatedPrompt.startsWith(`先参考${person.name}。`));
  assert.ok(plan.annotatedPrompt.endsWith(`【场景环境】${scene.name}门板不变；衣服参考${outside.name}。`));
});

test("ignores missing outside images but retains a genuinely missing image in the cast block", () => {
  const declaredMissing = "角色图_099_新人物.png";
  const prompt = `【出场人物】${declaredMissing}\n【出场场景】沿用旧场景\n【场景环境】角色图_002_许小禾样衣_v2.png与场景图_012_旧客房.png只作说明。`;
  const plan = planProjectReferences(prompt, []);

  assert.deepEqual(plan.outsideMatches, []);
  assert.deepEqual(plan.matches, []);
  assert.deepEqual(plan.missing.map((entry) => entry.requested), [declaredMissing]);
  assert.deepEqual(imageReferenceIssues(prompt, [], []), [declaredMissing]);
  assert.equal(plan.annotatedPrompt, prompt);
});

test("matches the longest unique full asset stem embedded in arbitrary outside prose", () => {
  const short = image("角色图_047_学生家属.png");
  const long = image("角色图_047_学生家属群像_v2.png");
  const prompt = "【出场人物】无新增人物\n【道具说明】前景布料借用角色图_047_学生家属群像_v2中的S.B.C，后面继续任意文字。";
  const plan = planProjectReferences(prompt, [short, long]);

  assert.deepEqual(plan.outsideMatches.map((entry) => entry.asset.key), [long.key]);
  assert.equal(plan.outsideMatches[0].requested, long.name.slice(0, -4));
  assert.equal(plan.annotatedPrompt, prompt);
});

test("never substitutes a shorter existing image for a missing explicit outside filename", () => {
  const asset = image("角色图_002_许小禾样衣.png");
  const prompt = "【出场人物】无新增人物\n【场景环境】服装参考角色图_002_许小禾样衣_v2.png，保留道具外观。";
  const plan = planProjectReferences(prompt, [asset]);

  assert.deepEqual(plan.outsideMatches, []);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.annotatedPrompt, prompt);
});

test("does not guess between duplicate outside names or ambiguous extensionless variants", () => {
  const png = image("角色图_002_许小禾样衣_v2.png");
  const jpg = image("角色图_002_许小禾样衣_v2.jpg");
  const prefix = "【出场人物】无新增人物\n【场景环境】衣服参考";
  const ambiguousStem = planProjectReferences(`${prefix}角色图_002_许小禾样衣_v2，保留外观。`, [png, jpg]);
  assert.deepEqual(ambiguousStem.outsideMatches, []);
  assert.deepEqual(ambiguousStem.missing, []);

  const exact = planProjectReferences(`${prefix}${png.name}。`, [png, jpg]);
  assert.deepEqual(exact.outsideMatches.map((entry) => entry.asset.key), [png.key]);

  const duplicate = planProjectReferences(`${prefix}${png.name}。`, [png, image(png.name, "image:duplicate")]);
  assert.deepEqual(duplicate.outsideMatches, []);
  assert.deepEqual(duplicate.missing, []);
});

test("uses the same outside-image rules with legacy cast and scene headings", () => {
  const person = image("角色图_001_许小禾日常.png");
  const scene = image("场景图_003_望春前厅日间四视角.png");
  const outside = image("角色图_002_许小禾样衣_v2.png");
  const note = `【本节背景说明】\n服装参考${outside.name}，其他内容不变。`;
  const prompt = `【本节出场的所有人物】${person.name}\n【本节的所有背景】${scene.name}\n${note}`;
  const plan = planProjectReferences(prompt, [person, scene, outside]);

  assert.deepEqual(plan.matches.map((entry) => entry.asset.key), [person.key, scene.key]);
  assert.deepEqual(plan.outsideMatches.map((entry) => entry.asset.key), [outside.key]);
  assert.ok(plan.annotatedPrompt.endsWith(note));
  assert.deepEqual(imageReferenceIssues(plan.annotatedPrompt, [person, scene, outside], [attached(person, 1), attached(scene, 2)]), []);
});

test("can identify existing outside images in plain prose without changing legacy matches or missing results", () => {
  const asset = image("角色图_002_许小禾样衣_v2.png");
  const prompt = `衣物参照${asset.name}，角色图_099_旧图.png只是历史说明，不新增人物。`;
  const plan = planProjectReferences(prompt, [asset]);

  assert.deepEqual(plan.outsideMatches.map((entry) => entry.asset.key), [asset.key]);
  assert.deepEqual(plan.matches, []);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.annotatedPrompt, prompt);
});

test("outside image collection does not change audio and explicit legacy reference compatibility", () => {
  const voice = audio("声音1.wav");
  const legacyImage = image("角色图_001_许小禾日常.png");
  const outside = image("角色图_002_许小禾样衣_v2.png");
  const note = `【场景环境】服装参考${outside.name}。`;
  const prompt = `【角色声线】声音1\n【出场人物】无新增人物\n【旧绑定】@Image1=${legacyImage.name}\n${note}`;
  const plan = planProjectReferences(prompt, [voice, legacyImage, outside]);

  assert.deepEqual(plan.matches.map((entry) => entry.asset.key), [voice.key, legacyImage.key]);
  assert.deepEqual(plan.outsideMatches.map((entry) => entry.asset.key), [outside.key]);
  assert.deepEqual(plan.missing, []);
  assert.match(plan.annotatedPrompt, /@声音1=声音1/);
  assert.match(plan.annotatedPrompt, /@角色图_001_许小禾日常=角色图_001_许小禾日常\.png/);
  assert.ok(plan.annotatedPrompt.endsWith(note));
});

test("collects only structured image names outside the two image modules", () => {
  const names = ["许小禾样衣.png", "002_许小禾样衣.png", "角色图_02_许小禾样衣.png", "角色图_002_许小禾样衣_v2.png"];
  const assets = names.map((name) => image(name));
  const prompt = `【出场人物】无新增人物\n【道具说明】${names.join("、")}。`;
  const plan = planProjectReferences(prompt, assets);

  assert.deepEqual(plan.outsideMatches.map((entry) => entry.asset.key), [assets.at(-1).key]);
  assert.deepEqual(plan.matches, []);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.annotatedPrompt, prompt);
});
