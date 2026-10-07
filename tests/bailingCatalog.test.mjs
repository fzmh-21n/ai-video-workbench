import assert from "node:assert/strict";
import test from "node:test";

import { BAILING_BASE_URL, BAILING_EXAMPLE_MODEL, bailingModels, bailingVideoPayload } from "../src/bailingCatalog.js";
import { capabilityFor, inferAdapter, preferredDurationForVersion, profilesWithBuiltIns } from "../src/providerCatalog.js";
import { directTaskContentPaths } from "../src/taskContent.js";
import { taskFailureDetails } from "../src/upstreamTaskFailure.js";

test("adds Bailing without treating the example model as a fixed model name", () => {
  assert.equal(inferAdapter(BAILING_BASE_URL), "bailing");
  assert.equal(profilesWithBuiltIns([]).find((profile) => profile.id === "bailing")?.model, BAILING_EXAMPLE_MODEL);
  const capability = capabilityFor({ adapter: "bailing", model: "another-model" });
  assert.deepEqual(capability.resolutions, ["720p", "480p"]);
  assert.deepEqual(capability.ratios, ["16:9", "9:16", "1:1", "4:3", "3:4"]);
  assert.equal(preferredDurationForVersion(capability, "sd20"), 5);
});

test("maps all three reference types to Bailing's documented JSON fields", () => {
  assert.deepEqual(bailingVideoPayload("another-model", {
    prompt: "保持人物一致",
    duration: 5,
    aspectRatio: "16:9",
    resolution: "720p",
    materials: [
      { kind: "image", url: "https://example.com/a.png" },
      { kind: "video", url: "https://example.com/b.mp4" },
      { kind: "audio", url: "https://example.com/c.mp3" },
    ],
  }), {
    model: "another-model",
    prompt: "保持人物一致",
    duration: 5,
    aspect_ratio: "16:9",
    resolution: "720p",
    reference_images: ["https://example.com/a.png"],
    reference_videos: ["https://example.com/b.mp4"],
    reference_audios: ["https://example.com/c.mp3"],
  });
});

test("reads every distinct model returned by Bailing's authenticated model endpoint", () => {
  const data = Array.from({ length: 33 }, (_, index) => ({ id: `model-${index + 1}`, object: "model" }));
  assert.equal(bailingModels({ data }).length, 33);
  assert.deepEqual(bailingModels({ models: ["d1-min-c1", { name: "d1-min-c1" }, { id: "other" }] }), ["d1-min-c1", "other"]);
});

test("keeps Bailing's content route and nested failure reason", () => {
  assert.deepEqual(directTaskContentPaths("bailing", "task_123"), ["/v1/videos/task_123/content"]);
  assert.equal(taskFailureDetails({ data: { status: "failed", error: { message: "upstream failed" } } }).reason, "upstream failed");
});
