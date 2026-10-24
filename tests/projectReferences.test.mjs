import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanMatchValue,
  imageReferenceIssues,
  internalizeProjectAliases,
  planProjectAudioReferences,
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

const transitionPrompt = [
  "【出场人物】：",
  "@角色图_001_陈凡现代旧装版=角色图_001_陈凡现代旧装版.png、@角色图_015_红姐豹纹吊带版=角色图_015_红姐豹纹吊带版.png、@角色图_037_纹身壮汉甲=角色图_037_纹身壮汉甲.png、@角色图_038_纹身壮汉乙=角色图_038_纹身壮汉乙.png。",
  "01—05只有陈凡和红姐；06甲乙从门口实际进入，06—08四人始终在场。不开口者保持倾听、目光和即时反应；警察尚未到场。",
  "",
  "【出场场景】：",
  "场景图_001_低价酒店客房原状.png→06踹门后使用场景图_002_低价酒店客房开门版.png；同一客房的门状态变化，不另换房间。",
].join("\n");
const transitionNames = [
  "角色图_001_陈凡现代旧装版.png", "角色图_015_红姐豹纹吊带版.png",
  "角色图_037_纹身壮汉甲.png", "角色图_038_纹身壮汉乙.png",
  "场景图_001_低价酒店客房原状.png", "场景图_002_低价酒店客房开门版.png",
];

test("matches four declared characters and both door-state scenes without treating shot instructions as filenames", () => {
  const assets = transitionNames.map(image);
  const plan = planProjectReferences(transitionPrompt, assets);
  assert.deepEqual(plan.matches.map((match) => match.asset.name), transitionNames);
  assert.deepEqual(plan.missing, []);
  assert.ok(plan.annotatedPrompt.includes(transitionPrompt.split("\n")[2]));
  const scene = plan.annotatedPrompt.split("【出场场景】：\n")[1].replace(/@场景图_[^=]+=/g, "");
  assert.equal(scene, transitionPrompt.split("【出场场景】：\n")[1]);
  const references = assets.map((asset, index) => ({ kind: "image", name: asset.name, projectAssetKey: asset.key, alias: asset.name.slice(0, -4), tag: `@Image${index + 1}` }));
  assert.deepEqual(imageReferenceIssues(plan.annotatedPrompt, assets, references), []);
  assert.equal(planProjectReferences(plan.annotatedPrompt, assets).annotatedPrompt, plan.annotatedPrompt);
});

test("a missing scene in a transition is reported by its exact filename, not the surrounding description", () => {
  const assets = transitionNames.slice(0, -1).map(image);
  const plan = planProjectReferences(transitionPrompt, assets);
  assert.deepEqual(plan.matches.map((match) => match.asset.name), transitionNames.slice(0, -1));
  assert.deepEqual(plan.missing.map((entry) => entry.requested), [transitionNames.at(-1)]);
});

test("scene explanations alone never become scene filenames and do not suppress an explicit missing scene", () => {
  const note = "同一客房的门状态变化，不另换房间。";
  assert.deepEqual(planProjectReferences(`【出场场景】：${note}`, []).missing, []);
  assert.deepEqual(planProjectReferences(`【出场场景】：06踹门后使用场景图_002_低价酒店客房开门版.png；${note}`, []).missing.map((entry) => entry.requested), [transitionNames.at(-1)]);
});

test("shot instructions and bare person names are ignored while structured declarations remain validated", () => {
  for (const separator of ["；", "。", ";"]) {
    const prompt = `【出场人物】01—05只有陈凡${separator}小明`;
    const plan = planProjectReferences(prompt, []);
    assert.deepEqual(plan.missing, []);
    assert.equal(plan.annotatedPrompt, prompt);
  }
  // 结构化块的新人物也必须明确写素材名，不把裸说明猜作图片名。
  assert.deepEqual(planProjectReferences("【出场人物】角色图_001_陈凡现代旧装版.png、角色图_099_缺少人物小明.png", [image(transitionNames[0])]).missing.map((entry) => entry.requested), ["角色图_099_缺少人物小明.png"]);
});

test("structured image blocks ignore arbitrary prose but still validate precise declared names", () => {
  const first = "角色图_010_苏清寒黑色职业装版";
  const note = "四人均在门前同一空间，所有现场人物始终在场，未说话者保持倾听、目光和即时反应；黄毛留监室，红姐及同伙留酒店，不生成其他群众。";
  const prompt = `【出场人物】${first}.png。\n${note}`;
  const plan = planProjectReferences(prompt, [image(`${first}.png`)]);
  assert.deepEqual(plan.missing, []);
  assert.ok(plan.annotatedPrompt.includes(note));
  const absent = planProjectReferences(prompt, []);
  assert.deepEqual(absent.missing.map((entry) => entry.requested), [`${first}.png`]);
  assert.deepEqual(planProjectReferences(`【出场人物】${first}、普通调度说明`, [image(`${first}.png`)]).missing, []);
});

test("structured declarations ignore two-part and ordinary filenames but retain native reference validation", () => {
  const name = "角色图_010_苏清寒黑色职业装版";
  const prompt = `【出场人物】${name}、０１１＿旧角色、其他人物.jpg、@Image99。\n普通说明随时可以新增，不要求命中某个关键词。`;
  const assets = [image(`${name}.png`), image("011_旧角色.png"), image("其他人物.jpg")];
  const plan = planProjectReferences(prompt, assets);
  assert.deepEqual(plan.matches.map((entry) => entry.asset.name), [`${name}.png`]);
  assert.deepEqual(plan.missing, []);
  const references = assets.map((asset, index) => ({ kind: "image", name: asset.name, projectAssetKey: asset.key, alias: asset.name.replace(/\.[^.]+$/, ""), tag: `@Image${index + 1}` }));
  assert.ok(imageReferenceIssues(plan.annotatedPrompt, assets, references).some((name) => name.startsWith("@Image99")));
  assert.deepEqual(planProjectReferences(`【出场人物】${name}、０９９＿位于船舱版`, []).missing.map((entry) => entry.requested), [name]);
});

test("bare people are ignored even when the same block includes a structured naming example", () => {
  const prompt = "【出场人物】小明\n素材命名示例为角色图_001_描述，不是本节素材。";
  assert.deepEqual(planProjectReferences(prompt, []).missing.map((entry) => entry.requested), ["角色图_001_描述"]);
  assert.deepEqual(imageReferenceIssues(prompt, [], []), ["角色图_001_描述"]);
});

test("structured scene transitions also recognize exact filenames without extensions", () => {
  const first = "场景图_001_客房原状";
  const second = "场景图_002_客房开门版";
  const prompt = `【出场场景】${first}→06踹门后使用${second}；同一客房的门状态变化，不另换房间。`;
  const assets = [image(`${first}.png`), image(`${second}.png`)];
  const plan = planProjectReferences(prompt, assets);
  assert.deepEqual(plan.matches.map((entry) => entry.requested), [first, second]);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.annotatedPrompt.replace(/@场景图_[^=]+=/g, ""), prompt);
  assert.equal(planProjectReferences(plan.annotatedPrompt, assets).annotatedPrompt, plan.annotatedPrompt);
  assert.deepEqual(planProjectReferences(prompt, assets.slice(0, 1)).missing.map((entry) => entry.requested), [second]);
});

test("structured stems keep internal spaces and never choose a shorter matching filename", () => {
  const long = "角色图_001_陈凡 现代装";
  const short = "角色图_001_陈凡";
  const assets = [image(`${long}.png`), image(`${short}.png`)];
  for (const suffix of ["", ".png"]) {
    const plan = planProjectReferences(`【出场人物】${long}${suffix}`, assets);
    assert.deepEqual(plan.matches.map((entry) => entry.asset.name), [`${long}.png`]);
    assert.deepEqual(plan.missing, []);
  }
  const absent = planProjectReferences(`【出场人物】${long}.png`, assets.slice(1));
  assert.deepEqual(absent.matches, []);
  assert.deepEqual(absent.missing.map((entry) => entry.requested), [`${long}.png`]);
  const first = "场景图_001_酒店 原状";
  const second = "场景图_002_酒店 开门版";
  const prompt = `【出场场景】${first} →06使用${second} （同一空间）`;
  const plan = planProjectReferences(prompt, [image(`${first}.png`), image(`${second}.png`)]);
  assert.deepEqual(plan.matches.map((entry) => entry.requested), [first, second]);
  assert.equal(plan.annotatedPrompt.replace(/@场景图_[^=]+=/g, ""), prompt);
});

test("actor-led blocking and exclusion sentences are preserved instead of treated as image names", () => {
  const notes = [
    "陈凡与黄毛从首帧起均在监室内部，始终在场；两名警察与苏清寒只在07末段进入栏外通道、08明确入画，此前不生成在室内的分身。红姐与两壮汉留在酒店，不进入本组场景。",
    "林遥与船员自首镜开始处于船舱内部；保安只在05后段进入甲板、06实际入画，此前不要生成重复人物。其他人待在码头，不入画。",
    "甲与乙位于大厅，丙留在走廊；此时禁止添加其他人物。",
  ];
  for (const note of notes) {
    const prompt = `【出场人物】\n${note}`;
    const plan = planProjectReferences(prompt, []);
    assert.deepEqual(plan.missing, [], note);
    assert.equal(plan.annotatedPrompt, prompt);
    assert.deepEqual(imageReferenceIssues(prompt, [], []), []);
  }
});

test("blocking notes ignore bare names without suppressing structured images or native references", () => {
  for (const separator of ["；", ";", "。", "\n"]) {
    const prompt = `【出场人物】林遥留在船舱${separator}小明`;
    assert.deepEqual(planProjectReferences(prompt, []).missing, []);
  }
  for (const prompt of [
    "【出场人物】林遥留在船舱，角色图_099_缺少人物.png",
    "【出场人物】角色图_099_留在船舱版.png",
    "【出场人物】@角色图_099_未连接=角色图_099_未连接.png，不进入本组场景。",
  ]) {
    assert.ok(imageReferenceIssues(prompt, [], []).some((name) => name.includes(".png")), prompt);
  }
  assert.deepEqual(imageReferenceIssues("【出场人物】林遥留在船舱，@Image99", [], []), ["@Image99"]);
  assert.deepEqual(imageReferenceIssues("【出场人物】林遥留在船舱，角色图_099_缺少人物", [], []), ["角色图_099_缺少人物"]);
  assert.deepEqual(imageReferenceIssues("【出场人物】０９９＿位于船舱版", [], []), []);
});

test("inline scene annotations match exact tokens embedded after arbitrary text", () => {
  const first = "场景图_001_室内.png";
  const second = "场景图_002_室外.png";
  const prompt = `【出场场景】备用${first}→06使用${first}→08使用${second}`;
  const plan = planProjectReferences(prompt, [image(first), image(second)]);
  assert.equal(plan.annotatedPrompt, `【出场场景】备用@场景图_001_室内=${first}→06使用@场景图_001_室内=${first}→08使用@场景图_002_室外=${second}`);
  assert.deepEqual(plan.missing, []);
});

test("audio-only matching annotates voices without touching people or scene references", () => {
  const prompt = "【出场人物】\n001_林晓\n【出场场景】\n101_客厅\n【角色声线】【配音指令】\n（声音2）林晓｜平静";
  const result = planProjectAudioReferences(prompt, [
    image("001_林晓.png"),
    image("101_客厅.png"),
    audio("声音2.wav"),
  ]);

  assert.deepEqual(result.matches.map((match) => match.asset.key), ["audio:声音2.wav"]);
  assert.match(result.annotatedPrompt, /（@声音2=声音2）林晓/);
  assert.match(result.annotatedPrompt, /【出场人物】\n001_林晓/);
  assert.match(result.annotatedPrompt, /【出场场景】\n101_客厅/);
  assert.doesNotMatch(result.annotatedPrompt, /@001_林晓=|@101_客厅=/);
});

function numberedName(prefix, number, label) {
  return `${prefix}_${String(number).padStart(3, "0")}_${label}`;
}

test("cleans spaces, hidden newlines, full-width digits, and full-width underscores", () => {
  assert.equal(cleanMatchValue(" \r０１１＿人物１\n "), "011_人物1");
});

test("matches the new people and scene section headings", () => {
  const prompt = [
    "【出场人物】",
    "角色图_001_林晓（站在门口）",
    "【出场场景】",
    "场景图_101_医院走廊（冷色灯光）",
  ].join("\n");
  const result = planProjectReferences(prompt, [
    image("角色图_001_林晓.png"),
    image("场景图_101_医院走廊.jpg"),
  ]);

  assert.equal(result.matches.length, 2);
  assert.equal(result.missing.length, 0);
  assert.equal(result.annotatedPrompt, prompt.replace("角色图_001_林晓", "@角色图_001_林晓=角色图_001_林晓").replace("场景图_101_医院走廊", "@场景图_101_医院走廊=场景图_101_医院走廊"));
});

test("stops inline sections at the next heading and matches the scene", () => {
  const prompt = "【出场人物】：角色图_003_王丽华、角色图_005_老马【出场场景】：场景图_022_业主反馈会议室四视角【本组首镜姿态继承】：王丽华开口";
  const assets = [
    image("角色图_003_王丽华.png"),
    image("角色图_005_老马.png"),
    image("场景图_022_业主反馈会议室四视角.png"),
  ];
  const plan = planProjectReferences(prompt, assets);
  assert.equal(plan.matches.length, 3);
  assert.match(plan.annotatedPrompt, /@场景图_022_业主反馈会议室四视角=场景图_022_业主反馈会议室四视角【本组首镜姿态继承】/);
});

test("matches the first batch person after a Chinese heading colon when later people are already annotated", () => {
  const prompts = [
    "【出场人物】：角色图_003_王丽华、@角色图_004_刘姐=角色图_004_刘姐，、@角色图_005_老马=角色图_005_老马，【出场场景】：场景图_022_业主反馈会议室四视角",
    "【出场人物】：角色图_003_王丽华、@角色图_004_刘姐=角色图_004_刘姐，、@角色图_006_小陈=角色图_006_小陈，【出场场景】：场景图_022_业主反馈会议室四视角",
    "【出场人物】：角色图_003_王丽华、@角色图_006_小陈=角色图_006_小陈，、@角色图_001_张桂芳正常=角色图_001_张桂芳正常，【出场场景】：场景图_022_业主反馈会议室四视角",
  ];
  const assets = [
    image("角色图_001_张桂芳正常.png"),
    image("角色图_003_王丽华.png"),
    image("角色图_004_刘姐.png"),
    image("角色图_005_老马.png"),
    image("角色图_006_小陈.png"),
    image("场景图_022_业主反馈会议室四视角.png"),
  ];
  for (const prompt of prompts) {
    const plan = planProjectReferences(prompt, assets);
    assert.match(plan.annotatedPrompt, /@角色图_003_王丽华=角色图_003_王丽华/);
    assert.ok(plan.matches.some((match) => match.asset.key === "image:角色图_003_王丽华.png"));
  }
});

test("reclaims old Image and Audio tags from a reused single prompt", () => {
  const prompt = "【出场人物】：@Image3 =角色图_003_王丽华、角色图_005_老马【出场场景】：场景图_022_业主反馈会议室四视角\n🎤（@Audio1 =声音2）台词";
  const assets = [
    image("角色图_003_王丽华.png"),
    image("角色图_005_老马.png"),
    image("场景图_022_业主反馈会议室四视角.png"),
    audio("声音2.wav"),
  ];
  const plan = planProjectReferences(prompt, assets);
  assert.match(plan.annotatedPrompt, /@角色图_003_王丽华=角色图_003_王丽华/);
  assert.match(plan.annotatedPrompt, /@声音2=声音2/);
  assert.equal(new Set(plan.matches.map((match) => match.asset.key)).size, 4);
});

test("matches unique parenthesized voices when a single prompt has no voice section", () => {
  const prompt = "第一句 🎤（声音2）王丽华说话。第二句（声音5）老马说话。第三句（声音2）王丽华继续说话。";
  const plan = planProjectReferences(prompt, [audio("声音2.wav"), audio("声音5.wav")]);
  assert.equal(plan.matches.length, 2);
  assert.match(plan.annotatedPrompt, /（@声音2=声音2）/);
  assert.match(plan.annotatedPrompt, /（@声音5=声音5）/);
  assert.equal((plan.annotatedPrompt.match(/@声音2=/g) || []).length, 1);
});

test("matches voices under adjacent role voice and dubbing instruction headings", () => {
  const prompt = [
    "【角色声线】【配音指令】",
    "林晓【声音1】：清亮、语速平稳。",
    "顾远【声音2】：低沉、略带沙哑。",
    "【出场人物】",
    "001_林晓",
  ].join("\n");
  const result = planProjectReferences(prompt, [audio("林晓.wav"), audio("顾远.mp3"), image("001_林晓.png")]);

  assert.equal(result.matches.filter((item) => item.role === "voice").length, 2);
  assert.equal(result.missing.length, 0);
  assert.match(result.annotatedPrompt, /【角色声线】【配音指令】\n@林晓=林晓【声音1】/);
  assert.match(result.annotatedPrompt, /\n@顾远=顾远【声音2】/);
});

test("matches numbered audio files from leading parenthesized voice labels", () => {
  const prompt = [
    "【角色声线】【配音指令】：",
    "（声音1）张桂芳｜角色图_002_张桂芳油污版｜克制、平静、边界明确｜平均3.4-3.8字/秒。",
    "（声音2）王丽华｜角色图_003_王丽华｜尖刻、理所当然、控制欲强｜平均4.1字/秒。",
    "（声音3）一楼目击业主｜本组无新对白，保持上一组声线锁定。",
  ].join("\n");
  const result = planProjectReferences(prompt, [
    audio("声音1.wav"),
    audio("声音2.wav"),
    audio("声音3.wav"),
  ]);

  assert.deepEqual(result.matches.map((item) => item.requested), ["声音1", "声音2", "声音3"]);
  assert.equal(result.missing.length, 0);
  assert.match(result.annotatedPrompt, /（@声音1=声音1）张桂芳/);
  assert.match(result.annotatedPrompt, /（@声音2=声音2）王丽华/);
  assert.match(result.annotatedPrompt, /（@声音3=声音3）一楼目击业主/);
});

test("matches numbered audio files from voice assignment lines", () => {
  const prompt = [
    "【角色声线】【配音指令】：",
    "声音1=张桂芳，继续平稳讲事实。",
    "声音2=王丽华，音量骤然拔高。",
    "【出场人物】：",
    "角色图_002_张桂芳油污版",
  ].join("\n");
  const result = planProjectReferences(prompt, [audio("声音1.wav"), audio("声音2.wav"), image("角色图_002_张桂芳油污版.png")]);

  assert.deepEqual(result.matches.filter((item) => item.role === "voice").map((item) => item.requested), ["声音1", "声音2"]);
  assert.equal(result.missing.length, 0);
});

test("matches bare voice numbers beside character names in single and batch matching", () => {
  const prompt = "【角色声线】：知禾3清亮稳静；春桃4清脆急快；姚8、柳12、阿棠13本节沉默且前半在场。";
  const assets = [3, 4, 8, 12, 13].map((number) => audio(`声音${number}.wav`));
  for (const plan of [planProjectReferences(prompt, assets), planProjectAudioReferences(prompt, assets)]) {
    assert.deepEqual(plan.matches.map((match) => match.asset.file.name), ["声音3.wav", "声音4.wav"]);
    assert.match(plan.annotatedPrompt, /知禾@声音3=声音3清亮稳静/);
    assert.match(plan.annotatedPrompt, /春桃@声音4=声音4清脆急快/);
    assert.doesNotMatch(plan.annotatedPrompt, /@声音(?:8|12|13)=/);
    assert.deepEqual(plan.missing, []);
    assert.equal(planProjectReferences(plan.annotatedPrompt, assets).annotatedPrompt, plan.annotatedPrompt);
  }
});

test("does not treat numeric voice instructions as numbered assets", () => {
  const prompt = "【角色声线】：平均3.4字/秒；时长15秒；第5节；知禾3清亮。";
  const plan = planProjectReferences(prompt, [audio("声音3.wav"), audio("声音5.wav"), audio("声音15.wav")]);
  assert.deepEqual(plan.matches.map((match) => match.requested), ["声音3"]);
});

test("matches every inline assignment in the compact voice lock heading", () => {
  const prompt = [
    "【声音锁定】：张桂芳=声音1 王丽华=声音2",
    "（（no srt, no BGM））",
    "[0.0-3.5秒] 🎤（声音2）台词内容",
  ].join("\n");
  const result = planProjectReferences(prompt, [audio("声音1.wav"), audio("声音2.wav")]);
  assert.deepEqual(result.matches.map((item) => item.requested), ["声音1", "声音2"]);
  assert.match(result.annotatedPrompt, /张桂芳=@声音1=声音1 王丽华=@声音2=声音2/);
  assert.match(result.annotatedPrompt, /\n\[0\.0-3\.5秒\] 🎤（声音2）台词内容$/);
  assert.equal(result.missing.length, 0);
});

test("matches compact numbered voices under the numbered voice lock heading", () => {
  const prompt = [
    "【声音编号锁定】：声音1张桂芳 / 声音5老马 / 声音6小陈",
    "[0.0-1.1秒] 🎤（声音5）台词内容",
  ].join("\n");
  const result = planProjectReferences(prompt, [audio("声音1.wav"), audio("声音5.wav"), audio("声音6.wav")]);
  assert.deepEqual(result.matches.map((item) => item.requested), ["声音1", "声音5", "声音6"]);
  assert.equal(result.missing.length, 0);
});

test("matches a complete filename exactly before extension fallback", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n角色图_011_人物1.jpg",
    [image("角色图_011_人物1.jpg")],
  );

  assert.equal(plan.matches.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n@角色图_011_人物1=角色图_011_人物1.jpg");
});

test("matches exactly after removing only the asset extension", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n角色图_011_人物1",
    [image("角色图_011_人物1.jpg")],
  );

  assert.equal(plan.matches.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n@角色图_011_人物1=角色图_011_人物1");
});

test("preserves parenthesized descriptions after real people and scene asset names", () => {
  const prompt = [
    "【本节出场的所有人物】",
    "角色图_001_孙桂兰冬季采药版（雪夜站雪防寒服，托扶重伤的陈卫东）",
    "角色图_009_靠山村村民群体（手持登记表、手电和猎叉，堵住下山路）",
    "角色图_011_何志勇（站在伤员与村民之间维持隔离）",
    "【本节的所有背景】",
    "场景图_015_三号瞭望屋围堵雪夜版（木屋门前与南侧下山路被村民围堵的雪夜状态）",
  ].join("\n");
  const result = planProjectReferences(prompt, [
    image("角色图_001_孙桂兰冬季采药版.png"),
    image("角色图_009_靠山村村民群体.png"),
    image("角色图_011_何志勇.png"),
    image("场景图_015_三号瞭望屋围堵雪夜版.png"),
  ]);

  assert.deepEqual(result.matches.map((item) => item.requested), [
    "角色图_001_孙桂兰冬季采药版",
    "角色图_009_靠山村村民群体",
    "角色图_011_何志勇",
    "场景图_015_三号瞭望屋围堵雪夜版",
  ]);
  assert.equal(result.missing.length, 0);
  assert.match(
    result.annotatedPrompt,
    /@角色图_001_孙桂兰冬季采药版=角色图_001_孙桂兰冬季采药版（雪夜站雪防寒服，托扶重伤的陈卫东）\n/,
  );
  assert.match(
    result.annotatedPrompt,
    /@场景图_015_三号瞭望屋围堵雪夜版=场景图_015_三号瞭望屋围堵雪夜版（木屋门前与南侧下山路被村民围堵的雪夜状态）$/,
  );
  assert.equal(result.annotatedPrompt.replace(/@(?:角色图|场景图)_[^=\n]+=/g, ""), prompt);
});

test("does not report background narrative as a missing image", () => {
  const prompt = [
    "【本节的所有背景】",
    "场景图_015_三号瞭望屋围堵雪夜版（木屋门前与南侧下山路被村民围堵的雪夜状态）",
    "深夜，承接陈卫东说‘娘，由孙桂兰托扶，村民堵住下山路，何志勇隔在双方中间。",
    "【本节光影基准】",
    "冷蓝色雪夜环境光。",
  ].join("\n");
  const result = planProjectReferences(prompt, [image("场景图_015_三号瞭望屋围堵雪夜版.png")]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.missing.length, 0);
  assert.match(result.annotatedPrompt, /@场景图_015_三号瞭望屋围堵雪夜版=场景图_015_三号瞭望屋围堵雪夜版（木屋门前与南侧下山路被村民围堵的雪夜状态）\n深夜/);
});

test("preserves previously annotated people commas and old scene descriptions", () => {
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
  assert.equal(result.annotatedPrompt, prompt);
  assert.match(result.annotatedPrompt, /（托扶陈卫东）\n/);
  assert.match(result.annotatedPrompt, /（维持隔离），\n/);
  assert.match(result.annotatedPrompt, /@015_三号瞭望屋围堵雪夜版=015_三号瞭望屋围堵雪夜版（雪夜状态）$/);
});

test("keeps the numeric prefix and normalizes full-width match characters", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n角色图＿０１１＿人物１",
    [image("角色图_011_人物1.png")],
  );

  assert.equal(plan.matches.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n@角色图_011_人物1=角色图_011_人物1");
});

test("does not match shortened or similar structured names", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n角色图_011_人物正面",
    [image("角色图_011_人物背面.jpg"), image("角色图_011_人物正面特写.jpg")],
  );

  assert.equal(plan.matches.length, 0);
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n角色图_011_人物正面");
});

test("does not choose between duplicate extensionless filenames", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n角色图_011_人物1",
    [image("角色图_011_人物1.jpg"), image("角色图_011_人物1.png")],
  );

  assert.equal(plan.matches.length, 0);
  assert.equal(plan.missing.length, 1);
});

test("matches every scene listed on separate background lines", () => {
  const plan = planProjectReferences(
    [
      "【本节的所有背景】",
      "场景图_013_三号防火瞭望屋外雪夜",
      "场景图_014_三号防火瞭望屋内困守版",
      "【本节背景说明】",
      "后续说明不属于场景名称。",
    ].join("\n"),
    [
      image("场景图_013_三号防火瞭望屋外雪夜.jpg"),
      image("场景图_014_三号防火瞭望屋内困守版.png"),
    ],
  );

  assert.equal(plan.matches.length, 2);
  assert.equal(
    plan.annotatedPrompt,
    [
      "【本节的所有背景】",
      "@场景图_013_三号防火瞭望屋外雪夜=场景图_013_三号防火瞭望屋外雪夜",
      "@场景图_014_三号防火瞭望屋内困守版=场景图_014_三号防火瞭望屋内困守版",
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
    "角色图_001_林晓、角色图_002_顾远，角色图_003_旁白",
    "角色图_004_医生;角色图_005_护士；角色图_006_司机",
    "【本节的所有背景】",
    "场景图_011_医院门口",
    "场景图_012_医院走廊、场景图_013_诊室",
  ].join("\n");
  const names = [
    "旁白", "林晓", "顾远", "角色图_001_林晓", "角色图_002_顾远", "角色图_003_旁白",
    "角色图_004_医生", "角色图_005_护士", "角色图_006_司机", "场景图_011_医院门口", "场景图_012_医院走廊", "场景图_013_诊室",
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
  const people = Array.from({ length: 20 }, (_, index) => numberedName("角色图", index + 1, `人物${index + 1}`));
  const scenes = Array.from({ length: 10 }, (_, index) => numberedName("场景图", index + 101, `场景${index + 1}`));
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
    "角色图＿０１１＿人物正面",
    "【本节的所有背景】",
    "场景图＿０２１＿林间空地",
  ].join("\n");
  const result = planProjectReferences(prompt, [
    image("角色图_011_人物正面.jpg"),
    image("场景图＿０２１＿林间空地.png"),
  ]);

  assert.equal(result.matches.length, 2);
  assert.equal(result.missing.length, 0);
  assert.match(result.annotatedPrompt, /@角色图_011_人物正面=角色图_011_人物正面/);
  assert.match(result.annotatedPrompt, /@场景图_021_林间空地=场景图_021_林间空地/);
});

test("keeps exact punctuation and does not collapse distinct directions", () => {
  const prompt = [
    "【本节出场的所有人物】",
    "角色图_011_人物（正面）.jpg、角色图_011_人物（背面）.jpg",
  ].join("\n");
  const result = planProjectReferences(prompt, [
    image("角色图_011_人物（正面）.jpg"),
    image("角色图_011_人物正面.jpg"),
  ]);

  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.missing.map((item) => item.requested), ["角色图_011_人物（背面）.jpg"]);
  assert.match(result.annotatedPrompt, /@角色图_011_人物（正面）=角色图_011_人物（正面）/);
  assert.doesNotMatch(result.annotatedPrompt, /@角色图_011_人物正面=角色图_011_人物（背面）/);
});

test("annotates exact matches while leaving only missing entries unchanged", () => {
  const prompt = [
    "【本节的所有背景】",
    "场景图_101_场景1",
    "场景图_102_场景2",
    "场景图_103_场景3",
  ].join("\n");
  const result = planProjectReferences(prompt, [image("场景图_101_场景1.jpg"), image("场景图_103_场景3.jpg")]);

  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.missing.map((item) => item.requested), ["场景图_102_场景2"]);
  assert.match(result.annotatedPrompt, /@场景图_101_场景1=场景图_101_场景1/);
  assert.match(result.annotatedPrompt, /\n场景图_102_场景2\n/);
  assert.match(result.annotatedPrompt, /@场景图_103_场景3=场景图_103_场景3/);
});

test("matches character and scene filenames followed by sentence punctuation", () => {
  const prompt = [
    "【出场人物】：@角色图_004_沈明珠闺装版=角色图_004_沈明珠闺装版.png，、角色图_009_王福.png。",
    "【出场场景】：场景图_014_沈府侧门外巷四视角.png。",
  ].join("\n");
  const assets = [
    image("角色图_004_沈明珠闺装版.png"),
    image("角色图_009_王福.png"),
    image("场景图_014_沈府侧门外巷四视角.png"),
  ];
  const result = planProjectReferences(prompt, assets);
  assert.deepEqual(result.matches.map((match) => match.asset.file.name), assets.map((asset) => asset.file.name));
  assert.deepEqual(result.missing, []);
  assert.match(result.annotatedPrompt, /@角色图_009_王福=角色图_009_王福\.png/);
  assert.match(result.annotatedPrompt, /@场景图_014_沈府侧门外巷四视角=场景图_014_沈府侧门外巷四视角\.png/);
  assert.doesNotMatch(result.annotatedPrompt, /png。，，/);
  assert.equal(planProjectReferences(result.annotatedPrompt, assets).annotatedPrompt, result.annotatedPrompt);
});

test("matches SD2.5 batch cast entries with a parenthesized role and trailing full stop", () => {
  const prompt = [
    "【出场人物】：角色图_004_沈明珠闺装版.png（沈明珠）、角色图_017_许映荷.png（许映荷）。",
    "【出场场景】：场景图_015_许家米行后院四视角.png（米行后院）。",
  ].join("\n");
  const assets = [
    image("角色图_004_沈明珠闺装版.png"),
    image("角色图_017_许映荷.png"),
    image("场景图_015_许家米行后院四视角.png"),
  ];
  const result = planProjectReferences(prompt, assets);
  assert.deepEqual(result.matches.map((match) => match.asset.file.name), assets.map((asset) => asset.file.name));
  assert.deepEqual(result.missing, []);
  const partiallyMatched = prompt.replace(
    "角色图_004_沈明珠闺装版.png（沈明珠）",
    "@角色图_004_沈明珠闺装版=角色图_004_沈明珠闺装版.png（沈明珠）",
  );
  const retry = planProjectReferences(partiallyMatched, assets);
  assert.equal(retry.matches.some((match) => match.asset.file.name === "角色图_017_许映荷.png"), true);
  assert.deepEqual(retry.missing, []);
});

test("reports a missing named character and scene after stripping sentence punctuation", () => {
  const prompt = "【出场人物】：角色图_011_沈父.png。\n【出场场景】：场景图_009_沈府明珠卧房四视角.png。";
  const result = planProjectReferences(prompt, []);
  assert.deepEqual(result.missing.map((item) => item.requested), [
    "角色图_011_沈父.png",
    "场景图_009_沈府明珠卧房四视角.png",
  ]);
});

test("ignores ordinary scene filenames without the structured prefix and number", () => {
  const prompt = "【出场场景】：码头夜景.png。";
  const result = planProjectReferences(prompt, [image("码头夜景.png")]);
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.missing, []);
  assert.equal(result.annotatedPrompt, prompt);
});

test("checks that every matched image is actually attached before submission", () => {
  const prompt = "【出场人物】：角色图_001_阿青.png、角色图_002_阿明.png。";
  const assets = [image("角色图_001_阿青.png"), image("角色图_002_阿明.png")];
  assert.deepEqual(imageReferenceIssues(prompt, assets, [{ projectAssetKey: assets[0].key, name: assets[0].name }]), ["角色图_002_阿明.png"]);
  assert.deepEqual(imageReferenceIssues(prompt, assets, assets.map((asset) => ({ projectAssetKey: asset.key, name: asset.name }))), []);
});

test("does not hide an unmatched image when a batch item was previously matched", () => {
  const prompt = "【出场人物】：角色图_001_阿青.png、角色图_002_阿明.png。";
  const assets = [image("角色图_001_阿青.png")];
  assert.deepEqual(imageReferenceIssues(prompt, assets, [{ projectAssetKey: assets[0].key, name: assets[0].name }]), ["角色图_002_阿明.png"]);
});

test("accepts a manually attached image with the exact requested filename", () => {
  assert.deepEqual(
    imageReferenceIssues("【出场人物】：角色图_001_阿青.png。", [], [{ kind: "image", name: "角色图_001_阿青.png" }]),
    [],
  );
});

test("recognizes connected numbered images in cast entries without mistaking their tags for filenames", () => {
  const references = [{ id: "manual-image", kind: "image", name: "角色.png", tag: "@Image1" }];
  for (const label of ["Image", "image", "IMAGE", "图", "图片"]) {
    for (const suffix of ["", " 是小明", "=小明", " 角色.png", "=角色.png"]) {
      assert.deepEqual(imageReferenceIssues(`【出场人物】@${label}1${suffix}`, [], references), [], `${label}${suffix}`);
    }
  }
});

test("numbered image validation does not accept unconnected, malformed or non-image references", () => {
  const references = [
    { id: "manual-image", kind: "image", name: "角色.png", tag: "@Image1" },
    { id: "manual-audio", kind: "audio", name: "声音.wav", tag: "@Audio2" },
  ];
  for (const tag of ["@Image99", "@image10", "@图2", "@图片2", "@Image0", "@Image01", "@Image1角色"]) {
    assert.deepEqual(imageReferenceIssues(`【出场人物】${tag}`, [], references), [tag]);
  }
});

test("a connected image number ignores bare prose without hiding explicit missing structured images", () => {
  const references = [{ id: "manual-image", kind: "image", name: "角色.png", tag: "@Image1" }];
  assert.deepEqual(imageReferenceIssues("【出场人物】@Image1、另一人物", [], references), []);
  assert.deepEqual(imageReferenceIssues("【出场人物】@Image1、角色图_002_缺失.png", [], references), ["角色图_002_缺失.png"]);
  for (const prompt of ["【出场人物】@Image1 角色图_002_缺失.png", "【出场人物】@图1 角色图_002_缺失.png"]) {
    assert.ok(imageReferenceIssues(prompt, [], references).some((name) => name.includes("未连接.png") || name.includes("角色图_002_缺失.png")), prompt);
  }
  assert.deepEqual(imageReferenceIssues("【出场人物】@Image1 未连接.png", [], references), []);
  // 明确的“编号=文件名”由已连接编号决定素材，不再保留冲突的旧文件名。
  assert.deepEqual(imageReferenceIssues("【出场人物】@Image1=未连接.png", [], references), []);
});

test("flags explicit role and scene filenames even under an unfamiliar section heading", () => {
  const prompt = "【画面素材】角色图_001_阿青.png、场景图_002_码头.png";
  const references = [{ kind: "image", name: "角色图_001_阿青.png" }];
  assert.deepEqual(imageReferenceIssues(prompt, [], references), ["场景图_002_码头.png"]);
});

test("is idempotent when the same prompt is planned repeatedly", () => {
  const prompt = [
    "【本段角色声线锁定】",
    "林晓【声音1】：清亮",
    "【本节出场的所有人物】",
    "角色图_011_林晓",
    "【本节的所有背景】",
    "场景图_021_客厅",
  ].join("\n");
  const assets = [audio("林晓.mp3"), image("角色图_011_林晓.jpg"), image("场景图_021_客厅.png")];
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
