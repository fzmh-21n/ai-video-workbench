import assert from "node:assert/strict";
import test from "node:test";

import {
  SUANLIAI_BASE_URL,
  SUANLIAI_VIDEO_MODELS,
  suanliaiCapability,
  suanliaiCatalog,
  suanliaiReferencePrompt,
  suanliaiRoutes,
  suanliaiUploadPath,
  suanliaiVideoPayload,
} from "../src/suanliaiCatalog.js";
import {
  DEFAULT_PROFILES,
  FALLBACK_MODELS,
  capabilityFor,
  inferAdapter,
  migrateSavedProfile,
} from "../src/providerCatalog.js";
import { directTaskContentPaths } from "../src/taskContent.js";

const materials = [
  { kind: "image", url: "https://example.com/person.png", name: "人物.png" },
  { kind: "video", url: "https://example.com/move.mp4", name: "动作.mp4", durationSeconds: 6.2 },
  { kind: "audio", url: "https://example.com/voice.wav", name: "声音.wav" },
];

const input = {
  prompt: "保持人物一致",
  duration: 10,
  aspectRatio: "16:9",
  resolution: "720p",
  syncAudio: true,
  materials,
};

test("adds 算力AI as one provider and preserves its documented catalog", () => {
  const profile = DEFAULT_PROFILES.find((item) => item.id === "suanliai");
  assert.equal(profile.baseUrl, SUANLIAI_BASE_URL);
  assert.equal(profile.adapter, "suanliai");
  assert.equal(inferAdapter("https://suanliai.top/v1"), "suanliai");
  assert.deepEqual(FALLBACK_MODELS.suanliai, SUANLIAI_VIDEO_MODELS);
  assert.equal(new Set(SUANLIAI_VIDEO_MODELS).size, SUANLIAI_VIDEO_MODELS.length);
  assert.equal(migrateSavedProfile({ id: "suanliai", baseUrl: "https://old.example", adapter: "newapi" }).adapter, "suanliai");
});

test("routes each 算力AI series to its own documented endpoint", () => {
  assert.deepEqual(suanliaiRoutes("004系列/minimax-h3 768p"), {
    createPath: "/v1/videos", statusBasePath: "/v1/videos", content: true,
  });
  assert.deepEqual(suanliaiRoutes("003系列/sd2.5(30-10-10/4-30秒720P)"), {
    createPath: "/v1/videos", statusBasePath: "/v1/tasks", content: false,
  });
  assert.deepEqual(suanliaiRoutes("全能sd2.0(满血原生过脸-933-720p)"), {
    createPath: "/api/v1/videos", statusBasePath: "/api/v1/videos", content: false,
  });
  assert.deepEqual(suanliaiRoutes("官转稳定-sd2-720p(933满血不卡脸)"), {
    createPath: "/v1/video/generations", statusBasePath: "/v1/video/generations", content: false,
  });
  assert.equal(suanliaiUploadPath("003系列/example"), "/v1/media");
  assert.equal(suanliaiUploadPath("官转稳定-sd2-720p(933满血不卡脸)"), "/v1/assets/uploads");
  assert.deepEqual(directTaskContentPaths("suanliai", "task_abc"), []);
});

test("uses the exact 004, 002, 003, all-purpose and official field names", () => {
  assert.deepEqual(suanliaiVideoPayload("004系列/minimax-h3 768p", input), {
    model: "004系列/minimax-h3 768p", prompt: "保持人物一致", seconds: 10,
    ratio: "16:9", resolution: "720p",
    images: ["https://example.com/person.png"],
    videos: ["https://example.com/move.mp4"],
    audios: ["https://example.com/voice.wav"],
  });
  assert.deepEqual(suanliaiVideoPayload("002系列/test", input), {
    model: "002系列/test", prompt: "保持人物一致", duration: 10,
    ratio: "16:9", resolution: "720p",
    referenceImages: ["https://example.com/person.png"],
    referenceVideos: ["https://example.com/move.mp4"],
    referenceAudios: ["https://example.com/voice.wav"],
  });
  assert.deepEqual(suanliaiVideoPayload("003系列/test", input), {
    model: "003系列/test", prompt: "保持人物一致", duration: 10,
    ratio: "16:9", resolution: "720p", generate_audio: true,
    images: ["https://example.com/person.png"],
    reference_videos: ["https://example.com/move.mp4"],
    reference_audios: ["https://example.com/voice.wav"],
  });
  assert.deepEqual(suanliaiVideoPayload("全能sd2.0(满血原生过脸-933-720p)", input), {
    model: "全能sd2.0(满血原生过脸-933-720p)", prompt: "保持人物一致", seconds: "10",
    aspect_ratio: "16:9", resolution: "720p",
    images: ["https://example.com/person.png"], videos: ["https://example.com/move.mp4"], audios: ["https://example.com/voice.wav"],
  });
  assert.deepEqual(suanliaiVideoPayload("官转稳定-sd2-720p(933满血不卡脸)", input), {
    model: "官转稳定-sd2-720p(933满血不卡脸)", prompt: "保持人物一致", duration: 10,
    ratio: "16:9", resolution: "720p", generate_audio: true,
    images: ["https://example.com/person.png"],
    reference_videos: ["https://example.com/move.mp4"],
    reference_audios: ["https://example.com/voice.wav"],
  });
});

test("uses object references for the deal series and omits unsupported sd-2.5 fields", () => {
  const deal = suanliaiVideoPayload("特价/wan3.0-video-720p", input);
  assert.deepEqual(deal.reference_images, [{ url: "https://example.com/person.png", role: "reference_image" }]);
  assert.deepEqual(deal.reference_videos, [{ url: "https://example.com/move.mp4", role: "reference_video", duration: 7 }]);
  assert.deepEqual(deal.reference_audios, [{ url: "https://example.com/voice.wav", role: "reference_audio" }]);

  const fixed = suanliaiVideoPayload("特价/sd-2.5", input);
  assert.equal(fixed.seconds, undefined);
  assert.equal(fixed.duration, undefined);
  assert.deepEqual(fixed.images, ["https://example.com/person.png"]);
  assert.equal(fixed.reference_videos, undefined);
  assert.equal(fixed.reference_audios, undefined);
});

test("normalizes strict 002 and 004 prompt references", () => {
  assert.match(
    suanliaiReferencePrompt("002系列/test", "@Image1 说话", materials, true),
    /@图1 说话[\s\S]*@图1=人物\.png[\s\S]*@视频1=动作\.mp4[\s\S]*@音频1=声音\.wav/,
  );
  assert.match(
    suanliaiReferencePrompt("004系列/test", "@Image1 说话", materials, true),
    /Image 1 说话[\s\S]*Image 1 = 人物\.png[\s\S]*Video 1 = 动作\.mp4[\s\S]*Audio 1 = 声音\.wav/,
  );
});

test("reads live model shapes and keeps documented material limits", () => {
  const catalog = suanliaiCatalog(
    { data: [{ id: "003系列/sd2.5(30-10-10/4-30秒720P)", type: "video_generation" }, { id: "gpt-image-2", type: "image_generation" }] },
    { data: { models: [{ id: "全能sd2.0(满血原生过脸-933-720p)", type: "video_generation", capabilities: { resolutions: ["720p"], aspect_ratios: ["16:9"] } }] } },
  );
  assert.deepEqual(catalog.models, [
    "003系列/sd2.5(30-10-10/4-30秒720P)",
    "全能sd2.0(满血原生过脸-933-720p)",
  ]);
  assert.deepEqual(catalog.capabilities["003系列/sd2.5(30-10-10/4-30秒720P)"].images, 30);
  assert.deepEqual(capabilityFor({ adapter: "suanliai", model: "004系列/minimax_h3(8图3音频)" }), suanliaiCapability("004系列/minimax_h3(8图3音频)"));
});
