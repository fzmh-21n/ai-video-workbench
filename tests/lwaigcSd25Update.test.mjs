import assert from "node:assert/strict";
import test from "node:test";
import { LWAIGC_VIDEO_MODELS, lwaigcCapability, lwaigcLimitIssue, lwaigcVideoPayload } from "../src/lwaigcCatalog.js";
import { capabilityFor, FALLBACK_MODELS, sdVersionForProfile } from "../src/providerCatalog.js";

const expected = {
  "dbb-sd2.5-v1": [30, 10, 10, 4, 30, ["720p"]],
  "mf-sd2.5-v2": [30, 10, 10, 4, 30, ["720p"]],
  "ld-sd2.5-v1": [30, 10, 10, 4, 30, ["480p", "720p", "1080p"]],
  "ld-sd2.5-v2": [9, 0, 0, 30, 30, ["720p"]],
  "lg-sd2.5-v1": [30, 10, 10, 4, 30, ["480p", "720p", "1080p"]],
  "hn-sd2.5-v2": [30, 0, 0, 30, 30, ["720p"]],
  "wf-sd2.5-v5": [30, 0, 10, 30, 30, ["720p"]],
  "wf-sd2.5-v5-face": [30, 0, 10, 30, 30, ["720p"]],
  "fs-sd2.5-v1": [30, 10, 0, 4, 30, ["1080p"]],
};
const refs = (images, videos, audios) => [
  ...Array.from({ length: images }, () => ({ kind: "image", url: "https://cdn.example.com/image.png" })),
  ...Array.from({ length: videos }, () => ({ kind: "video", url: "https://cdn.example.com/video.mp4" })),
  ...Array.from({ length: audios }, () => ({ kind: "audio", url: "https://cdn.example.com/audio.mp3" })),
];

test("all nine current LWAIGC SD2.5 models are selectable with exact limits", () => {
  for (const [model, spec] of Object.entries(expected)) {
    assert.ok(LWAIGC_VIDEO_MODELS.includes(model), model);
    assert.ok(FALLBACK_MODELS.lwaigc.includes(model), model);
    const profile = { adapter: "lwaigc", model };
    const cap = capabilityFor(profile);
    assert.deepEqual([cap.images, cap.videos, cap.audios, cap.durations[0], cap.durations.at(-1), cap.resolutions], spec, model);
    assert.equal(sdVersionForProfile(profile), "sd25");
    assert.equal(lwaigcLimitIssue(model, refs(...spec.slice(0, 3)), spec[4]), "", model);
    for (const [index, label] of [[0, "图片"], [1, "视频"], [2, "音频"]]) {
      const counts = spec.slice(0, 3);
      counts[index]++;
      assert.match(lwaigcLimitIssue(model, refs(...counts), spec[4]), new RegExp(`${label}参考最多`), model);
    }
    assert.match(lwaigcLimitIssue(model, [], spec[3] - 1), /不支持/);
    assert.match(lwaigcLimitIssue(model, [], 31), /不支持/);
  }
});

test("new channels use seconds, correct material arrays and existing stable client task ID", () => {
  for (const model of ["mf-sd2.5-v2", "wf-sd2.5-v5-face", "fs-sd2.5-v1"]) {
    const cap = lwaigcCapability(model);
    const payload = lwaigcVideoPayload(model, { prompt: "人物转身", duration: cap.durations.at(-1), resolution: cap.resolutions[0], aspectRatio: "9:16", materials: refs(1, cap.videos ? 1 : 0, cap.audios ? 1 : 0) }, "stable-client-id");
    assert.equal(payload.model, model);
    assert.equal(payload.client_task_id, "stable-client-id");
    assert.equal(payload.seconds, 30);
    assert.equal(payload.aspect_ratio, "9:16");
    assert.equal("duration" in payload, false);
    assert.equal("resolution" in payload, false); // fixed resolution uses provider default
    assert.equal(payload.image_urls.length, 1);
    assert.equal("video_urls" in payload, cap.videos > 0);
    assert.equal("audio_urls" in payload, cap.audios > 0);
  }
});
