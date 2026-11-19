import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  capabilityFor,
  capabilityLimitIssue,
  migrateSavedProfile,
  modelForSdVersion,
  preferredDurationForVersion,
  profilesWithBuiltIns,
  sdVersionForModel,
  sdVersionForProfile,
} from "../src/providerCatalog.js";

const profile = { id: "viralee", adapter: "viralee", baseUrl: "https://api.viralee.top", model: "viraldance2.5-30" };
const models = ["viraldance933", "viraldance933-fast", profile.model];

test("ViralE 2.5 family is recognized without reclassifying existing 2.0 models", () => {
  for (const model of ["viraldance2.5-30", "VIRALDANCE2.5-30", "viraldance-2.5-15", "viraldance2.5"]) {
    assert.equal(sdVersionForModel(model), "sd25", model);
    assert.equal(sdVersionForProfile({ ...profile, model }), "sd25", model);
  }
  for (const model of ["viraldance", "viraldance-fast", "viraldance900", "viraldance921", "viraldance933", "viraldance933-fast", "viraldance2.50-30"]) {
    assert.equal(sdVersionForProfile({ ...profile, model }), "sd20", model);
  }
});

test("ViralE live list can select SD2.5 and retains the exact selected model across restart", () => {
  const old = { ...profile, model: "viraldance933" };
  assert.equal(modelForSdVersion(old, "sd25", models), profile.model);
  assert.equal(modelForSdVersion(profile, "sd25", models), profile.model);
  assert.equal(modelForSdVersion(profile, "sd25"), profile.model);
  assert.equal(modelForSdVersion(profile, "sd25", []), "");
  assert.equal(modelForSdVersion(profile, "sd20", models), "viraldance933");
  const saved = JSON.parse(JSON.stringify(profile));
  assert.equal(migrateSavedProfile(saved).model, profile.model);
  assert.equal(profilesWithBuiltIns([saved]).find((item) => item.id === profile.id).model, profile.model);
});

test("ViralE viraldance2.5-30 uses fixed thirty seconds and thirty/ten/ten references", () => {
  const cap = capabilityFor(profile);
  assert.notEqual(cap._capabilityUnverified, true);
  assert.deepEqual(cap.durations, [30]);
  assert.deepEqual([cap.images, cap.videos, cap.audios], [30, 10, 10]);
  assert.deepEqual(cap.resolutions, ["720p"]);
  assert.deepEqual(cap.ratios, ["16:9", "9:16", "1:1", "4:3"]);
  assert.equal(cap.syncAudioFixed, true);
  assert.equal(preferredDurationForVersion(cap, "sd25"), 30);
  const references = (images, videos = 0, audios = 0) => [
    ...Array.from({ length: images }, () => ({ kind: "image" })),
    ...Array.from({ length: videos }, () => ({ kind: "video" })),
    ...Array.from({ length: audios }, () => ({ kind: "audio" })),
  ];
  assert.equal(capabilityLimitIssue(profile, references(30, 10, 10), 30), "");
  assert.equal(capabilityLimitIssue(profile, references(10, 4, 4), 30), "");
  assert.match(capabilityLimitIssue(profile, references(9), 15), /不支持 15 秒/);
  assert.match(capabilityLimitIssue(profile, references(31), 30), /图片参考最多 30 个/);
  assert.match(capabilityLimitIssue(profile, references(1, 11), 30), /视频参考最多 10 个/);
  assert.match(capabilityLimitIssue(profile, references(1, 0, 11), 30), /音频参考最多 10 个/);
});

test("ViralE server validation accepts thirty/ten/ten and rejects each exceeded limit", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const source = server.slice(server.indexOf("function validateProviderLimits("), server.indexOf("function cleanupFiles("));
  const ctx = vm.createContext({
    capabilityLimitIssue,
    httpError: (status, message) => Object.assign(new Error(message), { status }),
  });
  vm.runInContext(source, ctx);
  const references = (images, videos, audios) => [
    ...Array.from({ length: images }, () => ({ kind: "image" })),
    ...Array.from({ length: videos }, () => ({ kind: "video" })),
    ...Array.from({ length: audios }, () => ({ kind: "audio" })),
  ];
  assert.doesNotThrow(() => ctx.validateProviderLimits(profile, references(30, 10, 10), 30));
  for (const [counts, message] of [
    [[31, 10, 10], /图片参考最多 30 个/],
    [[30, 11, 10], /视频参考最多 10 个/],
    [[30, 10, 11], /音频参考最多 10 个/],
  ]) {
    assert.throws(() => ctx.validateProviderLimits(profile, references(...counts), 30), (error) => error.status === 400 && message.test(error.message));
  }
});

test("ViralE 933 and 933-fast retain their original 2.0 capabilities", () => {
  for (const model of ["viraldance933", "viraldance933-fast"]) {
    const cap = capabilityFor({ ...profile, model });
    assert.notEqual(cap._capabilityUnverified, true);
    assert.deepEqual(cap.durations, Array.from({ length: 12 }, (_, index) => index + 4));
    assert.deepEqual([cap.images, cap.videos, cap.audios], [9, 3, 3]);
    assert.deepEqual(cap.resolutions, ["720p"]);
  }
});

test("the supplied ViralE 933 protocol still submits every reference under its documented fields", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const source = server.slice(server.indexOf("function viraleePayload("), server.indexOf("function genericPayload("));
  const ctx = vm.createContext({});
  vm.runInContext(source, ctx);
  for (const model of ["viraldance933", "viraldance933-fast"]) {
    const payload = ctx.viraleePayload({ model }, { prompt: "参考 @Image1 @Video1 @Audio1", duration: 10, aspectRatio: "16:9", resolution: "720p", syncAudio: false,
      materials: [{ kind: "image", url: "https://example.com/i.png" }, { kind: "video", url: "https://example.com/v.mp4" }, { kind: "audio", url: "https://example.com/a.wav" }] });
    assert.equal(payload.model, model);
    assert.equal(payload.ratio, "16:9");
    assert.equal(payload.duration, 10);
    assert.equal(payload.resolution, "720p");
    assert.equal(payload.generate_audio, true);
    assert.deepEqual(Array.from(payload.image_urls), ["https://example.com/i.png"]);
    assert.deepEqual(Array.from(payload.video_urls), ["https://example.com/v.mp4"]);
    assert.deepEqual(Array.from(payload.audio_urls), ["https://example.com/a.wav"]);
    assert.equal(payload.aspect_ratio, undefined);
  }
});

test("ViralE viraldance2.5-30 sends the shared 933 protocol without renaming the model", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const source = server.slice(server.indexOf("function viraleePayload("), server.indexOf("function genericPayload("));
  const ctx = vm.createContext({});
  vm.runInContext(source, ctx);
  for (const syncAudio of [undefined, false, true]) {
    const payload = ctx.viraleePayload(profile, {
      prompt: "参考 @Image1 @Video1 @Audio1", duration: 30, aspectRatio: "9:16", resolution: "720p", syncAudio,
      materials: [
        { kind: "image", url: "https://example.com/i1.png" },
        { kind: "audio", url: "https://example.com/a.wav" },
        { kind: "video", url: "https://example.com/v.mp4" },
        { kind: "image", url: "https://example.com/i2.png" },
      ],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
      model: profile.model,
      prompt: "参考 @Image1 @Video1 @Audio1",
      duration: 30,
      ratio: "9:16",
      resolution: "720p",
      generate_audio: true,
      image_urls: ["https://example.com/i1.png", "https://example.com/i2.png"],
      video_urls: ["https://example.com/v.mp4"],
      audio_urls: ["https://example.com/a.wav"],
    });
  }
});

test("ViralE viraldance2.5-30 payload preserves all fifty references in type order", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const source = server.slice(server.indexOf("function viraleePayload("), server.indexOf("function genericPayload("));
  const ctx = vm.createContext({});
  vm.runInContext(source, ctx);
  const materials = Array.from({ length: 30 }, (_, index) => [
    { kind: "image", url: `https://example.com/i${index + 1}.png` },
    ...(index < 10 ? [
      { kind: "video", url: `https://example.com/v${index + 1}.mp4` },
      { kind: "audio", url: `https://example.com/a${index + 1}.wav` },
    ] : []),
  ]).flat();
  const payload = ctx.viraleePayload(profile, { prompt: "全部参考", duration: 30, aspectRatio: "16:9", materials });
  assert.equal(payload.model, profile.model);
  for (const [kind, field] of [["image", "image_urls"], ["video", "video_urls"], ["audio", "audio_urls"]]) {
    assert.deepEqual(Array.from(payload[field]), materials.filter((item) => item.kind === kind).map((item) => item.url));
  }
  assert.equal(payload.image_urls.length + payload.video_urls.length + payload.audio_urls.length, 50);
});

test("model switching does not advertise universal SD2.5 reference limits as model facts", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const handler = app.slice(app.indexOf("  function switchSdVersion("), app.indexOf("  function headersFor("));
  assert.doesNotMatch(handler, /SD2\.5（30图/);
  assert.match(handler, /nextCapability\._capabilityUnverified/);
});
