import assert from "node:assert/strict";
import test from "node:test";

import {
  AIYRX_BASE_URL,
  AIYRX_VIDEO_MODELS,
  aiyrxCapability,
  aiyrxModels,
  aiyrxVideoPayload,
} from "../src/aiyrxCatalog.js";
import {
  DEFAULT_PROFILES,
  FALLBACK_MODELS,
  capabilityFor,
  inferAdapter,
  migrateSavedProfile,
  modelForSdVersion,
} from "../src/providerCatalog.js";
import { directTaskContentPaths } from "../src/taskContent.js";

test("adds AIYRX as a built-in provider with the documented API and asset route", () => {
  const profile = DEFAULT_PROFILES.find((item) => item.id === "aiyrx");
  assert.equal(profile.baseUrl, AIYRX_BASE_URL);
  assert.equal(profile.adapter, "aiyrx");
  assert.equal(profile.mediaUploadUrl, `${AIYRX_BASE_URL}/v1/assets`);
  assert.deepEqual(FALLBACK_MODELS.aiyrx, AIYRX_VIDEO_MODELS);
  assert.equal(inferAdapter(AIYRX_BASE_URL), "aiyrx");
  assert.equal(migrateSavedProfile({ ...profile, adapter: "newapi" }).adapter, "aiyrx");
});

test("keeps the documented AIYRX model limits including zero video and audio", () => {
  assert.equal(AIYRX_VIDEO_MODELS.length, 11);
  assert.deepEqual(
    aiyrxCapability("SD2.5-720P-30.0.0").durations,
    [5, 10, 30],
  );
  const imageOnly = capabilityFor({ adapter: "aiyrx", model: "SD2.5-720P-30.0.0" });
  assert.deepEqual(
    { images: imageOnly.images, videos: imageOnly.videos, audios: imageOnly.audios },
    { images: 30, videos: 0, audios: 0 },
  );
  const full = capabilityFor({ adapter: "aiyrx", model: "官逆SD2.5-720P-不卡脸30图10视频10音频" });
  assert.equal(full.durations.at(-1), 30);
  assert.deepEqual(
    { images: full.images, videos: full.videos, audios: full.audios },
    { images: 30, videos: 10, audios: 10 },
  );
});

test("normalizes the live AIYRX model catalog and exact capability fields", () => {
  const catalog = aiyrxModels({ data: [{
    id: "SD2.5-live",
    name: "SD2.5-live",
    minimum_duration_seconds: 6,
    maximum_duration_seconds: 8,
    capabilities: {
      resolutions: ["720"],
      aspect_ratios: ["16:9", "9:16"],
      maximum_reference_images: 12,
      maximum_reference_videos: 0,
      maximum_reference_audios: 0,
    },
  }] });
  assert.deepEqual(catalog.models, ["SD2.5-live"]);
  assert.deepEqual(catalog.capabilities["SD2.5-live"].durations, [6, 7, 8]);
  assert.deepEqual(catalog.capabilities["SD2.5-live"].resolutions, ["720p"]);
  assert.deepEqual(
    {
      images: catalog.capabilities["SD2.5-live"].images,
      videos: catalog.capabilities["SD2.5-live"].videos,
      audios: catalog.capabilities["SD2.5-live"].audios,
    },
    { images: 12, videos: 0, audios: 0 },
  );
});

test("builds the native AIYRX task request from uploaded asset IDs", () => {
  assert.deepEqual(aiyrxVideoPayload("官逆SD2.5-720P-不卡脸30图10视频10音频", {
    prompt: "测试提示词",
    duration: 12,
    resolution: "720p",
    aspectRatio: "16:9",
    syncAudio: true,
    materials: [
      { kind: "image", tag: "@Image1", assetId: "11111111-1111-1111-1111-111111111111", subType: "first_frame" },
      { kind: "audio", tag: "@Audio1", assetId: "22222222-2222-2222-2222-222222222222" },
    ],
  }), {
    model: "官逆SD2.5-720P-不卡脸30图10视频10音频",
    channel: "auto",
    prompt: "测试提示词",
    duration_seconds: 12,
    aspect_ratio: "16:9",
    references: [
      { id: "Image1", asset_id: "11111111-1111-1111-1111-111111111111", role: "first_frame" },
      { id: "Audio1", asset_id: "22222222-2222-2222-2222-222222222222", role: "reference" },
    ],
  });
});

test("uses documented legacy URL fields only when assets have not been uploaded", () => {
  const payload = aiyrxVideoPayload("A渠道SD2.0-Fast720P-933不卡脸", {
    prompt: "测试",
    duration: 15,
    aspectRatio: "9:16",
    materials: [
      { kind: "image", url: "https://example.com/a.png" },
      { kind: "video", url: "https://example.com/a.mp4" },
      { kind: "audio", url: "https://example.com/a.wav" },
    ],
  });
  assert.deepEqual(payload.image_urls, ["https://example.com/a.png"]);
  assert.deepEqual(payload.video_urls, ["https://example.com/a.mp4"]);
  assert.deepEqual(payload.audio_urls, ["https://example.com/a.wav"]);
  assert.equal("resolution" in payload, false);
  assert.equal("generate_audio" in payload, false);
});

test("switches AIYRX model versions and uses its authenticated content route", () => {
  const profile = { adapter: "aiyrx", model: "A渠道SD2.0-Fast720P-933不卡脸" };
  assert.equal(
    modelForSdVersion(profile, "sd25", AIYRX_VIDEO_MODELS),
    "官逆SD2.5-720P-不卡脸30图10视频10音频",
  );
  assert.deepEqual(directTaskContentPaths("aiyrx", "task/id"), ["/v1/videos/task%2Fid/content"]);
});
