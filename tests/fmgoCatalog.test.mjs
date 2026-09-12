import assert from "node:assert/strict";
import test from "node:test";

import {
  FMGO_V25_MODEL,
  fmgoV25Capability,
  fmgoV25Payload,
} from "../src/fmgoCatalog.js";
import {
  FALLBACK_MODELS,
  capabilityFor,
  preferredModelForSdVersion,
  sdVersionForModel,
} from "../src/providerCatalog.js";

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
