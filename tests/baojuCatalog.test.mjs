import assert from "node:assert/strict";
import test from "node:test";
import { BAOJU_BASE_URL, baojuCapability, baojuModels, baojuPayload, baojuInputIssue, baojuTaskResult } from "../src/baojuCatalog.js";

const cap = {
  duration_seconds: { minimum: 4, maximum: 30, default: 15 },
  aspect_ratios: ["16:9", "9:16"], resolutions: ["720p", "1080p"],
  references: { image: { maximum: 30 }, video: { maximum: 3 }, audio: { maximum: 0 } },
};
const input = { prompt: "@image1 主角自然走进画面", duration: 15, aspectRatio: "16:9", resolution: "720p", seed: 123, syncAudio: true, clientSubmissionKey: "stable-key", materials: [{ kind: "image", url: "https://cdn.example.com/image.png?signature=keep" }] };

test("BAOJU uses live model IDs unchanged including slashes and only published capabilities", () => {
  assert.equal(BAOJU_BASE_URL, "https://aimjbbb.cn");
  const catalog = baojuModels({ data: [{ id: "provider/seedance-2.5", name: "动态 2.5", capabilities: cap, billing: { mode: "per_second", credits_per_unit: 3 } }, { id: "provider/seedance-2.5" }, { id: "text-to-video" }, { name: "not-an-id" }] });
  assert.deepEqual(catalog.models, ["provider/seedance-2.5", "text-to-video"]);
  const live = catalog.capabilities["provider/seedance-2.5"];
  assert.equal(live.images, 15);
  assert.equal(live.videos, 3);
  assert.equal(live.audios, 0);
  assert.equal(live.defaultDuration, 15);
  assert.deepEqual(live.durations, Array.from({ length: 27 }, (_, index) => index + 4));
  assert.deepEqual(live.ratios, ["16:9", "9:16"]);
  assert.equal(live._sdVersion, "sd25");
  assert.equal(live._preserveLimits, true);
  assert.equal(live.seed, false);
  assert.equal(live.syncAudio, false);
  assert.match(catalog.labels["provider/seedance-2.5"], /3积分\/秒/);
});

test("unknown capabilities retain the API reference ceiling and allow text-only generation without guessed optional fields", () => {
  assert.deepEqual(baojuCapability().durations, []);
  assert.deepEqual(baojuCapability().resolutions, []);
  assert.deepEqual(baojuCapability().ratios, []);
  assert.equal(baojuCapability().images, 15);
  assert.equal(baojuCapability().videos, 15);
  assert.equal(baojuCapability().audios, 15);
  assert.deepEqual(baojuPayload("future/model", { ...input, materials: [] }), { model: "future/model", prompt: input.prompt });
  assert.deepEqual(baojuPayload("future/model", { ...input, materials: [] }, { duration_seconds: { allowed: [] } }), { model: "future/model", prompt: input.prompt });
  assert.equal(baojuInputIssue({}, { ...input, materials: [] }), "");
  assert.deepEqual(baojuCapability({ duration_seconds: { minimum: 1, maximum: 1e12 } }).durations, []);
});

test("resolution-specific billing entries use their own per-request or per-second mode", () => {
  const catalog = baojuModels({ data: [{ id: "model", billing: { mode: "per_request", credits_per_unit: 1, resolution_prices: [
    { resolution: "720p", mode: "per_second", unit: "second", credits_per_unit: 2 },
    { resolution: "1080p", mode: "per_request", unit: "request", credits_per_unit: 9 },
  ] } }] });
  assert.match(catalog.labels.model, /720p 2积分\/秒\/1080p 9积分\/次/);
});

test("request payload is a strict whitelist with native names and stable reference order", () => {
  assert.deepEqual(baojuPayload("provider/seedance-2.5", input, baojuCapability(cap)), {
    model: "provider/seedance-2.5", prompt: input.prompt,
    duration_seconds: 15, aspect_ratio: "16:9", resolution: "720p",
    image_urls: [input.materials[0].url],
  });
  assert.deepEqual(baojuPayload("x", { ...input, materials: [{ kind: "video", url: "https://cdn.example.com/a.mp4" }, { kind: "video", url: "https://cdn.example.com/b.mp4" }, { kind: "audio", url: "https://cdn.example.com/a.wav" }] }), {
    model: "x", prompt: input.prompt, video_urls: ["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"], audio_urls: ["https://cdn.example.com/a.wav"],
  });
  assert.deepEqual(baojuPayload("x", input, { duration_seconds: false, aspect_ratios: [], resolutions: [] }), { model: "x", prompt: input.prompt, image_urls: [input.materials[0].url] });
});

test("published duration choices, ranges and reference exclusions are enforced", () => {
  assert.match(baojuInputIssue(cap, { ...input, duration: 31 }), /时长/);
  assert.match(baojuInputIssue(cap, { ...input, duration: 4.5 }), /时长/);
  assert.match(baojuInputIssue({ duration_seconds: { minimum: 1, maximum: 1000 } }, { ...input, duration: 601 }), /600/);
  assert.match(baojuInputIssue({ ...cap, duration_seconds: { allowed: [5, 10] } }, input), /时长/);
  assert.deepEqual(baojuCapability({ duration_seconds: { allowed: [10, 5, 10] } }).durations, [5, 10]);
  assert.match(baojuInputIssue(cap, { ...input, aspectRatio: "1:1" }), /比例/);
  assert.match(baojuInputIssue(cap, { ...input, resolution: "480p" }), /分辨率/);
  assert.match(baojuInputIssue(cap, { ...input, materials: [{ kind: "audio", url: "https://cdn.example.com/audio.wav" }] }), /最多 0/);
  assert.match(baojuInputIssue(cap, { ...input, materials: Array.from({ length: 16 }, () => input.materials[0]) }), /最多 15/);
  assert.throws(() => baojuPayload("x", { ...input, duration: 31 }, cap), (error) => error.status === 400);
});

test("local paths, data URLs, credentials and private addresses cannot be sent as public material URLs", () => {
  for (const url of ["C:\\image.png", "blob:https://example.com/id", "data:image/png;base64,a", "http://localhost/a", "http://a.local/a", "http://192.168.1.2/a", "http://127.0.0.1/a", "http://2130706433/a", "http://10.0.0.1/a", "http://172.16.0.1/a", "http://169.254.169.254/a", "http://100.64.0.1/a", "http://[::1]/a", "http://[::ffff:127.0.0.1]/a", "http://[fd00::1]/a", "https://user:password@example.com/a"]) {
    assert.match(baojuInputIssue({}, { ...input, materials: [{ kind: "image", url }] }), /公网/, url);
  }
  assert.equal(baojuInputIssue({}, { ...input, materials: [{ kind: "image", url: "https://cdn.example.com/a.png?expires=123&signature=keep" }] }), "");
  assert.equal(baojuInputIssue({}, { ...input, materials: [{ kind: "image", url: "https://[2001:4860:4860::8888]/a.png" }] }), "");
  assert.match(baojuInputIssue({}, { ...input, materials: [{ kind: "image", url: `https://cdn.example.com/${"a".repeat(8192)}` }] }), /8192/);
});

test("Unicode prompt character limit and UTF-8 JSON body limit are separate", () => {
  assert.equal(baojuInputIssue({}, { ...input, prompt: "😀".repeat(50000), materials: [] }), "");
  assert.match(baojuInputIssue({}, { ...input, prompt: "😀".repeat(50001), materials: [] }), /50000/);
  assert.match(baojuInputIssue({}, { ...input, prompt: "   " }), /提示词/);
  const materials = ["image", "audio", "video"].flatMap((kind) => Array.from({ length: 15 }, () => ({ kind, url: `https://cdn.example.com/${"x".repeat(8000)}` })));
  assert.match(baojuInputIssue({}, { ...input, materials }), /256 KiB/);
});

test("remote generation success is not complete while results are still being retrieved", () => {
  for (const result_state of ["retrieving", "generating", undefined]) {
    const task = baojuTaskResult({ id: "task1", status: "succeeded", result_state, progress: 100, output: [{ content_url: "/api/v1/videos/task1/content?index=0" }], poll_after_seconds: 2 }, BAOJU_BASE_URL);
    assert.equal(task.status, "processing");
    assert.equal(task.progress, 99);
    assert.equal(task.videoUrl, "");
    assert.equal(task.retryAfterMs, 2000);
  }
  assert.equal(baojuTaskResult({ id: "task1", status: "queued" }).status, "queued");
});

test("ready completion requires an actual same-origin result URL with its signed parameters preserved", () => {
  const body = { id: "task/id", status: "succeeded", result_state: "ready", output: [{ content_url: "/api/v1/videos/task%2Fid/content?index=0&signature=keep" }] };
  const task = baojuTaskResult(body);
  assert.equal(task.status, "completed");
  assert.equal(task.progress, 100);
  assert.equal(task.videoUrl, `${BAOJU_BASE_URL}/api/v1/videos/task%2Fid/content?index=0&signature=keep`);
  for (const output of [[], [{ content_url: "https://attacker.example/video.mp4" }], [{ content_url: "//attacker.example/video.mp4" }], [{ content_url: "javascript:alert(1)" }], [{ content_url: "https://user:password@aimjbbb.cn/video" }]]) {
    assert.equal(baojuTaskResult({ ...body, output }).status, "processing");
    assert.equal(baojuTaskResult({ ...body, output }).videoUrl, "");
  }
});

test("failed, cancelled and expired tasks are terminal without a playable result", () => {
  for (const status of ["failed", "cancelled", "expired"]) {
    const task = baojuTaskResult({ id: "task1", status, error: "upstream failure", output: [{ content_url: "/content" }] });
    assert.equal(task.status, "failed");
    assert.equal(task.videoUrl, "");
    assert.ok(task.error.includes("upstream failure"));
  }
  assert.match(baojuTaskResult({ id: "task1", status: "succeeded", result_state: "expired" }).error, /已过期.*查询原任务.*不要重新生成/);
  assert.equal(baojuTaskResult({ id: "task1", status: "succeeded", result_state: "expired" }).retryable, false);
  assert.equal(baojuTaskResult({ id: "task1", status: "succeeded", result_state: "expired" }).autoRetryBlocked, true);
  for (const result_state of ["failed", "cancelled"]) assert.equal(baojuTaskResult({ id: "task1", status: "succeeded", result_state }).status, "failed");
  assert.throws(() => baojuTaskResult({ error: { message: "invalid API key" } }), /invalid API key/);
});
