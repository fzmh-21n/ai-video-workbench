import assert from "node:assert/strict";
import test from "node:test";

import {
  SEEDANCE_VIDEO_BASE_URL,
  seedanceVideoModels,
  seedanceVideoPayload,
} from "../src/seedanceVideoCatalog.js";
import {
  DEFAULT_PROFILES,
  capabilityFor,
  inferAdapter,
  migrateSavedProfile,
} from "../src/providerCatalog.js";
import { directTaskContentPaths } from "../src/taskContent.js";
import { mediaUploadMode } from "../src/uploadPolicy.js";

test("adds the documented Seedance video provider without guessing a model", () => {
  const profile = DEFAULT_PROFILES.find((item) => item.id === "seedancevideo");
  assert.equal(profile.baseUrl, SEEDANCE_VIDEO_BASE_URL);
  assert.equal(profile.adapter, "seedancevideo");
  assert.equal(profile.model, "");
  assert.equal(profile.mediaUploadUrl, `${SEEDANCE_VIDEO_BASE_URL}/v1/uploads/images`);
  assert.equal(inferAdapter(SEEDANCE_VIDEO_BASE_URL), "seedancevideo");
  assert.deepEqual(migrateSavedProfile({ ...profile, adapter: "newapi" }), profile);
});

test("keeps live model IDs, resolution values, durations, prices and reference support", () => {
  const catalog = seedanceVideoModels({
    object: "list",
    data: [{
      id: "supplier-sd-2.5",
      name: "供应商 SD2.5",
      billingMode: "per_second",
      resolutions: [
        { value: "1080pp", label: "1080P", price: 0.18 },
        { value: "4kpp", label: "4K", price: 0.35 },
      ],
      durations: [15, 5, 10],
      supports_reference_audio: true,
      supports_reference_video: false,
    }],
  });
  assert.deepEqual(catalog.models, ["supplier-sd-2.5"]);
  assert.deepEqual(catalog.capabilities["supplier-sd-2.5"].resolutions, ["1080pp", "4kpp"]);
  assert.deepEqual(catalog.capabilities["supplier-sd-2.5"].durations, [5, 10, 15]);
  assert.equal(catalog.capabilities["supplier-sd-2.5"].videos, 0);
  assert.equal(catalog.capabilities["supplier-sd-2.5"].audios, 50);
  assert.match(catalog.labels["supplier-sd-2.5"], /1080P 0\.18积分\/秒/);
  assert.match(catalog.labels["supplier-sd-2.5"], /4K 0\.35积分\/秒/);

  const capability = capabilityFor({
    adapter: "seedancevideo",
    model: "supplier-sd-2.5",
    routeCapabilities: catalog.capabilities,
  });
  assert.equal(capability.images, 50);
  assert.equal(capability.videos, 0);
  assert.equal(capability._sdVersion, "sd25");
});

test("builds the documented nested task payload and reference media types", () => {
  assert.deepEqual(seedanceVideoPayload("supplier-model", {
    prompt: "海边日落，电影感运镜",
    duration: 15,
    resolution: "1080pp",
    aspectRatio: "16:9",
    materials: [
      { kind: "image", url: "https://example.com/a.png" },
      { kind: "audio", url: "https://example.com/a.wav" },
      { kind: "video", url: "https://example.com/a.mp4" },
    ],
  }), {
    model: "supplier-model",
    input: {
      prompt: "海边日落，电影感运镜",
      media: [
        { type: "reference_image", url: "https://example.com/a.png" },
        { type: "reference_voice", url: "https://example.com/a.wav" },
        { type: "reference_video", url: "https://example.com/a.mp4" },
      ],
    },
    parameters: { resolution: "1080pp", ratio: "16:9", duration: 15 },
  });
});

test("uses provider image upload only for images and its public content route", () => {
  const config = { mediaUploadUrl: `${SEEDANCE_VIDEO_BASE_URL}/v1/uploads/images` };
  assert.equal(mediaUploadMode(config, "image/png"), "configured");
  assert.equal(mediaUploadMode(config, "audio/wav"), "temporary");
  assert.equal(mediaUploadMode(config, "video/mp4"), "temporary");
  assert.deepEqual(directTaskContentPaths("seedancevideo", "task/id"), ["/v1/videos/task%2Fid/content"]);
});
