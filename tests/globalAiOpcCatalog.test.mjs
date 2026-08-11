import test from "node:test";
import assert from "node:assert/strict";
import {
  GLOBAL_AIOPC_BASE_URL,
  GLOBAL_AIOPC_MODELS,
  globalAiOpcCapability,
  globalAiOpcCreatePath,
  globalAiOpcPayload,
  globalAiOpcStatusPath,
} from "../src/globalAiOpcCatalog.js";
import { DEFAULT_PROFILES, FALLBACK_MODELS, inferAdapter } from "../src/providerCatalog.js";

test("全球 AI 内置配置使用官方 API 根地址和完整模型表", () => {
  const profile = DEFAULT_PROFILES.find((item) => item.id === "globalaiopc");
  assert.equal(profile.baseUrl, GLOBAL_AIOPC_BASE_URL);
  assert.equal(profile.adapter, "globalaiopc");
  assert.deepEqual(FALLBACK_MODELS.globalaiopc, GLOBAL_AIOPC_MODELS);
  assert.equal(inferAdapter(GLOBAL_AIOPC_BASE_URL), "globalaiopc");
});
test("全球 AI 优惠版使用 content 素材结构和结果查询路由", () => {
  const model = "sd_2.0_fast_discount_720p";
  const payload = globalAiOpcPayload(model, {
    prompt: "测试",
    duration: 15,
    aspectRatio: "16:9",
    syncAudio: true,
    seed: 7,
    materials: [
      { kind: "image", url: "https://example.com/a.png" },
      { kind: "audio", url: "https://example.com/a.wav" },
      { kind: "video", url: "https://example.com/a.mp4" },
    ],
  });
  assert.equal(globalAiOpcCreatePath(model), "/v1/seedance-discount/videos");
  assert.equal(globalAiOpcStatusPath(model, "abc"), "/v1/result/abc");
  assert.equal(payload.content.length, 4);
  assert.deepEqual(payload.content.map((item) => item.role).filter(Boolean), [
    "reference_image", "reference_audio", "reference_video",
  ]);
  assert.equal(payload.generate_audio, true);
  assert.equal(payload.seed, 7);
});

test("全球 AI 完整版支持首尾帧及 9 图 3 音频 3 视频", () => {
  const payload = globalAiOpcPayload("seedance_2_0", {
    prompt: "测试", duration: 10, aspectRatio: "9:16", syncAudio: true,
    materials: [
      { kind: "image", subType: "first_frame", url: "https://example.com/first.png" },
      { kind: "image", subType: "last_frame", url: "https://example.com/last.png" },
      { kind: "image", url: "https://example.com/ref.png" },
      { kind: "audio", url: "https://example.com/ref.wav" },
    ],
  });
  assert.equal(globalAiOpcCreatePath("seedance_2_0"), "/v1/kyyvideo2/videos");
  assert.equal(payload.first_image, "https://example.com/first.png");
  assert.equal(payload.last_image, "https://example.com/last.png");
  assert.deepEqual(payload.referenceImages, ["https://example.com/ref.png"]);
  const capability = globalAiOpcCapability("sd_2.0_special_4k");
  assert.deepEqual([capability.images, capability.audios, capability.videos], [9, 3, 3]);
  assert.deepEqual(capability.resolutions, ["4K"]);
});
