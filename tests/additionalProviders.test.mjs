import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROFILES,
  capabilityFor,
  inferAdapter,
  migrateSavedProfile,
  modelForSdVersion,
  pollDelayForAdapter,
} from "../src/providerCatalog.js";
import {
  CLMM_PRICING_URL,
  clmmCapability,
  clmmLimitIssue,
  clmmModelRules,
  clmmModels,
  clmmVideoPayload,
} from "../src/clmmCatalog.js";
import { PIDOI_MODELS, pidoiCapability, pidoiLimitIssue, pidoiVideoPayload } from "../src/pidoiCatalog.js";

const materials = [
  { kind: "image", url: "https://example.com/a.png" },
  { kind: "video", url: "https://example.com/a.mp4" },
  { kind: "audio", url: "https://example.com/a.wav" },
];

test("adds CLMM Mall and Pidoi as built-in providers", () => {
  assert.ok(DEFAULT_PROFILES.some((profile) => profile.id === "clmm"));
  assert.ok(DEFAULT_PROFILES.some((profile) => profile.id === "pidoi"));
  assert.equal(inferAdapter("https://clmm-mall.top/v1"), "clmm");
  assert.equal(inferAdapter("https://pidoi.com"), "pidoi");
  assert.equal(DEFAULT_PROFILES.find((profile) => profile.id === "pidoi").mediaUploadUrl, "");
  assert.equal(pollDelayForAdapter("clmm"), 3000);
});

test("removes the obsolete guessed Pidoi upload endpoint but preserves a user endpoint", () => {
  const obsolete = migrateSavedProfile({
    id: "pidoi", adapter: "pidoi", baseUrl: "https://pidoi.com",
    model: "sd-2.0-931-720p", mediaUploadUrl: "https://pidoi.com/v1/media/uploads",
  });
  assert.equal(obsolete.mediaUploadUrl, "");
  assert.equal(obsolete.model, "sd-2.0-931-720p");

  const custom = migrateSavedProfile({
    id: "pidoi", adapter: "pidoi", baseUrl: "https://pidoi.com",
    model: "tejiasd", mediaUploadUrl: "https://uploads.example.com/files",
  });
  assert.equal(custom.mediaUploadUrl, "https://uploads.example.com/files");
});

test("reads CLMM pricing model names without removing channel prefixes", () => {
  assert.deepEqual(clmmModels({ data: [{ model: "op-video-gz-10s" }, { id: "me-videos-720P-10s" }] }), [
    "op-video-gz-10s",
    "me-videos-720P-10s",
  ]);
});

test("uses the live CLMM pricing endpoint and reads its current model_name schema", () => {
  assert.equal(CLMM_PRICING_URL, "https://clmm-mall.top/api/pricing");
  assert.deepEqual(clmmModels({ data: [
    {
      model_name: "mg-seedance-2.5-720p",
      supported_endpoint_types: ["openai-video"],
    },
    {
      model_name: "gpt-5.6-luna",
      supported_endpoint_types: ["openai"],
    },
  ] }), ["mg-seedance-2.5-720p"]);
});

test("exposes CLMM SD2.5 limits and switches to a live SD2.5 model", () => {
  const capability = clmmCapability("mg-seedance-2.5-720p");
  assert.deepEqual(
    {
      images: capability.images,
      videos: capability.videos,
      audios: capability.audios,
      durations: capability.durations,
      resolutions: capability.resolutions,
      version: capability._sdVersion,
    },
    {
      images: 30,
      videos: 10,
      audios: 10,
      durations: Array.from({ length: 16 }, (_, index) => index + 15),
      resolutions: ["720p"],
      version: "sd25",
    },
  );
  assert.equal(modelForSdVersion(
    { adapter: "clmm", model: "mg-seedance-2.0-720p" },
    "sd25",
    ["mg-seedance-2.0-720p", "mg-seedance-2.5-720p"],
  ), "mg-seedance-2.5-720p");
});

test("parses CLMM fixed duration, resolution, image and no-video suffixes", () => {
  assert.deepEqual(clmmModelRules("op-video-720P-10s-gz-2img-nv"), {
    model: "op-video-720P-10s-gz-2img-nv",
    maxSeconds: 10,
    fixed: true,
    resolution: "720P",
    minImages: 2,
    noVideos: true,
    invalid: false,
  });
  assert.match(clmmLimitIssue("op-video-gz", [], 10), /缺少 -Ns/);
});

test("builds CLMM fixed and adjustable duration requests", () => {
  const fixed = clmmVideoPayload("op-video-720P-10s-gz", {
    prompt: "测试", duration: 10, aspectRatio: "16:9", materials,
  });
  assert.equal(fixed.seconds, "1");
  assert.equal(fixed.mySeconds, "10");
  assert.equal(fixed.resolution, "720P");
  assert.deepEqual(fixed.reference_videos, ["https://example.com/a.mp4"]);

  const adjustable = clmmVideoPayload("me-videos-720P-10s", {
    prompt: "测试", duration: 6, aspectRatio: "9:16", materials,
  });
  assert.equal(adjustable.seconds, "1");
  assert.equal(adjustable.mySeconds, "6");
  assert.equal(adjustable.size, "720x1280");
});

test("builds CLMM SD2.5 ordinary and fixed-duration requests", () => {
  const ordinary = clmmVideoPayload("mg-seedance-2.5-720p", {
    prompt: "保持人物一致", duration: 20, aspectRatio: "16:9", materials,
  });
  assert.equal(ordinary.seconds, "20");
  assert.equal("mySeconds" in ordinary, false);
  assert.equal(ordinary.resolution, "720p");
  assert.deepEqual(ordinary.reference_audios, ["https://example.com/a.wav"]);

  const fixed = clmmVideoPayload("seedance-2.5-720p-gz-30s", {
    prompt: "保持人物一致", duration: 30, aspectRatio: "9:16", materials,
  });
  assert.equal(fixed.seconds, "1");
  assert.equal(fixed.mySeconds, "30");
  assert.equal(fixed.size, "720x1280");
});

test("builds the exact Pidoi tejiasd request", () => {
  const payload = pidoiVideoPayload("tejiasd", {
    prompt: "测试", duration: 15, aspectRatio: "16:9", materials, seed: 7,
  });
  assert.deepEqual(payload, {
    model: "tejiasd",
    prompt: "测试",
    duration: 15,
    resolution: "720P",
    n: 1,
    metadata: { aspect_ratio: "16:9" },
    images: ["https://example.com/a.png"],
    videos: ["https://example.com/a.mp4"],
    audios: ["https://example.com/a.wav"],
    seed: 7,
  });
  assert.equal("seconds" in payload, false);
  assert.deepEqual(capabilityFor({ adapter: "pidoi", model: "tejiasd" }).resolutions, ["720p"]);
});

test("builds documented Pidoi SD2 request with the universal video fields", () => {
  const payload = pidoiVideoPayload("sd-2.0-931-720p", {
    prompt: "测试", duration: 15, resolution: "720p", aspectRatio: "9:16", materials, syncAudio: true,
  });
  assert.deepEqual(payload, {
    model: "sd-2.0-931-720p",
    prompt: "测试",
    aspect_ratio: "9:16",
    resolution: "720p",
    seconds: "15",
    image_url: "https://example.com/a.png",
    reference_videos: ["https://example.com/a.mp4"],
    audio_urls: ["https://example.com/a.wav"],
  });
});

test("builds documented Pidoi SD2.5 request with the same universal video fields", () => {
  const payload = pidoiVideoPayload("sd-2.5-720p", {
    prompt: "测试", duration: 20, resolution: "720p", aspectRatio: "16:9", materials, syncAudio: true,
  });
  assert.equal(payload.seconds, "20");
  assert.equal(payload.resolution, "720p");
  assert.equal(payload.image_url, "https://example.com/a.png");
  assert.deepEqual(payload.reference_videos, ["https://example.com/a.mp4"]);
  assert.deepEqual(payload.audio_urls, ["https://example.com/a.wav"]);
  assert.equal("duration" in payload, false);
  assert.equal("generate_audio" in payload, false);
});

test("builds the documented Pidoi sora-v3-933-pro universal request", () => {
  const richMaterials = [
    { kind: "image", url: "https://example.com/main.jpg" },
    { kind: "image", url: "https://example.com/ref-1.jpg" },
    { kind: "video", url: "https://example.com/motion.mp4", durationSeconds: 5 },
    { kind: "audio", url: "https://example.com/voice.wav", durationSeconds: 4 },
  ];
  assert.deepEqual(pidoiVideoPayload("sora-v3-933-pro", {
    prompt: "保持人物一致", duration: 15, aspectRatio: "21:9", materials: richMaterials, syncAudio: true,
  }), {
    model: "sora-v3-933-pro",
    prompt: "保持人物一致",
    aspect_ratio: "21:9",
    resolution: "720p",
    seconds: "15",
    image_url: "https://example.com/main.jpg",
    reference_image_urls: ["https://example.com/ref-1.jpg"],
    reference_videos: ["https://example.com/motion.mp4"],
    audio_urls: ["https://example.com/voice.wav"],
  });
  assert.deepEqual(pidoiCapability("sora-v3-933-pro").durations, [15]);
});

test("enforces Pidoi universal-reference duration, total-file, and tail-frame rules", () => {
  assert.match(pidoiLimitIssue("sora-v3-933-pro", Array.from({ length: 13 }, () => ({ kind: "image" })), 15), /最多 12 个/);
  assert.match(pidoiLimitIssue("sora-v3-933-pro", [{ kind: "image", subType: "last_frame" }], 15), /不支持尾帧图/);
  assert.match(pidoiLimitIssue("sora-v3-933-pro", [{ kind: "audio", durationSeconds: 16 }], 15), /2–15 秒/);
  assert.match(pidoiLimitIssue("sora-v3-933-pro", [
    { kind: "video", durationSeconds: 8 }, { kind: "video", durationSeconds: 8 },
  ], 15), /总时长不能超过 15 秒/);
  assert.equal(pidoiLimitIssue("sora-v3-933-pro", [{ kind: "audio", durationSeconds: 5 }], 15), "");
});

test("exposes the documented Pidoi SD2.5 limits", () => {
  const capability = capabilityFor({ adapter: "pidoi", model: "sd-2.5-720p" });
  assert.equal(capability.images, 30);
  assert.equal(capability.videos, 10);
  assert.equal(capability.audios, 1);
  assert.deepEqual(capability.durations, Array.from({ length: 26 }, (_, index) => index + 4));
  assert.deepEqual(capability.ratios, ["16:9", "9:16", "1:1"]);
});

test("adds the documented Pidoi WAN 3.0 model and capability", () => {
  assert.ok(PIDOI_MODELS.includes("wan30-720p"));
  const capability = capabilityFor({ adapter: "pidoi", model: "wan30-720p" });
  assert.deepEqual({
    images: capability.images,
    videos: capability.videos,
    audios: capability.audios,
    firstDuration: capability.durations[0],
    lastDuration: capability.durations.at(-1),
    resolutions: capability.resolutions,
    ratios: capability.ratios,
  }, {
    images: 10,
    videos: 5,
    audios: 5,
    firstDuration: 4,
    lastDuration: 30,
    resolutions: ["720p"],
    ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
  });
});

test("builds Pidoi WAN 3.0 single and multiple reference fields", () => {
  const single = pidoiVideoPayload("wan30-720p", {
    prompt: "保持人物一致", duration: 30, resolution: "720p", aspectRatio: "16:9", materials,
  });
  assert.deepEqual(single, {
    model: "wan30-720p",
    prompt: "保持人物一致",
    aspect_ratio: "16:9",
    resolution: "720p",
    seconds: "30",
    image_url: "https://example.com/a.png",
    reference_video: "https://example.com/a.mp4",
    audio_url: "https://example.com/a.wav",
  });

  const multiple = pidoiVideoPayload("wan30-720p", {
    prompt: "多素材", duration: 12, resolution: "720p", aspectRatio: "9:16",
    materials: [
      { kind: "image", url: "https://example.com/main.jpg" },
      { kind: "image", url: "https://example.com/ref.jpg" },
      { kind: "video", url: "https://example.com/v1.mp4" },
      { kind: "video", url: "https://example.com/v2.mp4" },
      { kind: "audio", url: "https://example.com/a1.wav" },
      { kind: "audio", url: "https://example.com/a2.wav" },
    ],
  });
  assert.deepEqual(multiple.reference_image_urls, ["https://example.com/ref.jpg"]);
  assert.deepEqual(multiple.reference_videos, ["https://example.com/v1.mp4", "https://example.com/v2.mp4"]);
  assert.deepEqual(multiple.audio_urls, ["https://example.com/a1.wav", "https://example.com/a2.wav"]);
  assert.equal("reference_video" in multiple, false);
  assert.equal("audio_url" in multiple, false);
});

test("enforces Pidoi WAN 3.0 reference rules", () => {
  assert.equal(pidoiLimitIssue("wan30-720p", [
    { kind: "image" },
    { kind: "video", durationSeconds: 5 },
    { kind: "audio", durationSeconds: 5 },
  ], 15), "");
  assert.match(pidoiLimitIssue("wan30-720p", [{ kind: "video", durationSeconds: 5 }], 30), /输出时长只支持 4–15 秒/);
  assert.match(pidoiLimitIssue("wan30-720p", [{ kind: "audio", durationSeconds: 5 }], 10), /必须同时提供/);
  assert.match(pidoiLimitIssue("wan30-720p", [{ kind: "image", subType: "last_frame" }], 10), /不支持尾帧图/);
  assert.match(pidoiLimitIssue("wan30-720p", Array.from({ length: 11 }, () => ({ kind: "image" })), 10), /图片参考最多 10 张/);
  assert.match(pidoiLimitIssue("wan30-720p", [
    { kind: "image" }, { kind: "video", durationSeconds: 8 }, { kind: "video", durationSeconds: 8 },
  ], 10), /视频总时长不能超过 15 秒/);
  assert.match(pidoiLimitIssue("wan30-720p", [
    { kind: "image" }, { kind: "audio", durationSeconds: 5, sizeBytes: 16 * 1024 * 1024 },
  ], 10), /参考音频单个文件不能超过 15MB/);
});
