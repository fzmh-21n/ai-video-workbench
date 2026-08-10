import assert from "node:assert/strict";
import test from "node:test";

import { mediaUploadMode } from "../src/uploadPolicy.js";

test("uses Paipu's configured upload endpoint for local images", () => {
  assert.equal(mediaUploadMode({ mediaUploadUrl: "https://api.paipu.net/v1/media/upload" }, "image/png"), "configured");
});

test("automatically converts local Paipu audio and video to temporary HTTPS URLs", () => {
  const config = { mediaUploadUrl: "https://api.paipu.net/v1/media/upload" };
  assert.equal(mediaUploadMode(config, "audio/wav"), "temporary");
  assert.equal(mediaUploadMode(config, "video/mp4"), "temporary");
});

test("keeps other provider upload endpoints for audio", () => {
  assert.equal(mediaUploadMode({ mediaUploadUrl: "https://ai.lwaigc.cn/v1/assets" }, "audio/wav"), "configured");
});

test("uses automatic temporary upload when no custom endpoint is configured", () => {
  assert.equal(mediaUploadMode({ mediaUploadUrl: "" }, "audio/wav"), "temporary");
});
