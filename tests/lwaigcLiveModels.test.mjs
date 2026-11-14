import test from "node:test";
import assert from "node:assert/strict";
import { capabilityFor, preferredDurationForVersion } from "../src/providerCatalog.js";
import { LWAIGC_VIDEO_MODELS, lwaigcCapability, lwaigcLimitIssue, lwaigcVideoPayload } from "../src/lwaigcCatalog.js";

const newModel = "future-provider/sd2.5-new-2027";
const images = Array.from({ length: 30 }, (_, index) => ({ kind: "image", url: `https://assets.example/image-${index}.png` }));

test("unknown live LWAIGC models are not rejected by the static documented names", () => {
  assert.equal(LWAIGC_VIDEO_MODELS.includes(newModel), false);
  assert.equal(lwaigcLimitIssue(newModel, images, 30), "");
  assert.equal(lwaigcLimitIssue("future-model-opaque", images, 30), "");
});

test("unknown model controls remain unverified while respecting the selected SD image ceiling", () => {
  for (const model of [newModel, "future-model-opaque"]) {
    const capability = capabilityFor({ adapter: "lwaigc", model });
    assert.equal(capability._capabilityUnverified, true);
    assert.equal(capability._preserveLimits, true);
    assert.deepEqual([capability.images, capability.videos, capability.audios], [model === newModel ? 50 : 9, 50, 50]);
    assert.ok(capability.durations.includes(30));
    assert.deepEqual(capability.durations, Array.from({ length: 30 }, (_, index) => index + 1));
    assert.deepEqual(capability.resolutions, ["720p"]);
    assert.equal(capability.syncAudioFixed, true);
  }
  assert.equal(lwaigcCapability(newModel)._sdVersion, "sd25");
  assert.equal(lwaigcCapability("future-sd2.0-new")._sdVersion, "sd20");
});

test("unverified LWAIGC defaults stay within the 30-second business range", () => {
  const sd25 = capabilityFor({ adapter: "lwaigc", model: newModel });
  const preferred25 = preferredDurationForVersion(sd25, "sd25");
  assert.ok(preferred25 <= 30, `unverified SD2.5 default must not exceed 30 seconds; received ${preferred25}`);
  assert.ok(sd25.durations.includes(preferred25));
  const sd20 = capabilityFor({ adapter: "lwaigc", model: "future-sd2.0-new" });
  assert.equal(preferredDurationForVersion(sd20, "sd20"), 15);
});

test("new model uses the unified protocol without inventing optional resolution fields", () => {
  const payload = lwaigcVideoPayload(newModel, {
    prompt: "保持人物外观一致", duration: 30, aspectRatio: "9:16", resolution: "1080p", seed: 7,
    materials: [...images, { kind: "video", url: "https://assets.example/reference.mp4" }, { kind: "audio", url: "https://assets.example/reference.wav" }],
  }, "original-client-key");
  assert.equal(payload.model, newModel);
  assert.equal(payload.client_task_id, "original-client-key");
  assert.equal(payload.seconds, 30);
  assert.equal(payload.aspect_ratio, "9:16");
  assert.equal(payload.image_urls.length, 30);
  assert.deepEqual(payload.video_urls, ["https://assets.example/reference.mp4"]);
  assert.deepEqual(payload.audio_urls, ["https://assets.example/reference.wav"]);
  assert.equal("resolution" in payload, false);
  assert.equal("seed" in payload, false);
});

test("unknown names still require a model and obey workbench request boundaries", () => {
  for (const model of ["", " ", null]) assert.match(lwaigcLimitIssue(model, [], 15), /请选择/);
  for (const duration of [0, 31, 60, 61, 1.5, NaN]) assert.match(lwaigcLimitIssue(newModel, [], duration), /不支持/);
  assert.match(lwaigcLimitIssue(newModel, [...images, ...images], 30), /50/);
});

test("known LWAIGC rules remain specific and are not widened by new-model support", () => {
  assert.match(lwaigcLimitIssue("dq-sd933-pro", [], 16), /不支持/);
  assert.match(lwaigcLimitIssue("ld-sd2.5-v2", images, 30), /最多 9/);
  assert.match(lwaigcLimitIssue("ld-sd2.5-v2", [{ kind: "audio" }], 30), /音频参考最多 0/);
  assert.equal(lwaigcCapability("ld-sd2.5-v2")._capabilityUnverified, undefined);
});
