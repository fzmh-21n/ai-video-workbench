import test from "node:test";
import assert from "node:assert/strict";
import { LWAIGC_VIDEO_MODELS, lwaigcCapability, lwaigcLimitIssue, lwaigcVideoPayload } from "../src/lwaigcCatalog.js";
import { FALLBACK_MODELS, capabilityFor, sdVersionForProfile } from "../src/providerCatalog.js";

test("fs-sd2.0-v1 uses the DBB SD2.0 protocol with only its model name changed", () => {
  const model = "fs-sd2.0-v1";
  assert.ok(LWAIGC_VIDEO_MODELS.includes(model));
  assert.ok(FALLBACK_MODELS.lwaigc.includes(model));
  assert.deepEqual(lwaigcCapability(model), lwaigcCapability("dbb-sd2.0-v2"));
  assert.deepEqual(capabilityFor({ adapter: "lwaigc", model }).resolutions, ["720p"]);
  assert.equal(sdVersionForProfile({ adapter: "lwaigc", model }), "sd20");
  for (let duration = 4; duration <= 15; duration++) assert.equal(lwaigcLimitIssue(model, [], duration), "");
  for (const duration of [3, 16, 30]) assert.match(lwaigcLimitIssue(model, [], duration), /不支持/);
  const input = { prompt: "人物自然转身", duration: 10, resolution: "720p", aspectRatio: "9:16",
    materials: ["image", "video", "audio"].map((kind) => ({ kind, url: `https://cdn.example.com/${kind}` })) };
  const payload = lwaigcVideoPayload(model, input, "stable-task-id");
  assert.deepEqual(payload, { ...lwaigcVideoPayload("dbb-sd2.0-v2", input, "stable-task-id"), model });
  assert.equal(payload.seconds, 10);
  assert.equal(payload.client_task_id, "stable-task-id");
  assert.equal("resolution" in payload, false);
  assert.equal("duration" in payload, false);
});
