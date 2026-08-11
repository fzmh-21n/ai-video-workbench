import assert from "node:assert/strict";
import test from "node:test";

import {
  MEAICC_VIDEO_MODELS,
  meaiccCapability,
  meaiccLimitIssue,
  meaiccVideoPayload,
} from "../src/meaiccCatalog.js";
import {
  DEFAULT_PROFILES,
  FALLBACK_MODELS,
  capabilityFor,
  inferAdapter,
  migrateSavedProfile,
  pollDelayForAdapter,
  preferredModelForSdVersion,
  sdVersionForModel,
} from "../src/providerCatalog.js";

function materials(images, audios, videos, videoDuration = 0) {
  return [
    ...Array.from({ length: images }, (_, index) => ({
      kind: "image",
      subType: "reference",
      url: `https://example.com/image-${index}.jpg`,
    })),
    ...Array.from({ length: audios }, (_, index) => ({
      kind: "audio",
      url: `https://example.com/audio-${index}.mp3`,
    })),
    ...Array.from({ length: videos }, (_, index) => ({
      kind: "video",
      durationSeconds: videoDuration,
      url: `https://example.com/video-${index}.mp4`,
    })),
  ];
}

test("includes the documented MEAICC relay as a built-in provider", () => {
  const profile = DEFAULT_PROFILES.find((item) => item.id === "meaicc");
  assert.deepEqual(profile, {
    id: "meaicc",
    name: "MEAICC / 林木森AI",
    baseUrl: "https://api.meaicc.com",
    adapter: "meaicc",
    model: "seedance-2.0",
    mediaUploadUrl: "",
  });
  assert.equal(inferAdapter(profile.baseUrl), "meaicc");
  assert.deepEqual(FALLBACK_MODELS.meaicc, ["seedance-2.0"]);
  assert.deepEqual(MEAICC_VIDEO_MODELS, ["seedance-2.0"]);
});

test("exposes the documented MEAICC Seedance 2.0 limits", () => {
  const capability = meaiccCapability();
  assert.deepEqual(
    {
      images: capability.images,
      audios: capability.audios,
      videos: capability.videos,
      durations: capability.durations,
      resolutions: capability.resolutions,
    },
    { images: 9, audios: 3, videos: 3, durations: [10, 15], resolutions: ["720p"] },
  );
  assert.deepEqual(capabilityFor({ adapter: "meaicc", model: "seedance-2.0" }), capability);
});

test("maps MEAICC only to the SD2.0 switch", () => {
  assert.equal(preferredModelForSdVersion("meaicc", "sd20"), "seedance-2.0");
  assert.equal(preferredModelForSdVersion("meaicc", "sd25"), "");
  assert.equal(sdVersionForModel("seedance-2.0"), "sd20");
});

test("keeps every MEAICC status query more than 20 seconds apart", () => {
  assert.ok(pollDelayForAdapter("meaicc") > 20_000);
  assert.equal(pollDelayForAdapter("lwaigc"), 10_000);
});

test("builds the exact nested MEAICC text-to-video payload", () => {
  assert.deepEqual(meaiccVideoPayload("seedance-2.0", {
    prompt: "小猫",
    duration: 15,
    resolution: "720p",
    aspectRatio: "16:9",
    materials: [],
  }), {
    model: "seedance-2.0",
    input: { prompt: "小猫" },
    parameters: { resolution: "720p", ratio: "16:9", duration: 15 },
  });
});

test("serializes a full 9-image, 3-audio, 3-video MEAICC request", () => {
  const fullCapacity = materials(9, 3, 3);
  assert.equal(meaiccLimitIssue("seedance-2.0", fullCapacity, 15), "");
  const payload = meaiccVideoPayload("seedance-2.0", {
    prompt: "满容量参考素材",
    duration: 15,
    resolution: "720p",
    aspectRatio: "9:16",
    materials: fullCapacity,
  });
  assert.equal(payload.input.media.length, 15);
  assert.equal(payload.input.media.filter((item) => item.type === "reference_image").length, 9);
  assert.equal(payload.input.media.filter((item) => item.type === "reference_voice").length, 3);
  assert.equal(payload.input.media.filter((item) => item.type === "reference_video").length, 3);
  assert.deepEqual(payload.parameters, { resolution: "720p", ratio: "9:16", duration: 15 });
});

test("preserves MEAICC first-frame and last-frame media roles", () => {
  const payload = meaiccVideoPayload("seedance-2.0", {
    prompt: "从首帧过渡到尾帧",
    duration: 10,
    resolution: "720p",
    aspectRatio: "16:9",
    materials: [
      { kind: "image", subType: "first_frame", url: "https://example.com/first.jpg" },
      { kind: "image", subType: "last_frame", url: "https://example.com/last.jpg" },
    ],
  });
  assert.deepEqual(payload.input.media, [
    { type: "first_frame", url: "https://example.com/first.jpg" },
    { type: "last_frame", url: "https://example.com/last.jpg" },
  ]);
});

test("rejects every MEAICC one-over-capacity boundary", () => {
  assert.match(meaiccLimitIssue("seedance-2.0", materials(10, 3, 3), 15), /图片参考最多 9 个/);
  assert.match(meaiccLimitIssue("seedance-2.0", materials(9, 4, 3), 15), /音频参考最多 3 个/);
  assert.match(meaiccLimitIssue("seedance-2.0", materials(9, 3, 4), 15), /视频参考最多 3 个/);
});

test("enforces the documented 25-second input-plus-output video boundary", () => {
  assert.equal(meaiccLimitIssue("seedance-2.0", materials(0, 0, 1, 10), 15), "");
  assert.match(
    meaiccLimitIssue("seedance-2.0", materials(0, 0, 1, 11), 15),
    /总时长不能超过 25 秒；当前为 26 秒/,
  );
});

test("rejects unsupported MEAICC duration and an empty model", () => {
  assert.match(meaiccLimitIssue("seedance-2.0", [], 16), /不支持 16 秒/);
  assert.equal(meaiccLimitIssue("", [], 10), "请选择 MEAICC 视频模型");
});

test("accepts the exact MEAICC route model selected from the live model list", () => {
  assert.equal(meaiccLimitIssue("sd-2-c5", [], 15), "");
  const payload = meaiccVideoPayload("sd-2-c5", {
    prompt: "线路模型测试",
    duration: 15,
    resolution: "720p",
    aspectRatio: "9:16",
    materials: [],
  });
  assert.equal(payload.model, "sd-2-c5");
  assert.equal(payload.parameters.duration, 15);
  assert.deepEqual(Object.keys(payload).sort(), ["input", "model", "parameters"]);
  assert.equal("duration" in payload, false);
  assert.equal("seconds" in payload, false);
  assert.equal("aspect_ratio" in payload, false);
});

test("repairs an older MEAICC profile with an invalid saved model", () => {
  const migrated = migrateSavedProfile({
    id: "api_old_meaicc",
    name: "林木森AI",
    baseUrl: "https://api.meaicc.com/v1",
    adapter: "newapi",
    model: "",
    mediaUploadUrl: "",
  });
  assert.equal(migrated.adapter, "meaicc");
  assert.equal(migrated.model, "seedance-2.0");
  assert.equal(migrated.baseUrl, "https://api.meaicc.com");
});
