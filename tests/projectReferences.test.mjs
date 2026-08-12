import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanMatchValue,
  internalizeProjectAliases,
  planProjectReferences,
} from "../src/projectReferences.js";

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

function numberedName(number, label) {
  return `${String(number).padStart(3, "0")}_${label}`;
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
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n@011_人物1=011_人物1.jpg，");
});

test("matches exactly after removing only the asset extension", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n011_人物1",
    [image("011_人物1.jpg")],
  );

  assert.equal(plan.matches.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n@011_人物1=011_人物1，");
});

test("ignores parenthesized descriptions after real people and scene asset names", () => {
  const prompt = [
    "【本节出场的所有人物】",
    "001_孙桂兰冬季采药版（雪夜站雪防寒服，托扶重伤的陈卫东）",
    "009_靠山村村民群体（手持登记表、手电和猎叉，堵住下山路）",
    "011_何志勇（站在伤员与村民之间维持隔离）",
    "【本节的所有背景】",
    "015_三号瞭望屋围堵雪夜版（木屋门前与南侧下山路被村民围堵的雪夜状态）",
  ].join("\n");
  const result = planProjectReferences(prompt, [
    image("001_孙桂兰冬季采药版.png"),
    image("009_靠山村村民群体.png"),
    image("011_何志勇.png"),
    image("015_三号瞭望屋围堵雪夜版.png"),
  ]);

  assert.deepEqual(result.matches.map((item) => item.requested), [
    "001_孙桂兰冬季采药版",
    "009_靠山村村民群体",
    "011_何志勇",
    "015_三号瞭望屋围堵雪夜版",
  ]);
  assert.equal(result.missing.length, 0);
  assert.match(
    result.annotatedPrompt,
    /@001_孙桂兰冬季采药版=001_孙桂兰冬季采药版（雪夜站雪防寒服，托扶重伤的陈卫东），/,
  );
  assert.match(
    result.annotatedPrompt,
    /@015_三号瞭望屋围堵雪夜版=015_三号瞭望屋围堵雪夜版，(?:\n|$)/,
  );
  assert.doesNotMatch(result.annotatedPrompt, /@015_[^\n]+（/);
});

test("does not report background narrative as a missing image", () => {
  const prompt = [
    "【本节的所有背景】",
    "015_三号瞭望屋围堵雪夜版（木屋门前与南侧下山路被村民围堵的雪夜状态）",
    "深夜，承接陈卫东说‘娘，由孙桂兰托扶，村民堵住下山路，何志勇隔在双方中间。",
    "【本节光影基准】",
    "冷蓝色雪夜环境光。",
  ].join("\n");
  const result = planProjectReferences(prompt, [image("015_三号瞭望屋围堵雪夜版.png")]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.missing.length, 0);
  assert.match(result.annotatedPrompt, /@015_三号瞭望屋围堵雪夜版=015_三号瞭望屋围堵雪夜版，\n深夜/);
});

test("repairs previously annotated people commas and removes old scene descriptions", () => {
  const prompt = [
    "【本节出场的所有人物】",
    "@001_孙桂兰冬季采药版=001_孙桂兰冬季采药版（托扶陈卫东）",
    "@011_何志勇=011_何志勇（维持隔离），",
    "【本节的所有背景】",
    "@015_三号瞭望屋围堵雪夜版=015_三号瞭望屋围堵雪夜版（雪夜状态）",
  ].join("\n");
  const result = planProjectReferences(prompt, [
    image("001_孙桂兰冬季采药版.png"),
    image("011_何志勇.png"),
    image("015_三号瞭望屋围堵雪夜版.png"),
  ]);
  assert.match(result.annotatedPrompt, /（托扶陈卫东），\n/);
  assert.match(result.annotatedPrompt, /（维持隔离），\n/);
  assert.match(result.annotatedPrompt, /@015_三号瞭望屋围堵雪夜版=015_三号瞭望屋围堵雪夜版，$/);
  assert.doesNotMatch(result.annotatedPrompt, /雪夜状态/);
});

test("keeps the numeric prefix and normalizes full-width match characters", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n０１１＿人物１",
    [image("011_人物1.png")],
  );

  assert.equal(plan.matches.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n@011_人物1=011_人物1，");
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
      "@013_三号防火瞭望屋外雪夜=013_三号防火瞭望屋外雪夜，",
      "@014_三号防火瞭望屋内困守版=014_三号防火瞭望屋内困守版，",
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

test("matches mixed people, scenes, and voices in one prompt", () => {
  const prompt = [
    "【本段角色声线锁定】",
    "旁白【声音1】：低沉",
    "林晓【声音2】：清亮",
    "顾远【声音3】：稳重",
    "【本节出场的所有人物】",
    "001_林晓、002_顾远，003_旁白",
    "004_医生;005_护士；006_司机",
    "【本节的所有背景】",
    "011_医院门口",
    "012_医院走廊、013_诊室",
  ].join("\n");
  const names = [
    "旁白", "林晓", "顾远", "001_林晓", "002_顾远", "003_旁白",
    "004_医生", "005_护士", "006_司机", "011_医院门口", "012_医院走廊", "013_诊室",
  ];
  const assets = [
    audio("旁白.mp3"), audio("林晓.wav"), audio("顾远.m4a"),
    ...names.slice(3, 9).map((name) => image(`${name}.png`)),
    ...names.slice(9).map((name) => image(`${name}.jpg`)),
  ];

  const result = planProjectReferences(prompt, assets);

  assert.equal(result.matches.length, 12);
  assert.equal(result.missing.length, 0);
  for (const name of names) assert.ok(result.annotatedPrompt.includes(`@${name}=${name}`));
});

test("handles the full 30 image and 10 audio reference capacity", () => {
  const people = Array.from({ length: 20 }, (_, index) => numberedName(index + 1, `人物${index + 1}`));
  const scenes = Array.from({ length: 10 }, (_, index) => numberedName(index + 101, `场景${index + 1}`));
  const voices = Array.from({ length: 10 }, (_, index) => `声线角色${index + 1}`);
  const prompt = [
    "【本段角色声线锁定】",
    ...voices.map((name, index) => `${name}【声音${index + 1}】：测试声线`),
    "【本节出场的所有人物】",
    people.join("、"),
    "【本节的所有背景】",
    ...scenes,
  ].join("\r\n");
  const assets = [
    ...people.map((name) => image(`${name}.png`)),
    ...scenes.map((name) => image(`${name}.jpeg`)),
    ...voices.map((name) => audio(`${name}.mp3`)),
  ];

  const result = planProjectReferences(prompt, assets);

  assert.equal(result.matches.length, 40);
  assert.equal(result.missing.length, 0);
  assert.equal((result.annotatedPrompt.match(/@[^=\r\n]+=/g) || []).length, 40);
  for (const name of [...people, ...scenes, ...voices]) {
    assert.ok(result.annotatedPrompt.includes(`@${name}=${name}`));
  }
});

test("normalizes fullwidth characters on both prompt and asset filenames", () => {
  const prompt = [
    "【本节出场的所有人物】",
    "０１１＿人物正面",
    "【本节的所有背景】",
    "０２１＿林间空地",
  ].join("\n");
  const result = planProjectReferences(prompt, [
    image("011_人物正面.jpg"),
    image("０２１＿林间空地.png"),
  ]);

  assert.equal(result.matches.length, 2);
  assert.equal(result.missing.length, 0);
  assert.match(result.annotatedPrompt, /@011_人物正面=011_人物正面/);
  assert.match(result.annotatedPrompt, /@021_林间空地=021_林间空地/);
});

test("keeps exact punctuation and does not collapse distinct directions", () => {
  const prompt = [
    "【本节出场的所有人物】",
    "011_人物（正面）、011_人物（背面）",
  ].join("\n");
  const result = planProjectReferences(prompt, [
    image("011_人物（正面）.jpg"),
    image("011_人物正面.jpg"),
  ]);

  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.missing.map((item) => item.requested), ["011_人物（背面）"]);
  assert.match(result.annotatedPrompt, /@011_人物（正面）=011_人物（正面）/);
  assert.doesNotMatch(result.annotatedPrompt, /@011_人物正面=011_人物（背面）/);
});

test("annotates exact matches while leaving only missing entries unchanged", () => {
  const prompt = [
    "【本节的所有背景】",
    "101_场景1",
    "102_场景2",
    "103_场景3",
  ].join("\n");
  const result = planProjectReferences(prompt, [image("101_场景1.jpg"), image("103_场景3.jpg")]);

  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.missing.map((item) => item.requested), ["102_场景2"]);
  assert.match(result.annotatedPrompt, /@101_场景1=101_场景1/);
  assert.match(result.annotatedPrompt, /\n102_场景2\n/);
  assert.match(result.annotatedPrompt, /@103_场景3=103_场景3/);
});

test("is idempotent when the same prompt is planned repeatedly", () => {
  const prompt = [
    "【本段角色声线锁定】",
    "林晓【声音1】：清亮",
    "【本节出场的所有人物】",
    "011_林晓",
    "【本节的所有背景】",
    "021_客厅",
  ].join("\n");
  const assets = [audio("林晓.mp3"), image("011_林晓.jpg"), image("021_客厅.png")];
  const first = planProjectReferences(prompt, assets);
  const second = planProjectReferences(first.annotatedPrompt, assets);

  assert.equal(second.annotatedPrompt, first.annotatedPrompt);
  assert.equal((second.annotatedPrompt.match(/@[^=\n]+=/g) || []).length, 3);
});

test("internalizes every generated image and audio alias", () => {
  const prompt = [
    "【本段角色声线锁定】",
    "@旁白=旁白【声音1】：低沉",
    "@林晓=林晓【声音2】：清亮",
    "【本节出场的所有人物】",
    "@001_林晓=001_林晓、@002_顾远=002_顾远",
    "【本节的所有背景】",
    "@101_医院=101_医院",
    "@102_街道=102_街道",
  ].join("\n");
  const references = [
    { kind: "audio", alias: "旁白", tag: "@Audio1" },
    { kind: "audio", alias: "林晓", tag: "@Audio2" },
    { kind: "image", alias: "001_林晓", tag: "@Image1" },
    { kind: "image", alias: "002_顾远", tag: "@Image2" },
    { kind: "image", alias: "101_医院", tag: "@Image3" },
    { kind: "image", alias: "102_街道", tag: "@Image4" },
  ];

  const result = internalizeProjectAliases(prompt, references);

  for (const [tag, name] of [
    ["@Audio1", "旁白"], ["@Audio2", "林晓"], ["@Image1", "001_林晓"],
    ["@Image2", "002_顾远"], ["@Image3", "101_医院"], ["@Image4", "102_街道"],
  ]) {
    assert.ok(result.includes(`${tag}=${name}`));
  }
});
