import assert from "node:assert/strict";
import test from "node:test";

import {
  UNMAU_BASE_URL,
  unmauCatalog,
  unmauVideoPayload,
} from "../src/unmauCatalog.js";
import { DEFAULT_PROFILES, capabilityFor, inferAdapter, migrateSavedProfile } from "../src/providerCatalog.js";

const pricing = {
  data: [
    {
      model_name: "ad-seedance-2.0-720p",
      description: "稳定满血",
      model_price: 0.65,
      task_billing_mode: "per_second",
      supported_endpoint_types: ["openai-video"],
      video_capabilities: {
        resolutions: ["720p"],
        aspect_ratios: ["16:9", "9:16"],
        duration: { min: 4, max: 15, default: 5 },
        references: { max_images: 9, max_videos: 3, max_audios: 3 },
      },
    },
    {
      model_name: "官方-seedance-2-5-720p",
      model_price: 1,
      task_billing_mode: "per_second",
      supported_endpoint_types: ["openai-video"],
      video_capabilities: {
        resolutions: ["720p"],
        aspect_ratios: ["16:9", "9:16", "1:1"],
        duration: { min: 4, max: 30, default: 15 },
        references: { max_images: 30, max_videos: 10, max_audios: 10 },
        audio_track: { supported: true, default: true, configurable: true },
      },
    },
    { model_name: "gpt-5.6-sol", supported_endpoint_types: ["openai"] },
  ],
};

test("adds Unmau as a built-in provider with its official material route", () => {
  const profile = DEFAULT_PROFILES.find((item) => item.id === "unmau");
  assert.equal(profile.baseUrl, UNMAU_BASE_URL);
  assert.equal(profile.mediaUploadUrl, `${UNMAU_BASE_URL}/v1/materials`);
  assert.equal(inferAdapter(UNMAU_BASE_URL), "unmau");
  assert.equal(migrateSavedProfile({ id: "unmau", baseUrl: "https://old.example.com", adapter: "newapi" }).adapter, "unmau");
});

test("keeps only video models enabled for the current Unmau key and reads live limits", () => {
  const catalog = unmauCatalog(pricing, {
    data: [
      { id: "官方-seedance-2-5-720p", supported_endpoint_types: ["openai-video"] },
      { id: "gpt-5.6-sol", supported_endpoint_types: ["openai"] },
    ],
  });
  assert.deepEqual(catalog.models, ["官方-seedance-2-5-720p"]);
  assert.deepEqual(catalog.capabilities["官方-seedance-2-5-720p"].durations, Array.from({ length: 27 }, (_, index) => index + 4));
  assert.deepEqual(
    {
      images: catalog.capabilities["官方-seedance-2-5-720p"].images,
      videos: catalog.capabilities["官方-seedance-2-5-720p"].videos,
      audios: catalog.capabilities["官方-seedance-2-5-720p"].audios,
    },
    { images: 30, videos: 10, audios: 10 },
  );
  assert.match(catalog.labels["官方-seedance-2-5-720p"], /1元\/秒/);
  assert.equal(capabilityFor({ adapter: "unmau", model: "官方-seedance-2-5-720p", routeCapabilities: catalog.capabilities }).images, 30);
});

test("builds the exact documented Unmau request and only sends audio_track for supported models", () => {
  const materials = [
    { kind: "image", url: "https://example.com/a.png" },
    { kind: "video", url: "https://example.com/v.mp4" },
    { kind: "audio", url: "https://example.com/a.wav" },
  ];
  const ordinary = unmauVideoPayload("ad-seedance-2.0-720p", {
    prompt: "测试", duration: 15, aspectRatio: "16:9", resolution: "720p", syncAudio: true, materials,
  });
  assert.deepEqual(ordinary, {
    model: "ad-seedance-2.0-720p", prompt: "测试", duration: 15,
    aspect_ratio: "16:9", resolution: "720p",
    images: ["https://example.com/a.png"], videos: ["https://example.com/v.mp4"], audios: ["https://example.com/a.wav"],
  });
  const official = unmauVideoPayload("官方-seedance-2-5-720p", {
    prompt: "测试", duration: 30, aspectRatio: "9:16", resolution: "720p", syncAudio: false, materials: [],
  });
  assert.equal(official.audio_track, false);
});
