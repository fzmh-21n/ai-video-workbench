import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATIC_UPLOAD_SERVICES,
  configuredUploadBatchSize,
  configuredUploadRetryDelay,
  createUploadCircuitBreaker,
  mediaUploadMode,
  tmpfilesDirectUrl,
} from "../src/uploadPolicy.js";

test("uploads Ziyu materials one at a time so completed URLs can be checkpointed", () => {
  assert.equal(configuredUploadBatchSize("ziyuai"), 1);
  assert.equal(configuredUploadBatchSize("meaicc"), 50);
});

test("honors numeric and HTTP-date Retry-After values with a safe cap", () => {
  assert.equal(configuredUploadRetryDelay("12", 0, 0), 12_000);
  assert.equal(configuredUploadRetryDelay("Thu, 01 Jan 1970 00:00:20 GMT", 0, 10_000), 10_000);
  assert.equal(configuredUploadRetryDelay("600", 0, 0), 120_000);
});

test("uses exponential waits when Ziyu omits Retry-After", () => {
  assert.equal(configuredUploadRetryDelay("", 0, 0), 5_000);
  assert.equal(configuredUploadRetryDelay("", 1, 0), 10_000);
  assert.equal(configuredUploadRetryDelay("", 2, 0), 20_000);
});

test("tries Uguu before Litterbox and Tmpfiles", () => {
  assert.deepEqual(AUTOMATIC_UPLOAD_SERVICES, ["Uguu", "Litterbox", "Tmpfiles"]);
});

test("opens the Litterbox circuit after consecutive failures in this server run", () => {
  const circuit = createUploadCircuitBreaker({ failureThreshold: 2 });
  assert.equal(circuit.recordFailure("Litterbox"), false);
  assert.equal(circuit.isOpen("Litterbox"), false);
  assert.equal(circuit.recordFailure("Litterbox"), true);
  assert.equal(circuit.isOpen("Litterbox"), true);
  assert.equal(circuit.isOpen("Uguu"), false);
});

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

test("converts the Tmpfiles response into its direct-download URL", () => {
  assert.equal(
    tmpfilesDirectUrl("https://tmpfiles.org/abc123/voice.wav"),
    "https://tmpfiles.org/dl/abc123/voice.wav",
  );
});
