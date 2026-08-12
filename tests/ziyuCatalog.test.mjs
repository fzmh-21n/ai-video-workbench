import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PROFILES, capabilityFor, inferAdapter, migrateSavedProfile, modelForSdVersion } from "../src/providerCatalog.js";
import { ziyuJobFrom, ziyuJobPayload, ziyuModels, ziyuTaskId } from "../src/ziyuCatalog.js";

test("includes Ziyu AI as a built-in dedicated provider", () => {
  const profile = DEFAULT_PROFILES.find((item) => item.id === "ziyuai");
  assert.equal(profile.baseUrl, "https://ziyuai.vip");
  assert.equal(profile.adapter, "ziyuai");
  assert.equal(profile.mediaUploadUrl, "https://ziyuai.vip/api/v1/uploads");
  assert.equal(inferAdapter(profile.baseUrl), "ziyuai");
  assert.equal(migrateSavedProfile({ ...profile, adapter: "newapi" }).adapter, "ziyuai");
});

test("normalizes the official Ziyu model catalog and keeps SD2.0 at 9/3/3", () => {
  const catalog = ziyuModels({
    models: [{
      id: "model_sd20",
      name: "Seedance 2.0",
      type: "video",
      allowedDurations: [5, 10, 15],
      allowedRatios: ["16:9", "9:16"],
      assetLimits: { image: 4, video: 0, audio: 1 },
      resolution: "720p",
    }],
  });
  assert.deepEqual(catalog.models, ["model_sd20"]);
  assert.equal(catalog.labels.model_sd20, "Seedance 2.0 · 720p");
  assert.deepEqual(
    capabilityFor({ adapter: "ziyuai", model: "model_sd20", routeCapabilities: catalog.capabilities }),
    catalog.capabilities.model_sd20,
  );
  assert.deepEqual(
    { images: catalog.capabilities.model_sd20.images, audios: catalog.capabilities.model_sd20.audios, videos: catalog.capabilities.model_sd20.videos },
    { images: 9, audios: 3, videos: 3 },
  );
});

test("builds the exact Ziyu jobs request", () => {
  assert.deepEqual(ziyuJobPayload("model_123", {
    prompt: "测试",
    duration: 15,
    aspectRatio: "9:16",
    materials: [
      { kind: "image", url: "https://example.com/a.png" },
      { kind: "audio", url: "https://example.com/a.wav" },
      { kind: "video", url: "https://example.com/a.mp4" },
    ],
  }), {
    modelId: "model_123",
    mode: "i2v",
    prompt: "测试",
    ratio: "9:16",
    duration: "15秒",
    assets: {
      image: [{ url: "https://example.com/a.png" }],
      audio: [{ url: "https://example.com/a.wav" }],
      video: [{ url: "https://example.com/a.mp4" }],
    },
  });
});

test("recognizes and switches a live Ziyu SD2.5 model at full capacity", () => {
  const catalog = ziyuModels({ models: [
    { id: "model_sd20", name: "Seedance 2.0", type: "video" },
    { id: "model_sd25", name: "Seedance 2.5", type: "video" },
  ] });
  const profile = {
    adapter: "ziyuai",
    model: "model_sd20",
    routeCapabilities: catalog.capabilities,
  };
  assert.equal(modelForSdVersion(profile, "sd25", catalog.models), "model_sd25");
  const capability = capabilityFor({ ...profile, model: "model_sd25" });
  assert.deepEqual(
    { images: capability.images, audios: capability.audios, videos: capability.videos, maxDuration: Math.max(...capability.durations) },
    { images: 30, audios: 10, videos: 10, maxDuration: 30 },
  );
});

test("reads the nested job returned by the official Ziyu API", () => {
  const response = {
    ok: true,
    job: {
      id: "job_ziyu_123",
      status: "queued",
      previewUrl: null,
    },
  };
  assert.equal(ziyuTaskId(response), "job_ziyu_123");
  assert.deepEqual(ziyuJobFrom(response), response.job);
  assert.equal(ziyuTaskId({ data: { job: { id: "job_nested_456" } } }), "job_nested_456");
});

test("all SD2.0 relay profiles expose the uniform workbench capacity", () => {
  for (const profile of [
    { adapter: "fmgo", model: "feimiao-v2-720p-15s" },
    { adapter: "paipu", model: "lec-seedance-2-0" },
    { adapter: "viralee", model: "viraldance921" },
    { adapter: "lwaigc", model: "sd2-431-720p-fast" },
    { adapter: "meaicc", model: "seedance-2.0" },
  ]) {
    const capability = capabilityFor(profile);
    assert.deepEqual(
      { images: capability.images, audios: capability.audios, videos: capability.videos },
      { images: 9, audios: 3, videos: 3 },
      `${profile.adapter}/${profile.model}`,
    );
  }
});
