import assert from "node:assert/strict";
import test from "node:test";

import { cleanMatchValue, planProjectReferences } from "../src/projectReferences.js";

function image(name) {
  return {
    key: `image:${name}`,
    kind: "image",
    file: { name },
    name,
  };
}

function audio(name) {
  return {
    key: `audio:${name}`,
    kind: "audio",
    file: { name },
    name,
  };
}

test("cleans spaces, hidden newlines, full-width digits, and full-width underscores", () => {
  assert.equal(cleanMatchValue(" \r０１１＿人物１\n "), "011_人物1");
});

test("matches a complete filename exactly before extension fallback", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n011_人物1.jpg",
    [image("011_人物1.jpg")],
  );

  assert.equal(plan.matches.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n@011_人物1=011_人物1.jpg");
});

test("matches exactly after removing only the asset extension", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n011_人物1",
    [image("011_人物1.jpg")],
  );

  assert.equal(plan.matches.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n@011_人物1=011_人物1");
});

test("keeps the numeric prefix and normalizes full-width match characters", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n０１１＿人物１",
    [image("011_人物1.png")],
  );

  assert.equal(plan.matches.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n@011_人物1=011_人物1");
});

test("does not use contains or similarity matching", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n011_人物正面",
    [image("011_人物背面.jpg"), image("011_人物正面特写.jpg")],
  );

  assert.equal(plan.matches.length, 0);
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n011_人物正面");
});

test("does not choose between duplicate extensionless filenames", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n011_人物1",
    [image("011_人物1.jpg"), image("011_人物1.png")],
  );

  assert.equal(plan.matches.length, 0);
  assert.equal(plan.missing.length, 1);
});

test("matches every scene listed on separate background lines", () => {
  const plan = planProjectReferences(
    [
      "【本节的所有背景】",
      "013_三号防火瞭望屋外雪夜",
      "014_三号防火瞭望屋内困守版",
      "【本节背景说明】",
      "后续说明不属于场景名称。",
    ].join("\n"),
    [
      image("013_三号防火瞭望屋外雪夜.jpg"),
      image("014_三号防火瞭望屋内困守版.png"),
    ],
  );

  assert.equal(plan.matches.length, 2);
  assert.equal(
    plan.annotatedPrompt,
    [
      "【本节的所有背景】",
      "@013_三号防火瞭望屋外雪夜=013_三号防火瞭望屋外雪夜",
      "@014_三号防火瞭望屋内困守版=014_三号防火瞭望屋内困守版",
      "【本节背景说明】",
      "后续说明不属于场景名称。",
    ].join("\n"),
  );
});

test("matches every voice after removing only the fixed voice-number label", () => {
  const plan = planProjectReferences(
    [
      "【本段角色声线锁定】",
      "陈卫东 【声音2】：中年男性，中低音。",
      "孙桂兰【声音１】：中年女性，中低音。",
      "何志勇 【声音3】: 中年男性，中低音。",
      "【本节出场的所有人物】",
      "陈卫东",
    ].join("\n"),
    [audio("陈卫东.wav"), audio("孙桂兰.wav"), audio("何志勇.wav")],
  );

  assert.equal(plan.matches.filter((match) => match.role === "voice").length, 3);
  assert.equal(
    plan.annotatedPrompt,
    [
      "【本段角色声线锁定】",
      "@陈卫东=陈卫东 【声音2】：中年男性，中低音。",
      "@孙桂兰=孙桂兰【声音１】：中年女性，中低音。",
      "@何志勇=何志勇 【声音3】: 中年男性，中低音。",
      "【本节出场的所有人物】",
      "陈卫东",
    ].join("\n"),
  );
});
