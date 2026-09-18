import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROFILES,
  FALLBACK_MODEL_LABELS,
  FALLBACK_MODELS,
  capabilityFor,
  inferAdapter,
  migrateSavedProfile,
  modelForSdVersion,
} from "../src/providerCatalog.js";
import {
  MAXFORAI_FT_933_MODEL,
  MAXFORAI_VIDEO_MODELS,
  maxforaiModels,
  maxforaiReferencePrompt,
  maxforaiVideoPayload,
} from "../src/maxforaiCatalog.js";

test("includes MaxForAI with its official base URL and video catalog", () => {
  const profile = DEFAULT_PROFILES.find((item) => item.id === "maxforai");
  assert.equal(profile.baseUrl, "https://maxforai.top");
  assert.equal(profile.mediaUploadUrl, "https://maxforai.top/v1/assets");
  assert.equal(inferAdapter(profile.baseUrl), "maxforai");
  assert.deepEqual(FALLBACK_MODELS.maxforai, MAXFORAI_VIDEO_MODELS);
  assert.ok(MAXFORAI_VIDEO_MODELS.includes("wan3.0th"));
  assert.ok(MAXFORAI_VIDEO_MODELS.includes("cc-2.0-933"));
  assert.ok(MAXFORAI_VIDEO_MODELS.includes("特价ft-sd2.0满血"));
});

test("keeps newly returned MaxForAI models instead of filtering them through the built-in catalog", () => {
  const models = maxforaiModels(["FT-Seedance 2.0 720p (933全参）", "wan3.0th"]);
  assert.equal(models[0], "FT-Seedance 2.0 720p (933全参）");
  assert.equal(models.filter((model) => model === "wan3.0th").length, 1);
  assert.equal(FALLBACK_MODEL_LABELS.maxforai["特价ft-sd2.0满血"], "FT-Seedance 2.0 · 720P · 933全参");
  assert.equal(migrateSavedProfile({
    id: "maxforai",
    baseUrl: "https://maxforai.top",
    adapter: "maxforai",
    model: "new-live-model",
  }).model, "new-live-model");
});

test("exposes the exact FT 933 model limits", () => {
  assert.ok(MAXFORAI_VIDEO_MODELS.includes(MAXFORAI_FT_933_MODEL));
  const capability = capabilityFor({ adapter: "maxforai", model: MAXFORAI_FT_933_MODEL });
  assert.deepEqual(capability.durations, Array.from({ length: 12 }, (_, index) => index + 4));
  assert.deepEqual(capability.resolutions, ["720p"]);
  assert.deepEqual(capability.ratios, ["9:16", "16:9", "1:1", "4:3", "3:4"]);
  assert.equal(capability.images, 9);
  assert.equal(capability.videos, 3);
  assert.equal(capability.audios, 3);
});

test("uses the documented MaxForAI wan3.0th request fields", () => {
  const payload = maxforaiVideoPayload("wan3.0th", {
    prompt: "test", duration: 15, aspectRatio: "16:9", resolution: "720p", syncAudio: true,
    materials: [
      { kind: "image", url: "https://example.com/a.png" },
      { kind: "video", url: "https://example.com/a.mp4" },
      { kind: "audio", url: "https://example.com/a.wav" },
    ],
  });
  assert.equal(payload.model, "wan3.0th");
  assert.equal(payload.seconds, "15");
  assert.equal(payload.ratio, "16:9");
  assert.equal(payload.generate_audio, true);
  assert.deepEqual(payload.images, ["https://example.com/a.png"]);
  assert.deepEqual(payload.videos, ["https://example.com/a.mp4"]);
  assert.deepEqual(payload.audios, ["https://example.com/a.wav"]);
  assert.equal("duration" in payload, false);
  assert.equal("aspect_ratio" in payload, false);
  assert.equal("resolution" in payload, false);

  const capability = capabilityFor({ adapter: "maxforai", model: "wan3.0th" });
  assert.equal(capability.images, 10);
  assert.equal(capability.videos, 5);
  assert.equal(capability.audios, 5);
  assert.deepEqual(capability.durations, Array.from({ length: 27 }, (_, index) => index + 4));
});

test("uses the documented MaxForAI cc-2.0-933 request fields", () => {
  const payload = maxforaiVideoPayload("cc-2.0-933", {
    prompt: "test", duration: 15, aspectRatio: "16:9", resolution: "720p", syncAudio: true,
    materials: [{ kind: "image", url: "https://example.com/a.png" }],
  });
  assert.equal(payload.model, "cc-2.0-933");
  assert.equal(payload.seconds, 15);
  assert.equal(payload.ratio, "16:9");
  assert.deepEqual(payload.images, ["https://example.com/a.png"]);
  assert.equal("duration" in payload, false);
  assert.equal("aspect_ratio" in payload, false);
  assert.equal("resolution" in payload, false);

  const capability = capabilityFor({ adapter: "maxforai", model: "cc-2.0-933" });
  assert.equal(capability.images, 9);
  assert.equal(capability.audios, 3);
  assert.equal(capability.videos, 3);
});

test("uses MaxForAI official Seedance parameter names", () => {
  const payload = maxforaiVideoPayload("sd-fast-720p", {
    prompt: "test", duration: 15, aspectRatio: "9:16", resolution: "720p", syncAudio: true,
    materials: [{ kind: "image", url: "https://example.com/a.png" }],
  });
  assert.equal(payload.seconds, "15");
  assert.equal(payload.ratio, "9:16");
  assert.equal(payload.generate_audio, true);
  assert.deepEqual(payload.images, ["https://example.com/a.png"]);
  assert.equal("duration" in payload, false);
});

test("uses MaxForAI unified duration parameter names for Firefly", () => {
  const payload = maxforaiVideoPayload("firefly-seedance2-720p", {
    prompt: "test", duration: 15, aspectRatio: "16:9", resolution: "720p", syncAudio: true,
    materials: [{ kind: "audio", url: "https://example.com/a.wav" }],
  });
  assert.equal(payload.duration, 15);
  assert.equal(payload.ratio, "16:9");
  assert.equal("aspect_ratio" in payload, false);
  assert.equal(payload.generateAudio, true);
  assert.deepEqual(payload.audios, ["https://example.com/a.wav"]);
});

test("uses the unified MaxForAI fields for newly returned models", () => {
  const payload = maxforaiVideoPayload("FT-Seedance 2.0 720p (933全参）", {
    prompt: "test", duration: 15, aspectRatio: "16:9", resolution: "720p", syncAudio: true,
    materials: [
      { kind: "image", url: "https://maxforai.top/v1/assets/image-1" },
      { kind: "audio", url: "https://maxforai.top/v1/assets/audio-1" },
    ],
  });
  assert.equal(payload.duration, 15);
  assert.equal(payload.ratio, "16:9");
  assert.equal(payload.resolution, "720p");
  assert.equal("aspect_ratio" in payload, false);
  assert.deepEqual(payload.images, ["https://maxforai.top/v1/assets/image-1"]);
  assert.deepEqual(payload.audios, ["https://maxforai.top/v1/assets/audio-1"]);
  assert.equal("image_urls" in payload, false);
  assert.equal("audio_urls" in payload, false);
});

test("normalizes MaxForAI named references to the documented numbered references", () => {
  const prompt = maxforaiReferencePrompt(
    "@002_苏晏_基建劳作版在@008_苏晏居住帐篷_四视角说话，声音参考@声音1。",
    [
      { kind: "image", tag: "@Image1", name: "002_苏晏_基建劳作版.png" },
      { kind: "image", tag: "@Image2", name: "008_苏晏居住帐篷_四视角.png" },
      { kind: "audio", tag: "@Audio1", name: "声音1.wav" },
    ],
  );
  assert.match(prompt, /^@image1在@image2说话，声音参考@audio1。/);
  assert.match(prompt, /@image1 是 002_苏晏_基建劳作版/);
  assert.match(prompt, /@image2 是 008_苏晏居住帐篷_四视角/);
  assert.match(prompt, /@audio1 是 声音1/);
  assert.doesNotMatch(prompt, /@002_|@008_|@声音1/);
});

test("exposes SD2.0 and SD2.5 workbench capacities", () => {
  const sd20 = capabilityFor({ adapter: "maxforai", model: "firefly-seedance2-720p" });
  const sd25 = capabilityFor({ adapter: "maxforai", model: "mg-seedance-2.5" });
  assert.equal(sd20.images, 9); assert.equal(sd20.audios, 3); assert.equal(sd20.videos, 3);
  assert.equal(sd25.images, 30); assert.equal(sd25.audios, 10); assert.equal(sd25.videos, 10);
});

test("top model switch selects the documented MaxForAI SD2.5 route", () => {
  const profile = DEFAULT_PROFILES.find((item) => item.id === "maxforai");
  assert.equal(modelForSdVersion(profile, "sd25", MAXFORAI_VIDEO_MODELS), "mg-seedance-2.5");
  assert.equal(modelForSdVersion({ ...profile, model: "mg-seedance-2.5" }, "sd20", MAXFORAI_VIDEO_MODELS), "firefly-seedance2-720p");
});
