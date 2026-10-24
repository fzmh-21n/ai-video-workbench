import assert from "node:assert/strict";
import test from "node:test";
import { LWAIGC_VIDEO_MODELS, lwaigcLimitIssue, lwaigcVideoPayload } from "../src/lwaigcCatalog.js";
import { FALLBACK_MODELS, FALLBACK_MODEL_LABELS, capabilityFor } from "../src/providerCatalog.js";

const model = "qi-sd2.5-v1";
const profile = { adapter: "lwaigc", model };
const references = (kind, count) => Array.from({ length: count }, (_, index) => ({
  kind, url: `https://example.com/${kind}-${index}?expires=123&signature=keep`,
}));
const materials = [...references("image", 30), ...references("video", 10), ...references("audio", 10)];

test("QI Seedance 2.5 appears in the LWAIGC model selector with the documented capability", () => {
  assert.ok(LWAIGC_VIDEO_MODELS.includes(model));
  assert.ok(FALLBACK_MODELS.lwaigc.includes(model));
  const capability = capabilityFor(profile);
  assert.equal(capability._sdVersion, "sd25");
  assert.deepEqual([capability.images, capability.videos, capability.audios], [30, 10, 10]);
  assert.deepEqual(capability.durations, Array.from({ length: 27 }, (_, index) => index + 4));
  assert.deepEqual(capability.resolutions, ["720p"]);
  assert.match(FALLBACK_MODEL_LABELS.lwaigc[model], /QI Seedance 2\.5.*30图\/10视频\/10音频/);
});

test("QI Seedance 2.5 uses the existing mixed-reference payload without resolution or duration aliases", () => {
  const input = { prompt: "保持主体一致", duration: 30, resolution: "720p", aspectRatio: "9:16", materials };
  const payload = lwaigcVideoPayload(model, input, "client_qi_sd25_123");
  assert.deepEqual(payload, {
    model, client_task_id: "client_qi_sd25_123", prompt: input.prompt, seconds: 30,
    aspect_ratio: "9:16", image_urls: materials.filter(item => item.kind === "image").map(item => item.url),
    video_urls: materials.filter(item => item.kind === "video").map(item => item.url),
    audio_urls: materials.filter(item => item.kind === "audio").map(item => item.url),
  });
  assert.equal("resolution" in payload, false);
  assert.equal("duration" in payload, false);
  assert.deepEqual(lwaigcVideoPayload(model, { ...input, materials: [], duration: 4 }, "client_qi_text"), {
    model, client_task_id: "client_qi_text", prompt: input.prompt, seconds: 4, aspect_ratio: "9:16",
  });
});

test("QI Seedance 2.5 enforces every reference and duration boundary before submission", () => {
  assert.equal(lwaigcLimitIssue(model, materials, 4), "");
  assert.equal(lwaigcLimitIssue(model, materials, 30), "");
  for (const [kind, label] of [["image", "图片"], ["video", "视频"], ["audio", "音频"]]) {
    assert.match(lwaigcLimitIssue(model, [...materials, ...references(kind, 1)], 30), new RegExp(label + "参考最多"));
  }
  for (const duration of [3, 31, 4.5]) assert.match(lwaigcLimitIssue(model, [], duration), /不支持/);
});
