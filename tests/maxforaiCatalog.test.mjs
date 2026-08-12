import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROFILES, FALLBACK_MODELS, capabilityFor, inferAdapter } from "../src/providerCatalog.js";
import { MAXFORAI_VIDEO_MODELS, maxforaiVideoPayload } from "../src/maxforaiCatalog.js";

test("includes MaxForAI with its official base URL and video catalog", () => {
  const profile = DEFAULT_PROFILES.find((item) => item.id === "maxforai");
  assert.equal(profile.baseUrl, "https://maxforai.top");
  assert.equal(profile.mediaUploadUrl, "https://maxforai.top/v1/assets");
  assert.equal(inferAdapter(profile.baseUrl), "maxforai");
  assert.deepEqual(FALLBACK_MODELS.maxforai, MAXFORAI_VIDEO_MODELS);
});

test("uses MaxForAI official Seedance parameter names", () => {
  const payload = maxforaiVideoPayload("sd-fast-720p", {
    prompt: "test", duration: 15, aspectRatio: "9:16", resolution: "720p", syncAudio: true,
    materials: [{ kind: "image", url: "https://example.com/a.png" }],
  });
  assert.equal(payload.seconds, "15");
  assert.equal(payload.ratio, "9:16");
  assert.equal(payload.generate_audio, true);
  assert.deepEqual(payload.images, ["https://example.com/a.png"]);
  assert.equal("duration" in payload, false);
});

test("uses MaxForAI unified duration parameter names for Firefly", () => {
  const payload = maxforaiVideoPayload("firefly-seedance2-720p", {
    prompt: "test", duration: 15, aspectRatio: "16:9", resolution: "720p", syncAudio: true,
    materials: [{ kind: "audio", url: "https://example.com/a.wav" }],
  });
  assert.equal(payload.duration, 15);
  assert.equal(payload.aspect_ratio, "16:9");
  assert.equal(payload.generateAudio, true);
  assert.deepEqual(payload.audios, ["https://example.com/a.wav"]);
});

test("exposes SD2.0 and SD2.5 workbench capacities", () => {
  const sd20 = capabilityFor({ adapter: "maxforai", model: "firefly-seedance2-720p" });
  const sd25 = capabilityFor({ adapter: "maxforai", model: "mg-seedance-2.5" });
  assert.equal(sd20.images, 9); assert.equal(sd20.audios, 3); assert.equal(sd20.videos, 3);
  assert.equal(sd25.images, 30); assert.equal(sd25.audios, 10); assert.equal(sd25.videos, 10);
});
