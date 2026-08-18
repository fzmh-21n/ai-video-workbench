import assert from "node:assert/strict";
import test from "node:test";

import { FALLBACK_MODELS, capabilityFor } from "../src/providerCatalog.js";
import {
  LWAIGC_VIDEO_MODELS,
  isLwaigcDqModel,
  lwaigcLimitIssue,
  lwaigcVideoPayload,
} from "../src/lwaigcCatalog.js";

const materials = [
  { kind: "image", url: "https://ai.lwaigc.cn/v1/assets/image" },
  { kind: "audio", url: "https://ai.lwaigc.cn/v1/assets/audio" },
  { kind: "video", url: "https://ai.lwaigc.cn/v1/assets/video" },
];

test("exposes DQ Seedance only in the LwAiGc catalog", () => {
  for (const model of ["dq-sd933-pro", "dq-sd933-pro-face"]) {
    assert.ok(isLwaigcDqModel(model));
    assert.ok(LWAIGC_VIDEO_MODELS.includes(model));
    assert.ok(FALLBACK_MODELS.lwaigc.includes(model));
    assert.equal(FALLBACK_MODELS.paipu.includes(model), false);
  }
});

test("uses the documented LwAiGc DQ capacity", () => {
  const capability = capabilityFor({ adapter: "lwaigc", model: "dq-sd933-pro-face" });
  assert.deepEqual(
    { images: capability.images, videos: capability.videos, audios: capability.audios },
    { images: 9, videos: 3, audios: 3 },
  );
  assert.deepEqual(capability.durations, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(capability.resolutions, ["720p"]);
  assert.equal(lwaigcLimitIssue("dq-sd933-pro", materials, 4), "");
  assert.match(lwaigcLimitIssue("dq-sd933-pro", [], 16), /不支持 16 秒/);
});

test("builds the documented LwAiGc DQ request", () => {
  const payload = lwaigcVideoPayload("dq-sd933-pro-face", {
    prompt: "测试视频",
    duration: 15,
    resolution: "720p",
    aspectRatio: "9:16",
    materials,
    seed: 123,
  }, "client_dq_1");
  assert.deepEqual(payload, {
    model: "dq-sd933-pro-face",
    client_task_id: "client_dq_1",
    prompt: "测试视频",
    seconds: 15,
    size: "720x1280",
    seed: 123,
    aspect_ratio: "9:16",
    image_urls: ["https://ai.lwaigc.cn/v1/assets/image"],
    video_urls: ["https://ai.lwaigc.cn/v1/assets/video"],
    audio_urls: ["https://ai.lwaigc.cn/v1/assets/audio"],
  });
  assert.equal("resolution" in payload, false);
  assert.equal("duration" in payload, false);
});
