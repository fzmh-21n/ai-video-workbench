import assert from "node:assert/strict";
import test from "node:test";

import {
  imageReferenceIssues,
  internalizeProjectAliases,
  planProjectReferences,
} from "../src/projectReferences.js";

function image(name, key = `image:${name}`) {
  return { key, kind: "image", name, file: { name } };
}

function stem(name) {
  return name.replace(/\.[^.]+$/, "");
}

function reference(asset, index = 1) {
  return {
    kind: "image",
    name: asset.name,
    projectAssetKey: asset.key,
    alias: stem(asset.name),
    tag: `@Image${index}`,
  };
}

function annotation(asset, requested = stem(asset.name)) {
  return `@${stem(asset.name)}=${requested}`;
}

test("the embedded student-family example retains the original wording and dotted suffix", () => {
  const asset = image("角色图_047_学生家属群像.png");
  const prompt = "【出场人物】角色图_047_学生家属群像中的S.B.C";
  const plan = planProjectReferences(prompt, [asset]);
  assert.equal(plan.annotatedPrompt, `【出场人物】${annotation(asset)}中的S.B.C`);
  assert.deepEqual(plan.matches.map((match) => match.asset.key), [asset.key]);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(imageReferenceIssues(plan.annotatedPrompt, [asset], [reference(asset)]), []);
});

test("both image modules find stems and full filenames without any surrounding word boundary", () => {
  for (const [heading, filename] of [
    ["出场人物", "角色图_047_学生家属群像.png"],
    ["出场场景", "场景图_001_学校会议室四视角.webp"],
  ]) {
    const asset = image(filename);
    for (const requested of [stem(filename), filename]) {
      for (const [before, after] of [
        ["只保留画面左侧的", "中的S.B.C继续点头"],
        ["abc123_./-", "XYZ456_./-"],
        ["前缀S.B.C", "后缀D.E.F"],
      ]) {
        const prompt = `【${heading}】${before}${requested}${after}`;
        const plan = planProjectReferences(prompt, [asset]);
        assert.equal(plan.annotatedPrompt, `【${heading}】${before}${annotation(asset, requested)}${after}`, prompt);
        assert.deepEqual(plan.matches.map((match) => match.asset.key), [asset.key], prompt);
        assert.deepEqual(plan.missing, [], prompt);
        assert.deepEqual(imageReferenceIssues(plan.annotatedPrompt, [asset], [reference(asset)]), [], prompt);
      }
    }
  }
});

test("multiple assets and every repeated occurrence are annotated inside long direction prose", () => {
  const first = image("角色图_001_陈凡现代旧装版.png");
  const second = image("角色图_015_红姐豹纹吊带版.png");
  const scene = image("场景图_001_低价酒店客房原状.png");
  const firstName = stem(first.name);
  const secondName = stem(second.name);
  const sceneName = stem(scene.name);
  const prompt = `【出场人物】开场${firstName}站在左侧${secondName}旁边，随后${firstName}继续听${secondName}说话。不开口者保持目光和即时反应。\n【出场场景】镜头始终位于${sceneName}内部，结尾仍保留${sceneName}的门和墙面。`;
  const expected = `【出场人物】开场${annotation(first)}站在左侧${annotation(second)}旁边，随后${annotation(first)}继续听${annotation(second)}说话。不开口者保持目光和即时反应。\n【出场场景】镜头始终位于${annotation(scene)}内部，结尾仍保留${annotation(scene)}的门和墙面。`;
  const assets = [first, second, scene];
  const plan = planProjectReferences(prompt, assets);
  assert.equal(plan.annotatedPrompt, expected);
  assert.deepEqual([...new Set(plan.matches.map((match) => match.asset.key))].sort(), assets.map((asset) => asset.key).sort());
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(imageReferenceIssues(expected, assets, assets.map((asset, index) => reference(asset, index + 1))), []);
  assert.equal(planProjectReferences(expected, assets).annotatedPrompt, expected);
});

test("arrow-linked state descriptions preserve timing, punctuation and adjacent prose", () => {
  const first = image("场景图_001_客房原状.png");
  const second = image("场景图_002_客房开门版.jpg");
  const prompt = `【出场场景】备用${first.name}内部→06踹门后改为${stem(second.name)}的门状态⇒08回看${first.name}墙面；同一客房，不另换房间。`;
  const expected = `【出场场景】备用${annotation(first, first.name)}内部→06踹门后改为${annotation(second)}的门状态⇒08回看${annotation(first, first.name)}墙面；同一客房，不另换房间。`;
  const assets = [first, second];
  const plan = planProjectReferences(prompt, assets);
  assert.equal(plan.annotatedPrompt, expected);
  assert.deepEqual(plan.missing, []);
  assert.equal(planProjectReferences(expected, assets).annotatedPrompt, expected);
  assert.deepEqual(imageReferenceIssues(expected, assets, assets.map((asset, index) => reference(asset, index + 1))), []);
});

test("existing readable aliases are not nested while later bare occurrences still receive an alias", () => {
  const asset = image("角色图_047_学生家属群像.png");
  const existing = annotation(asset);
  const prompt = `【出场人物】说明${existing}中的S.B.C，随后${stem(asset.name)}再次入画。`;
  const expected = `【出场人物】说明${existing}中的S.B.C，随后${existing}再次入画。`;
  const plan = planProjectReferences(prompt, [asset]);
  assert.equal(plan.annotatedPrompt, expected);
  assert.equal(planProjectReferences(expected, [asset]).annotatedPrompt, expected);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(imageReferenceIssues(expected, [asset], [reference(asset)]), []);
});

test("internalization changes only aliases and validates the attached image despite embedded prose", () => {
  const person = image("角色图_047_学生家属群像.png");
  const scene = image("场景图_001_学校会议室四视角.png");
  const references = [reference(person, 1), reference(scene, 2)];
  const prompt = `【出场人物】前缀${annotation(person)}中的S.B.C继续点头\n【出场场景】仍在${annotation(scene, scene.name)}内部；保留窗边层次。\n【镜头设计】${annotation(person)}只是镜头描述中的原文。`;
  const expected = `【出场人物】前缀@Image1=${stem(person.name)}中的S.B.C继续点头\n【出场场景】仍在@Image2=${scene.name}内部；保留窗边层次。\n【镜头设计】${annotation(person)}只是镜头描述中的原文。`;
  const internalized = internalizeProjectAliases(prompt, references);
  assert.equal(internalized, expected);
  assert.equal(internalizeProjectAliases(internalized, references), expected);
  assert.deepEqual(imageReferenceIssues(internalized, [person, scene], references), []);
});

test("image matching never spills into text before the modules or after another module heading", () => {
  const person = image("角色图_047_学生家属群像.png");
  const scene = image("场景图_001_学校会议室四视角.png");
  const prompt = `模块前${person.name}只是原文。\n【出场人物】前缀${stem(person.name)}中的S.B.C\n【本组首镜姿态继承】${person.name}保持上一组动作。\n【出场场景】沿用${stem(scene.name)}内部\n【镜头设计】${scene.name}和${stem(person.name)}都只是描述。`;
  const expected = `模块前${person.name}只是原文。\n【出场人物】前缀${annotation(person)}中的S.B.C\n【本组首镜姿态继承】${person.name}保持上一组动作。\n【出场场景】沿用${annotation(scene)}内部\n【镜头设计】${scene.name}和${stem(person.name)}都只是描述。`;
  const plan = planProjectReferences(prompt, [person, scene]);
  assert.equal(plan.annotatedPrompt, expected);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual([...new Set(plan.matches.map((match) => match.asset.key))].sort(), [person.key, scene.key].sort());
});

test("overlapping asset names select the longest available name without annotating its shorter substring", () => {
  const short = image("角色图_047_学生.png");
  const long = image("角色图_047_学生家属群像.png");
  const prompt = `【出场人物】镜头左侧${stem(long.name)}中的S.B.C继续点头`;
  const expected = `【出场人物】镜头左侧${annotation(long)}中的S.B.C继续点头`;
  for (const assets of [[short, long], [long, short]]) {
    const plan = planProjectReferences(prompt, assets);
    assert.equal(plan.annotatedPrompt, expected);
    assert.deepEqual(plan.matches.map((match) => match.asset.key), [long.key]);
    assert.deepEqual(plan.missing, []);
  }
});

test("an ambiguous stem is not guessed but its unique explicit filename can still be matched", () => {
  const first = image("角色图_047_学生家属群像.png");
  const second = image("角色图_047_学生家属群像.jpg");
  const assets = [first, second];
  const barePrompt = `【出场人物】${stem(first.name)}`;
  const ambiguous = planProjectReferences(barePrompt, assets);
  assert.equal(ambiguous.annotatedPrompt, barePrompt);
  assert.deepEqual(ambiguous.matches, []);
  assert.deepEqual(ambiguous.missing.map((entry) => entry.requested), [stem(first.name)]);
  assert.deepEqual(imageReferenceIssues(barePrompt, assets, []), [stem(first.name)]);
  const explicitPrompt = `【出场人物】镜头左侧${first.name}中的S.B.C`;
  const explicit = planProjectReferences(explicitPrompt, assets);
  assert.equal(explicit.annotatedPrompt, `【出场人物】镜头左侧${annotation(first, first.name)}中的S.B.C`);
  assert.deepEqual(explicit.matches.map((match) => match.asset.key), [first.key]);
  assert.deepEqual(explicit.missing, []);
});

test("duplicate exact filenames are not resolved by input order", () => {
  const name = "场景图_001_学校会议室四视角.png";
  const assets = [image(name, "image:first"), image(name, "image:second")];
  const prompt = `【出场场景】${name}`;
  const plan = planProjectReferences(prompt, assets);
  assert.equal(plan.annotatedPrompt, prompt);
  assert.deepEqual(plan.matches, []);
  assert.deepEqual(plan.missing.map((entry) => entry.requested), [name]);
  assert.deepEqual(imageReferenceIssues(prompt, assets, []), [name]);
});

test("missing three-part image declarations are reported but direction prose is never an image declaration", () => {
  const existing = image("角色图_047_学生家属群像.png");
  const missingPerson = "角色图_099_未上传人物";
  const missingScene = "场景图_099_未上传会议室.png";
  const peopleNote = "构图采用两侧对称的关系；最后一个动作落在静止的目光上。边缘光保留细微层次。";
  const sceneNote = "影调偏冷；墙面纹理与远处轮廓形成虚实对照，焦点落在台阶边缘。";
  const prompt = `【出场人物】${stem(existing.name)}、${missingPerson}\n${peopleNote}\n【出场场景】${missingScene}\n${sceneNote}`;
  const plan = planProjectReferences(prompt, [existing]);
  assert.deepEqual(plan.missing.map((entry) => entry.requested), [missingPerson, missingScene]);
  assert.ok(plan.annotatedPrompt.includes(peopleNote));
  assert.ok(plan.annotatedPrompt.includes(sceneNote));
  assert.deepEqual(imageReferenceIssues(plan.annotatedPrompt, [existing], [reference(existing)]), [missingPerson, missingScene]);
  const descriptionOnly = `【出场人物】${peopleNote}\n【出场场景】${sceneNote}\n【镜头设计】${missingPerson}仅为镜头描述。`;
  assert.equal(planProjectReferences(descriptionOnly, []).annotatedPrompt, descriptionOnly);
  assert.deepEqual(planProjectReferences(descriptionOnly, []).missing, []);
  assert.deepEqual(imageReferenceIssues(descriptionOnly, [], []), []);
});

test("ordinary text and non-three-part filenames are neither automatically matched nor marked missing", () => {
  const names = ["小明.png", "普通.png", "001_小明.png"];
  const prompt = "【出场人物】小明、普通.png、001_小明、001_小明.png、这是一段普通镜头描述。\n【出场场景】小明、普通.png、001_小明、001_小明.png、空镜保留墙面纹理。";
  for (const assets of [[], names.map((name) => image(name))]) {
    const plan = planProjectReferences(prompt, assets);
    assert.equal(plan.annotatedPrompt, prompt);
    assert.deepEqual(plan.matches, []);
    assert.deepEqual(plan.missing, []);
    assert.deepEqual(imageReferenceIssues(prompt, assets, []), []);
  }
});

test("a known embedded image without an attached reference is still reported once by its exact filename", () => {
  const person = image("角色图_047_学生家属群像.png");
  const scene = image("场景图_001_学校会议室四视角.png");
  const assets = [person, scene];
  const prompt = `【出场人物】前缀${stem(person.name)}中的S.B.C继续点头，随后${stem(person.name)}再次入画。\n【出场场景】沿用${scene.name}内部。`;
  const expected = assets.map((asset) => asset.name).sort();
  assert.deepEqual(imageReferenceIssues(prompt, assets, []).sort(), expected);
  assert.deepEqual(imageReferenceIssues(planProjectReferences(prompt, assets).annotatedPrompt, assets, []).sort(), expected);
  assert.deepEqual(imageReferenceIssues(prompt, assets, [reference(person)]), [scene.name]);
});

test("manual Image number validation is retained even though ordinary image names are ignored", () => {
  const prompt = "【出场人物】@Image3\n【出场场景】这是一段普通镜头描述。";
  assert.deepEqual(imageReferenceIssues(prompt, [], []), ["@Image3"]);
  const manual = { kind: "image", name: "手动图.png", tag: "@Image3" };
  assert.deepEqual(imageReferenceIssues(prompt, [], [manual]), []);
});
