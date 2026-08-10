import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROFILES,
  capabilityFor,
  inferAdapter,
  preferredModelForSdVersion,
  sdVersionForModel,
} from "../src/providerCatalog.js";
import {
  LWAIGC_VIDEO_MODELS,
  lwaigcCapability,
  lwaigcLimitIssue,
  lwaigcVideoPayload,
} from "../src/lwaigcCatalog.js";

function materials(images, audios, videos) {
  return [
    ...Array.from({ length: images }, (_, index) => ({ kind: "image", url: `https://example.com/image-${index}.jpg` })),
    ...Array.from({ length: audios }, (_, index) => ({ kind: "audio", url: `https://example.com/audio-${index}.mp3` })),
    ...Array.from({ length: videos }, (_, index) => ({ kind: "video", url: `https://example.com/video-${index}.mp4` })),
  ];
}

test("includes LWAIGC as a built-in OpenAI-compatible provider", () => {
  const profile = DEFAULT_PROFILES.find((item) => item.id === "lwaigc");
  assert.deepEqual(profile, {
    id: "lwaigc",
    name: "LWAIGC",
    baseUrl: "https://ai.lwaigc.cn",
    adapter: "lwaigc",
    model: "firefly-seedance2-720p",
    mediaUploadUrl: "https://ai.lwaigc.cn/v1/assets",
  });
  assert.equal(inferAdapter(profile.baseUrl), "lwaigc");
  assert.equal(LWAIGC_VIDEO_MODELS.length, 23);
});

test("applies the documented LWAIGC capacity for Seedance 2.5", () => {
  const capability = capabilityFor({ adapter: "lwaigc", model: "mf-seedance2.5" });
  assert.equal(capability.images, 30);
  assert.equal(capability.videos, 10);
  assert.equal(capability.audios, 10);
  assert.deepEqual(capability.resolutions, ["480p", "720p"]);
  assert.equal(capability.durations.at(0), 4);
  assert.equal(capability.durations.at(-1), 30);
});

test("switches LWAIGC between the documented SD2.0 and SD2.5 models", () => {
  const sd20Model = preferredModelForSdVersion("lwaigc", "sd20");
  const sd25Model = preferredModelForSdVersion("lwaigc", "sd25");
  const sd20 = capabilityFor({ adapter: "lwaigc", model: sd20Model });
  const sd25 = capabilityFor({ adapter: "lwaigc", model: sd25Model });

  assert.equal(sdVersionForModel(sd20Model), "sd20");
  assert.equal(sdVersionForModel(sd25Model), "sd25");
  assert.deepEqual(
    { images: sd20.images, audios: sd20.audios, videos: sd20.videos, maxDuration: Math.max(...sd20.durations) },
    { images: 9, audios: 3, videos: 3, maxDuration: 15 },
  );
  assert.deepEqual(
    { images: sd25.images, audios: sd25.audios, videos: sd25.videos, maxDuration: Math.max(...sd25.durations) },
    { images: 30, audios: 10, videos: 10, maxDuration: 30 },
  );
});

test("builds the documented LWAIGC video payload with exact field names", () => {
  const payload = lwaigcVideoPayload("mf-seedance2.5", {
    prompt: "测试提示词",
    duration: 15,
    resolution: "720p",
    aspectRatio: "16:9",
    materials: [
      { kind: "image", url: "https://ai.lwaigc.cn/v1/assets/image" },
      { kind: "video", url: "https://ai.lwaigc.cn/v1/assets/video" },
      { kind: "audio", url: "https://ai.lwaigc.cn/v1/assets/audio" },
    ],
  }, "client_test_1");

  assert.deepEqual(payload, {
    model: "mf-seedance2.5",
    client_task_id: "client_test_1",
    prompt: "测试提示词",
    seconds: 15,
    aspect_ratio: "16:9",
    resolution: "720p",
    image_urls: ["https://ai.lwaigc.cn/v1/assets/image"],
    video_urls: ["https://ai.lwaigc.cn/v1/assets/video"],
    audio_urls: ["https://ai.lwaigc.cn/v1/assets/audio"],
  });
});

test("uses size and one image for the documented LWAIGC Grok payload", () => {
  const payload = lwaigcVideoPayload("grok-imagine-video-1.5-preview", {
    prompt: "测试",
    duration: 10,
    resolution: "720p",
    aspectRatio: "9:16",
    materials: [
      { kind: "image", url: "https://example.com/first.jpg" },
      { kind: "image", url: "https://example.com/ignored.jpg" },
    ],
  }, "client_grok_1");

  assert.deepEqual(payload, {
    model: "grok-imagine-video-1.5-preview",
    client_task_id: "client_grok_1",
    prompt: "测试",
    seconds: 10,
    images: ["https://example.com/first.jpg"],
    size: "720x1280",
  });
});

test("accepts and serializes the full SD2.0 capacity of 15 references", () => {
  const model = preferredModelForSdVersion("lwaigc", "sd20");
  const fullCapacity = materials(9, 3, 3);
  assert.equal(lwaigcLimitIssue(model, fullCapacity, 15), "");

  const payload = lwaigcVideoPayload(model, {
    prompt: "SD2.0 满容量测试",
    duration: 15,
    resolution: "720p",
    aspectRatio: "16:9",
    materials: fullCapacity,
  }, "client_sd20_capacity");
  assert.equal(payload.image_urls.length, 9);
  assert.equal(payload.audio_urls.length, 3);
  assert.equal(payload.video_urls.length, 3);
  assert.equal(payload.seconds, 15);
  assert.equal("resolution" in payload, false);
  assert.equal("duration" in payload, false);
});

test("rejects every SD2.0 one-over-capacity boundary and a 16 second request", () => {
  const model = preferredModelForSdVersion("lwaigc", "sd20");
  assert.match(lwaigcLimitIssue(model, materials(10, 3, 3), 15), /图片参考最多 9 个/);
  assert.match(lwaigcLimitIssue(model, materials(9, 4, 3), 15), /音频参考最多 3 个/);
  assert.match(lwaigcLimitIssue(model, materials(9, 3, 4), 15), /视频参考最多 3 个/);
  assert.match(lwaigcLimitIssue(model, materials(9, 3, 3), 16), /不支持 16 秒/);
});

test("accepts and serializes the full SD2.5 capacity of 50 references", () => {
  const model = preferredModelForSdVersion("lwaigc", "sd25");
  const fullCapacity = materials(30, 10, 10);
  assert.equal(fullCapacity.length, 50);
  assert.equal(lwaigcLimitIssue(model, fullCapacity, 30), "");

  const payload = lwaigcVideoPayload(model, {
    prompt: "SD2.5 满容量测试",
    duration: 30,
    resolution: "720p",
    aspectRatio: "9:16",
    materials: fullCapacity,
  }, "client_sd25_capacity");
  assert.equal(payload.image_urls.length, 30);
  assert.equal(payload.audio_urls.length, 10);
  assert.equal(payload.video_urls.length, 10);
  assert.equal(payload.seconds, 30);
  assert.equal(payload.resolution, "720p");
});

test("rejects every SD2.5 one-over-capacity boundary and a 31 second request", () => {
  const model = preferredModelForSdVersion("lwaigc", "sd25");
  assert.match(lwaigcLimitIssue(model, materials(31, 10, 10), 30), /图片参考最多 30 个/);
  assert.match(lwaigcLimitIssue(model, materials(30, 11, 10), 30), /音频参考最多 10 个/);
  assert.match(lwaigcLimitIssue(model, materials(30, 10, 11), 30), /视频参考最多 10 个/);
  assert.match(lwaigcLimitIssue(model, materials(30, 10, 10), 31), /不支持 31 秒/);
});

test("defines sane capabilities for all 23 documented LWAIGC video models", () => {
  assert.equal(new Set(LWAIGC_VIDEO_MODELS).size, 23);
  for (const model of LWAIGC_VIDEO_MODELS) {
    const capability = lwaigcCapability(model);
    assert.ok(capability.images >= 1 && capability.images <= 30, `${model} 图片上限无效`);
    assert.ok(capability.audios >= 0 && capability.audios <= 10, `${model} 音频上限无效`);
    assert.ok(capability.videos >= 0 && capability.videos <= 10, `${model} 视频上限无效`);
    assert.ok(capability.durations.length > 0, `${model} 缺少时长`);
    assert.ok(Math.max(...capability.durations) <= 30, `${model} 时长超过文档上限`);
    assert.ok(capability.resolutions.length > 0, `${model} 缺少分辨率`);
  }
});

test("sends resolution only for LWAIGC models that require it", () => {
  const input = {
    prompt: "分辨率字段测试",
    duration: 10,
    resolution: "720p",
    aspectRatio: "16:9",
    materials: [],
  };
  for (const model of ["mg-sd431-mini", "mg-sd431-fast", "mg-sd431-Pro", "mf-seedance2.5"]) {
    assert.equal(lwaigcVideoPayload(model, input, "client_dynamic").resolution, "720p", model);
  }
  for (const model of ["firefly-seedance2-720p", "sd2-431-720p-pro", "wf-sd2.5-720p", "MiniMax-H3"]) {
    assert.equal("resolution" in lwaigcVideoPayload(model, input, "client_fixed"), false, model);
  }
});

test("maps the SD version switch for both supported relay adapters", () => {
  assert.equal(preferredModelForSdVersion("lwaigc", "sd20"), "firefly-seedance2-720p");
  assert.equal(preferredModelForSdVersion("lwaigc", "sd25"), "mf-seedance2.5");
  assert.equal(preferredModelForSdVersion("paipu", "sd20"), "lec-seedance-videos-standard");
  assert.equal(preferredModelForSdVersion("paipu", "sd25"), "lec-seedance-2-5");
  assert.equal(preferredModelForSdVersion("fmgo", "sd25"), "");
});

test("rejects unknown LWAIGC models before any upstream request", () => {
  assert.equal(lwaigcLimitIssue("unknown-video-model", [], 10), "请选择 LWAIGC 视频模型");
});
