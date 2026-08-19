import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROFILES,
  capabilityFor,
  inferAdapter,
  migrateSavedProfile,
  pollDelayForAdapter,
} from "../src/providerCatalog.js";
import {
  clmmLimitIssue,
  clmmModelRules,
  clmmModels,
  clmmVideoPayload,
} from "../src/clmmCatalog.js";
import { pidoiCapability, pidoiLimitIssue, pidoiVideoPayload } from "../src/pidoiCatalog.js";

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
