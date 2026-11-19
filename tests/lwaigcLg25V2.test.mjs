import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { LWAIGC_VIDEO_MODELS, lwaigcCapability, lwaigcLimitIssue, lwaigcSelectedResolution, lwaigcVideoPayload } from "../src/lwaigcCatalog.js";
import { capabilityFor, FALLBACK_MODELS, migrateSavedProfile, sdVersionForProfile } from "../src/providerCatalog.js";

const model = "lg-sd2.5-v2";
const input = { prompt: "人物自然转身", duration: 30, resolution: "1080p", aspectRatio: "9:16", materials: [
  { kind: "image", url: "https://assets.example/reference.png" },
  { kind: "video", url: "https://assets.example/reference.mp4" },
  { kind: "audio", url: "https://assets.example/reference.wav" },
] };
const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}

// PDF 2026-11-19，第 2 页模型表、第 5 页 3.2：用户选择，不是 auto，也不是固定 720p。
test("LWAIGC LG SD2.5 V2 is selectable with all four documented resolutions and 30/10/10 limits", () => {
  assert.ok(LWAIGC_VIDEO_MODELS.includes(model));
  assert.ok(FALLBACK_MODELS.lwaigc.includes(model));
  const profile = { adapter: "lwaigc", model };
  const cap = capabilityFor(profile);
  assert.equal(sdVersionForProfile(profile), "sd25");
  assert.equal(cap._capabilityUnverified, undefined);
  assert.deepEqual(cap.resolutions, ["480p", "720p", "1080p", "4k"]);
  assert.deepEqual([cap.images, cap.videos, cap.audios], [30, 10, 10]);
  assert.deepEqual(cap.durations, Array.from({ length: 27 }, (_, i) => i + 4));
  const refs = ["image", "video", "audio"].flatMap((kind, i) => Array.from({ length: [30, 10, 10][i] }, () => ({ kind })));
  assert.equal(lwaigcLimitIssue(model, refs, 30), "");
  for (const kind of ["image", "video", "audio"]) assert.match(lwaigcLimitIssue(model, [...refs, { kind }], 30), /参考最多/);
  for (const duration of [3, 31, 4.5]) assert.match(lwaigcLimitIssue(model, [], duration), /不支持/);
});

test("LG V2 explicitly serializes the selected resolution using the unified video protocol", () => {
  for (const resolution of ["480p", "720p", "1080p", "4k"]) {
    const payload = lwaigcVideoPayload(model, { ...input, resolution }, "stable-client-task");
    assert.deepEqual(payload, {
      model, client_task_id: "stable-client-task", prompt: input.prompt, seconds: 30, aspect_ratio: "9:16", resolution,
      image_urls: [input.materials[0].url], video_urls: [input.materials[1].url], audio_urls: [input.materials[2].url],
    });
    const textOnly = lwaigcVideoPayload(model, { ...input, resolution, materials: [] }, "text-only");
    for (const key of ["duration", "size", "images", "video_urls", "audio_urls", "image_urls"]) assert.equal(key in textOnly, false, key);
  }
});

test("LG V2 rejects absent/invalid resolutions instead of omitting or silently replacing them", () => {
  for (const resolution of [undefined, null, "", "auto", "2K", "2160p", "1080pp"]) {
    assert.throws(() => lwaigcVideoPayload(model, { ...input, resolution }, "stable"), (error) => error.status === 400 && /480p、720p、1080p 或 4k/.test(error.message));
  }
  assert.equal(lwaigcSelectedResolution(model, " 4K "), "4k");
  assert.equal(lwaigcSelectedResolution(model, "1080P"), "1080p");
  assert.equal(lwaigcVideoPayload(model, { ...input, resolution: "4K" }, "stable").resolution, "4k");
  // 旧模型与未知通道不被这个适配扩大／重写。
  assert.deepEqual(lwaigcCapability("lg-sd2.5-v1").resolutions, ["480p", "720p", "1080p"]);
  assert.equal(lwaigcVideoPayload("lg-sd2.5-v1", input, "old").resolution, "1080p");
  assert.equal("resolution" in lwaigcVideoPayload("mf-sd2.5-v2", input, "fixed"), false);
  assert.equal("resolution" in lwaigcVideoPayload("future-model", input, "unknown"), false);
  assert.equal(lwaigcSelectedResolution("some-other-model", "opaque-value"), "opaque-value");
});

test("a saved generic profile on the LWAIGC official host migrates to its unified adapter", () => {
  const profile = migrateSavedProfile({ id: "custom", adapter: "newapi", model, baseUrl: "https://ai.lwaigc.cn/v1" });
  assert.equal(profile.adapter, "lwaigc");
  assert.equal(profile.model, model);
  assert.deepEqual(capabilityFor(profile).resolutions, ["480p", "720p", "1080p", "4k"]);
});

test("server creation posts LG V2 resolution to /v1/videos and keeps stable idempotency for retries", async () => {
  const calls = [];
  const context = vm.createContext({
    lwaigcVideoPayload, crypto: { randomUUID: () => "test-client-id" },
    authHeaders: (config, headers) => ({ ...headers, Authorization: `Bearer ${config.apiKey}` }),
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    friendlyUpstreamError: (message) => String(message),
    upstream: async (url, options) => {
      calls.push([url, options]);
      if (calls.length === 1) throw new Error("mock response lost");
      return new Response(JSON.stringify({ id: "relay_video_mock", task_id: "relay_video_mock", status: "queued" }), { status: 202 });
    },
  });
  vm.runInContext(section("async function readJson", "function fallbackModels") + section("function taskIdFrom", "function normalizeStatus") + section("async function createLwaigc", "async function createBaojuVideo"), context);
  const job = await context.createLwaigc({ adapter: "lwaigc", model, baseUrl: "https://ai.lwaigc.cn", apiKey: "mock-only" }, { ...input, resolution: "4K" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "https://ai.lwaigc.cn/v1/videos");
  assert.equal(calls[0][1].body, calls[1][1].body);
  assert.equal(JSON.parse(calls[0][1].body).resolution, "4k");
  assert.equal(calls[0][1].headers["Idempotency-Key"], JSON.parse(calls[0][1].body).client_task_id);
  assert.equal(job.taskId, "relay_video_mock");
  assert.equal(job.statusPath, "/v1/videos/relay_video_mock");
});

test("the task route validates LG V2 resolution before uploading materials and preserves its canonical value", () => {
  const validation = section('    const lwaigcResolution = config.adapter === "lwaigc"', '    const quantity = safeNumber(req.body.quantity');
  assert.ok(validation.indexOf("lwaigcSelectedResolution(config.model, req.body.resolution)") < validation.indexOf("await prepareMaterials"));
  assert.match(validation, /resolution: lwaigcResolution \?\?/);
});

test("LG V2 keeps the unified task query path and maps documented states without a model-specific poll adapter", async () => {
  const replies = [
    { task_id: "relay_video_mock", status: "in_progress", relay_state: "polling", progress: 47, retry_after_ms: 6000 },
    { task_id: "relay_video_mock", status: "completed", relay_state: "completed", progress: 100 },
    { task_id: "relay_video_mock", status: "failed", error: { message: "mock failure" } },
  ];
  const urls = [];
  const context = vm.createContext({
    authHeaders: () => ({}),
    readJson: (response) => response.json(),
    normalizedTaskProgress: (status, progress) => status === "completed" ? 100 : progress,
    videoUrlFrom: () => null,
    upstream: async (url) => { urls.push(url); return new Response(JSON.stringify(replies.shift())); },
  });
  vm.runInContext(section("function normalizeStatus", "function videoUrlsFrom") + section("async function pollJob", "function streamResponse"), context);
  const config = { adapter: "lwaigc", baseUrl: "https://ai.lwaigc.cn", model };
  const job = { taskId: "relay_video_mock", statusPath: "/v1/videos/relay_video_mock" };
  assert.equal((await context.pollJob(config, job)).status, "processing");
  assert.equal((await context.pollJob(config, job)).status, "completed");
  assert.equal((await context.pollJob(config, job)).status, "failed");
  assert.deepEqual(urls, Array(3).fill("https://ai.lwaigc.cn/v1/videos/relay_video_mock"));
});
