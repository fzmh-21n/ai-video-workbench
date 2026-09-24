import assert from "node:assert/strict";
import test from "node:test";

import {
  FMGO_K20_FAST_MODEL,
  FMGO_V25_MODEL,
  fmgoK20FastPayload,
  fmgoV25Capability,
  fmgoV25Payload,
} from "../src/fmgoCatalog.js";
import {
  FALLBACK_MODELS,
  capabilityFor,
  preferredModelForSdVersion,
  sdVersionForModel,
} from "../src/providerCatalog.js";

test("adds FMGO k2.0-fast-720p with its documented limits", () => {
  assert.ok(FALLBACK_MODELS.fmgo.includes(FMGO_K20_FAST_MODEL));
  const capability = capabilityFor({ adapter: "fmgo", model: FMGO_K20_FAST_MODEL });
  assert.deepEqual({
    images: capability.images,
    videos: capability.videos,
    audios: capability.audios,
    durations: capability.durations,
    resolutions: capability.resolutions,
    ratios: capability.ratios,
  }, {
    images: 9,
    videos: 3,
    audios: 3,
    durations: [10, 15],
    resolutions: ["720p"],
    ratios: ["16:9", "9:16", "1:1"],
  });
});

test("builds the exact FMGO k2.0-fast-720p mixed-reference request", () => {
  const payload = fmgoK20FastPayload(FMGO_K20_FAST_MODEL, {
    prompt: "参考人物形象、镜头运动和音乐节奏",
    duration: 15,
    resolution: "720p",
    aspectRatio: "16:9",
    syncAudio: true,
    materials: [
      { kind: "image", subType: "reference", url: "https://example.com/ref.png" },
      { kind: "video", url: "https://example.com/ref.mp4" },
      { kind: "audio", url: "https://example.com/ref.mp3" },
    ],
  });
  assert.deepEqual(payload, {
    model: "k2.0-fast-720p",
    prompt: "参考人物形象、镜头运动和音乐节奏",
    aspect_ratio: "16:9",
    resolution: "720p",
    seconds: "15",
    motion_has_audio: true,
    images: ["https://example.com/ref.png"],
    reference_videos: ["https://example.com/ref.mp4"],
    reference_audios: ["https://example.com/ref.mp3"],
  });
});

test("validates FMGO k2.0-fast-720p duration, capacity and audio dependency", () => {
  const base = { prompt: "测试", duration: 10, resolution: "720p", aspectRatio: "9:16", syncAudio: false };
  assert.throws(() => fmgoK20FastPayload(FMGO_K20_FAST_MODEL, { ...base, duration: 12, materials: [] }), /只支持 10 秒或 15 秒/);
  assert.throws(() => fmgoK20FastPayload(FMGO_K20_FAST_MODEL, {
    ...base, materials: [{ kind: "audio", url: "https://example.com/ref.mp3" }],
  }), /必须同时提供普通参考图或参考视频/);
  assert.throws(() => fmgoK20FastPayload(FMGO_K20_FAST_MODEL, {
    ...base,
    materials: Array.from({ length: 10 }, (_, index) => ({ kind: "image", url: `https://example.com/${index}.png` })),
  }), /图片参考最多 9 张/);
});

test("adds FMGO V2.5 to the model catalog and SD2.5 switch", () => {
  assert.ok(FALLBACK_MODELS.fmgo.includes(FMGO_V25_MODEL));
  assert.equal(preferredModelForSdVersion("fmgo", "sd20"), "feimiao-v2");
  assert.equal(preferredModelForSdVersion("fmgo", "sd25"), FMGO_V25_MODEL);
  assert.equal(sdVersionForModel(FMGO_V25_MODEL), "sd25");
});

test("exposes the documented FMGO V2.5 resolution-specific options", () => {
  const capability = capabilityFor({ adapter: "fmgo", model: FMGO_V25_MODEL });
  assert.equal(capability.images, 30);
  assert.equal(capability.videos, 3);
  assert.equal(capability.audios, 3);
  assert.deepEqual(capability.resolutions, ["480p"]);
  assert.deepEqual(capability.durations, [5]);
  assert.deepEqual(capability.durationsByResolution, { "480p": [5] });
  assert.deepEqual(capability.ratios, ["16:9", "9:16", "1:1"]);
  assert.deepEqual(fmgoV25Capability("feimiao-v2.5-720p-15s").durations, [15]);
});

test("builds the documented FMGO V2.5 mixed-reference request", () => {
  const payload = fmgoV25Payload(FMGO_V25_MODEL, {
    prompt: "保持人物一致",
    duration: 5,
    resolution: "480p",
    aspectRatio: "16:9",
    syncAudio: true,
    materials: [
      { kind: "image", subType: "reference", url: "https://example.com/ref.png" },
      { kind: "video", url: "https://example.com/ref.mp4" },
      { kind: "audio", url: "https://example.com/ref.mp3" },
    ],
  });
  assert.deepEqual(payload, {
    model: "feimiao-v2.5",
    prompt: "保持人物一致",
    aspect_ratio: "16:9",
    resolution: "480p",
    seconds: "5",
    images: ["https://example.com/ref.png"],
    reference_videos: ["https://example.com/ref.mp4"],
    reference_audios: ["https://example.com/ref.mp3"],
  });
});

test("maps FMGO V2.5 first and last frames to their dedicated fields", () => {
  const payload = fmgoV25Payload(FMGO_V25_MODEL, {
    prompt: "首尾衔接",
    duration: 5,
    resolution: "480p",
    aspectRatio: "9:16",
    syncAudio: false,
    materials: [
      { kind: "image", subType: "first_frame", url: "https://example.com/first.png" },
      { kind: "image", subType: "last_frame", url: "https://example.com/last.png" },
    ],
  });
  assert.equal(payload.start_frame, "https://example.com/first.png");
  assert.equal(payload.end_frame, "https://example.com/last.png");
  assert.equal("motion_has_audio" in payload, false);
  assert.equal("images" in payload, false);
});

test("rejects unsupported FMGO V2.5 combinations before submission", () => {
  assert.throws(() => fmgoV25Payload(FMGO_V25_MODEL, {
    prompt: "错误时长", duration: 5, resolution: "720p", aspectRatio: "16:9", materials: [],
  }), /720p 不支持 5 秒/);
  assert.throws(() => fmgoV25Payload(FMGO_V25_MODEL, {
    prompt: "音频单独参考", duration: 5, resolution: "480p", aspectRatio: "16:9",
    materials: [{ kind: "audio", url: "https://example.com/ref.mp3" }],
  }), /必须同时提供普通参考图或参考视频/);
  assert.throws(() => fmgoV25Payload(FMGO_V25_MODEL, {
    prompt: "只有尾帧", duration: 5, resolution: "480p", aspectRatio: "16:9",
    materials: [{ kind: "image", subType: "last_frame", url: "https://example.com/last.png" }],
  }), /必须同时提供首帧/);
  assert.throws(() => fmgoV25Payload("feimiao-v2.5-480p-15s", {
    prompt: "模型后缀冲突", duration: 10, resolution: "720p", aspectRatio: "16:9", materials: [],
  }), /参数不一致/);
});

test("allows 30 FMGO V2.5 reference images and rejects the 31st", () => {
  const materials = Array.from({ length: 30 }, (_, index) => ({
    kind: "image",
    subType: "reference",
    url: `https://example.com/${index + 1}.png`,
  }));
  const input = {
    prompt: "三十张参考图",
    duration: 5,
    resolution: "480p",
    aspectRatio: "16:9",
    materials,
  };
  assert.equal(fmgoV25Payload(FMGO_V25_MODEL, input).images.length, 30);
  assert.throws(() => fmgoV25Payload(FMGO_V25_MODEL, {
    ...input,
    materials: [...materials, { kind: "image", subType: "reference", url: "https://example.com/31.png" }],
  }), /参考图最多 30 张/);
});
