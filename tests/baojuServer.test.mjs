import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as catalog from "../src/baojuCatalog.js";
import { requiresOriginalTaskKey, directTaskContentPaths, shouldRejectUnfinishedVideo } from "../src/taskContent.js";
import { pollDelayForAdapter } from "../src/providerCatalog.js";
import { normalizedTaskProgress } from "../src/taskProgress.js";
import { taskFailureDetails } from "../src/upstreamTaskFailure.js";
import { PANDA626_BASE_URL, seedanceVideoRetryDelay } from "../src/seedanceVideoCatalog.js";
import { seedanceSubmissionJournal } from "../src/seedanceSubmissionRecovery.js";

const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
function section(start, end) {
  const offset = source.indexOf(start);
  const stop = source.indexOf(end, offset);
  assert.ok(offset >= 0 && stop > offset, `Missing server section: ${start}`);
  return source.slice(offset, stop);
}
const config = { adapter: "baoju", baseUrl: catalog.BAOJU_BASE_URL, apiKey: "bj_live_mock_secret", model: "opaque-model", mediaUploadUrl: "" };
const capability = { duration_seconds: { minimum: 4, maximum: 30, default: 15 }, aspect_ratios: ["16:9", "9:16"], resolutions: ["720p"], references: { image: { maximum: 15 }, video: { maximum: 15 }, audio: { maximum: 15 } } };
const modelsBody = { data: [{ id: config.model, name: "Mock video model", capabilities: capability }] };
const input = { prompt: "保持人物一致，镜头缓慢推进", duration: 15, resolution: "720p", aspectRatio: "9:16", seed: 123, syncAudio: true, materials: [{ kind: "image", url: "https://assets.example/character.png" }, { kind: "video", url: "https://assets.example/motion.mp4" }, { kind: "audio", url: "https://assets.example/voice.wav" }] };
const error = (status, message) => Object.assign(new Error(message), { status });
function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function sandbox(overrides = {}) {
  const journal = [];
  const journalPaths = [];
  const delays = [];
  const context = vm.createContext({
    ...catalog, PANDA626_BASE_URL, seedanceVideoRetryDelay, seedanceSubmissionJournal, requiresOriginalTaskKey,
    FormData, Blob, Buffer, URL, Number, String, Date, Promise, Map, TextEncoder, path,
    crypto: { randomUUID: () => "12345678-1234-4123-8123-123456789abc" }, dataDir: "mock-data",
    appendFileSync: (file, record) => { journalPaths.push(file); journal.push(JSON.parse(record)); },
    apiKeyFingerprint: () => "mock-fingerprint", normalizeApiKey: (value) => String(value || "").trim(),
    authHeaders: (provider, extra = {}) => ({ Authorization: `Bearer ${provider.apiKey}`, ...extra }),
    httpError: error, friendlyUpstreamError: (value) => String(value),
    setTimeout: (resolve, delay) => { delays.push(delay); resolve(); },
    normalizedTaskProgress, taskFailureDetails, completedVideoUrls: new Map(),
    ...overrides,
  });
  vm.runInContext(section("function isPrivateHost", "function inferAdapter") + section("async function readJson", "function fallbackModels") + section("function normalizeStatus", "function imageUrlsFrom"), context);
  return { context, journal, journalPaths, delays };
}
function creation(post) {
  const calls = [];
  const state = sandbox({ upstream: async (url, options = {}) => {
    calls.push([String(url), options]);
    if (String(url).endsWith("/api/v1/models")) return response(modelsBody);
    assert.equal(options.method, "POST", `Unexpected request: ${url}`);
    return post(url, options);
  } });
  vm.runInContext(section("async function createBaojuVideo", "async function createHuajingVideo"), state.context);
  return { ...state, calls, posts: () => calls.filter(([, options]) => options.method === "POST") };
}

test("Baoju providerConfig recognizes its host and keeps the documented API origin", () => {
  const state = sandbox();
  vm.runInContext(section("function inferAdapter", "function authHeaders"), state.context);
  const headers = { "x-api-base-url": `${config.baseUrl}/api/v1`, "x-api-key": config.apiKey, "x-api-model": config.model };
  const result = state.context.providerConfig({ get: (key) => headers[key] });
  assert.equal(result.baseUrl, config.baseUrl);
  assert.equal(result.adapter, "baoju");
  assert.equal(result.mediaUploadUrl, "", "the API documents public URLs, not an invented native upload endpoint");
  assert.equal(result.apiKey, config.apiKey);
});

test("Baoju account permission checks allow another account key without bypassing provider identity", () => {
  const state = sandbox();
  vm.runInContext(section("function verifyJobConfig", "async function pollJob"), state.context);
  const job = { adapter: config.adapter, baseUrl: config.baseUrl, apiKeyFingerprint: "another-key" };
  assert.doesNotThrow(() => state.context.verifyJobConfig(config, job));
  assert.throws(() => state.context.verifyJobConfig(config, { ...job, baseUrl: "https://other.example" }), (caught) => caught.status === 400);
  assert.throws(() => state.context.verifyJobConfig(config, { ...job, adapter: "newapi" }), (caught) => caught.status === 400);
});

test("Baoju creation fetches dynamic capabilities, journals the exact paid request, and stores only body.id", async () => {
  let state;
  state = creation(async (_url, options) => {
    assert.ok(state.journal.length > 0, "journal must be persisted before a paid create request");
    assert.deepEqual(state.journal[0].request, JSON.parse(options.body));
    return response({ id: "public-task-id", task_id: "not-the-task", request_id: "trace-only", status: "queued", result_state: "pending" }, 202);
  });
  const job = await state.context.createBaojuVideo(config, input);
  assert.equal(state.calls[0][0], `${config.baseUrl}/api/v1/models`);
  const [url, options] = state.posts()[0];
  assert.equal(url, `${config.baseUrl}/api/v1/videos`);
  assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
  assert.ok(options.headers["Idempotency-Key"]);
  assert.deepEqual(JSON.parse(options.body), { model: config.model, prompt: input.prompt, duration_seconds: 15, aspect_ratio: "9:16", resolution: "720p", image_urls: [input.materials[0].url], video_urls: [input.materials[1].url], audio_urls: [input.materials[2].url] });
  assert.equal(job.taskId, "public-task-id");
  assert.equal(job.statusPath, "/api/v1/videos/public-task-id");
  assert.equal(job.contentPath, "/api/v1/videos/public-task-id/content?index=0");
  assert.ok(state.journalPaths.every((file) => file.endsWith("baoju-video-submissions.jsonl")));
  assert.equal(state.journal.at(-1).taskId, "public-task-id");
  assert.ok(!JSON.stringify(state.journal).includes(config.apiKey));
});

test("Baoju forwards a pre-persisted client idempotency key without adding private fields to JSON", async () => {
  const key = "dfadbeaf-1234-4123-8123-123456789abc";
  const state = creation(async (_url, options) => {
    assert.equal(options.headers["Idempotency-Key"], key);
    assert.equal(JSON.parse(options.body).clientSubmissionKey, undefined);
    return response({ id: "original-task", status: "queued" });
  });
  await state.context.createBaojuVideo(config, { ...input, clientSubmissionKey: key });
  assert.equal(state.journal[0].idempotencyKey, key);
});

for (const [label, retryResponse] of [
  ["network disconnection", () => { throw new TypeError("fetch failed"); }],
  ["HTTP 408", () => response({ error: { code: "timeout", message: "wait" } }, 408)],
  ["HTTP 429", () => response({ error: { code: "rate_limit", message: "wait" } }, 429, { "Retry-After": "7" })],
  ["HTTP 500", () => response({ error: { code: "temporary", message: "wait" } }, 500)],
  ["HTTP 503", () => response({ error: { code: "temporary", message: "wait" } }, 503)],
  ["HTTP 409 request_in_progress", () => response({ error: { code: "request_in_progress", message: "wait", retryable: true } }, 409)],
]) {
  test(`Baoju ${label} retries with the same key and byte-identical body`, async () => {
    let attempts = 0;
    const state = creation(async () => ++attempts === 1 ? retryResponse() : response({ id: "existing-task", status: "queued" }));
    const job = await state.context.createBaojuVideo(config, input);
    assert.equal(job.taskId, "existing-task");
    assert.equal(attempts, 2);
    assert.equal(state.posts()[0][1].headers["Idempotency-Key"], state.posts()[1][1].headers["Idempotency-Key"]);
    assert.equal(state.posts()[0][1].body, state.posts()[1][1].body);
    assert.ok(!JSON.stringify(state.journal).includes(config.apiKey));
  });
}

test("Baoju repeated network loss stops at three identical paid attempts and reports unknown rather than failed", async () => {
  const state = creation(async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(state.context.createBaojuVideo(config, input), (caught) => caught.submissionUnknown === true);
  assert.equal(state.posts().length, 3);
  assert.equal(new Set(state.posts().map(([, options]) => options.headers["Idempotency-Key"])).size, 1);
  assert.equal(new Set(state.posts().map(([, options]) => options.body)).size, 1);
  assert.ok(state.journal.length > 0);
  assert.ok(!state.journal.at(-1).taskId);
});

for (const status of [400, 401, 402, 403, 422]) {
  test(`Baoju HTTP ${status} rejection is not automatically retried`, async () => {
    const state = creation(async () => response({ error: { code: "rejected", message: "known rejection", retryable: false } }, status));
    await assert.rejects(state.context.createBaojuVideo(config, input), (caught) => caught.status === status && !caught.submissionUnknown);
    assert.equal(state.posts().length, 1);
  });
}

test("Baoju explicit non-retryable request_in_progress never automatically replays", async () => {
  const state = creation(async () => response({ error: { code: "request_in_progress", message: "stop replay", retryable: false } }, 409));
  await assert.rejects(state.context.createBaojuVideo(config, input));
  assert.equal(state.posts().length, 1);
});

test("Baoju success without body.id cannot substitute trace IDs or claim safe failure", async () => {
  const state = creation(async () => response({ task_id: "alternate-id", request_id: "trace-only", status: "queued" }, 202));
  await assert.rejects(state.context.createBaojuVideo(config, input), (caught) => caught.submissionUnknown === true);
  assert.equal(state.posts().length, 1);
  assert.ok(state.journal.every((row) => !row.taskId));
});

test("Baoju rejects an oversized JSON request before paid POST or journal append", async () => {
  const state = creation(async () => response({ id: "must-not-submit" }));
  const materials = ["image", "video", "audio"].flatMap((kind) => Array.from({ length: 15 }, (_, index) => ({ kind, url: `https://assets.example/${kind}/${index}/${"x".repeat(7000)}` })));
  await assert.rejects(state.context.createBaojuVideo(config, { ...input, materials }), (caught) => [400, 413].includes(caught.status) && !caught.submissionUnknown);
  assert.equal(state.posts().length, 0);
  assert.equal(state.journal.length, 0);
});

test("Baoju polling keeps succeeded/retrieving in progress and respects poll_after_seconds", async () => {
  const state = sandbox({ upstream: async (url, options) => {
    assert.equal(String(url), `${config.baseUrl}/api/v1/videos/original-task`);
    assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
    return response({ id: "original-task", status: "succeeded", result_state: "retrieving", progress: 100, poll_after_seconds: 13, output: [{ content_url: "/api/v1/videos/original-task/content?index=0" }] });
  } });
  vm.runInContext(section("async function pollJob", "function streamResponse"), state.context);
  const result = await state.context.pollJob(config, { taskId: "original-task", statusPath: "/api/v1/videos/original-task" });
  assert.equal(result.status, "processing");
  assert.ok(result.progress < 100);
  assert.ok(!result.videoUrl);
  assert.equal(result.retryAfterMs, 13_000);
  assert.equal(state.context.completedVideoUrls.size, 0);
  assert.equal(pollDelayForAdapter("baoju"), 5_000);
});

test("Baoju polling reports only ready media complete and preserves failed or expired terminal state", async () => {
  const bodies = [
    { id: "original-task", status: "succeeded", result_state: "ready", output: [{ content_url: "/api/v1/videos/original-task/content?index=0" }] },
    { id: "original-task", status: "failed", error: { message: "material rejected", code: "invalid_material" } },
    { id: "original-task", status: "succeeded", result_state: "expired" },
  ];
  const state = sandbox({ upstream: async () => response(bodies.shift()) });
  vm.runInContext(section("async function pollJob", "function streamResponse"), state.context);
  const job = { taskId: "original-task", statusPath: "/api/v1/videos/original-task" };
  const ready = await state.context.pollJob(config, job);
  assert.equal(ready.status, "completed");
  assert.equal(ready.progress, 100);
  assert.equal(ready.videoUrl, `${config.baseUrl}/api/v1/videos/original-task/content?index=0`);
  const failed = await state.context.pollJob(config, job);
  assert.equal(failed.status, "failed");
  assert.equal(taskFailureDetails(failed.body).reason, "material rejected");
  const expired = await state.context.pollJob(config, job);
  assert.equal(expired.status, "failed");
  assert.equal(expired.body.autoRetryBlocked, true);
});

function contentRoute(upstream, overrides = {}) {
  let handler;
  const streamed = [];
  const verified = [];
  const state = sandbox({
    app: { get: (_route, callback) => { handler = callback; } }, upstream,
    decodeJob: () => ({ adapter: "baoju", baseUrl: config.baseUrl, taskId: "original-task", statusPath: "/api/v1/videos/original-task", contentPath: "/api/v1/videos/original-task/content?index=0" }),
    providerConfig: () => config,
    verifyJobConfig: (provider, job) => verified.push([provider, job]),
    recoveredFmgoVideoUrl: () => null, directTaskContentPaths, shouldRejectUnfinishedVideo,
    sameSiteHost: (left, right) => left.hostname === right.hostname,
    streamResponse: (incoming) => streamed.push(incoming),
    ...overrides,
  });
  vm.runInContext(section('app.get("/api/tasks/:id/content"', 'if (!process.argv.includes("--api-only"))'), state.context);
  return { streamed, verified, run: () => handler({ params: { id: "signed-task-token" }, query: {}, get: (header) => header === "range" ? "bytes=0-99" : undefined }, {}, (caught) => { throw caught; }) };
}

test("Baoju media download verifies task identity and sends Range and Key only to the first content request", async () => {
  const calls = [];
  const signed = "https://cdn.example/rendered.mp4?expires=1800000000&signature=keep-me";
  const route = contentRoute(async (url, options) => {
    calls.push([String(url), options]);
    return calls.length === 1
      ? new Response(null, { status: 307, headers: { Location: signed } })
      : new Response("mock video bytes", { status: 206, headers: { "content-type": "video/mp4" } });
  });
  await route.run();
  assert.equal(route.verified.length, 1);
  assert.equal(calls[0][0], `${config.baseUrl}/api/v1/videos/original-task/content?index=0`);
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${config.apiKey}`);
  assert.equal(calls[0][1].redirect, "manual");
  assert.equal(calls[1][0], signed);
  for (const [, options] of calls) assert.equal(options.headers.Range, "bytes=0-99");
  assert.equal(calls[1][1].headers.Authorization, undefined);
  assert.ok(calls.every(([, options]) => options.headers.Cookie === undefined));
  assert.equal(route.streamed.length, 1);
});

test("Baoju also strips credentials from a same-origin media redirect", async () => {
  const calls = [];
  const route = contentRoute(async (url, options) => {
    calls.push([String(url), options]);
    return calls.length === 1
      ? new Response(null, { status: 307, headers: { Location: "/signed/media.mp4?signature=keep-me" } })
      : new Response("mock video", { headers: { "content-type": "video/mp4" } });
  });
  await route.run();
  assert.equal(calls[1][0], `${config.baseUrl}/signed/media.mp4?signature=keep-me`);
  assert.equal(calls[1][1].headers.Authorization, undefined);
  assert.equal(route.streamed.length, 1);
});

for (const location of ["http://127.0.0.1/private.mp4", "http://192.168.1.1/private.mp4", "file:///private.mp4", "javascript:alert(1)"]) {
  test(`Baoju rejects unsafe media redirect ${location}`, async () => {
    let calls = 0;
    const route = contentRoute(async () => { calls += 1; return new Response(null, { status: 307, headers: { Location: location } }); });
    await assert.rejects(route.run());
    assert.equal(calls, 1);
    assert.equal(route.streamed.length, 0);
  });
}

test("Baoju download follows no more than three redirects", async () => {
  const calls = [];
  const route = contentRoute(async (url, options) => {
    calls.push([String(url), options]);
    return new Response(null, { status: 307, headers: { Location: `https://cdn.example/hop-${calls.length}.mp4` } });
  });
  await assert.rejects(route.run());
  assert.ok(calls.length <= 4);
  assert.ok(calls.slice(1).every(([, options]) => !options.headers.Authorization));
  assert.equal(route.streamed.length, 0);
});

for (const status of [200, 202, 409, 503]) {
  test(`Baoju HTTP ${status} JSON is never streamed or marked as a successful video download`, async () => {
    const route = contentRoute(async () => response({ error: { code: "result_not_ready", message: "result is still retrieving" } }, status));
    await assert.rejects(route.run(), (caught) => status !== 503 || caught.status === 503 && /still retrieving/.test(caught.message));
    assert.equal(route.streamed.length, 0);
  });
}

test("Baoju content requires current account authentication rather than treating a task token as public media", async () => {
  let calls = 0;
  const route = contentRoute(async () => { calls += 1; return new Response("must not fetch"); }, { providerConfig: () => { throw error(401, "API Key required"); } });
  await assert.rejects(route.run(), (caught) => caught.status === 401);
  assert.equal(calls, 0);
  assert.equal(route.streamed.length, 0);
});

const originalSubmission = () => ({
  idempotencyKey: "87654321-1234-4123-8123-123456789abc",
  state: "unknown", baseUrl: config.baseUrl, model: "original-model",
  apiKeyFingerprint: "mock-fingerprint", createdAt: "2026-10-20T01:00:00.000Z",
  request: { model: "original-model", prompt: "原始提示词不可更换", duration_seconds: 10, aspect_ratio: "16:9", resolution: "720p", image_urls: ["https://assets.example/original.png?signature=unchanged"] },
});
function recoveryState(original, request) {
  const calls = [];
  let state;
  state = sandbox({
    existsSync: () => true,
    readFileSync: () => [original, ...state.journal].map((row) => JSON.stringify(row)).join("\n"),
    upstream: async (url, options = {}) => { calls.push([String(url), options]); return request(url, options); },
  });
  vm.runInContext(section("async function createBaojuVideo", "async function createHuajingVideo") + section("async function pollJob", "function streamResponse"), state.context);
  return { ...state, calls };
}

test("Baoju unknown submission recovery replays its original snapshot without model discovery or new request parameters", async () => {
  const original = originalSubmission();
  const state = recoveryState(original, async (url, options) => {
    assert.equal(String(url), `${config.baseUrl}/api/v1/videos`);
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
    assert.equal(options.headers["Idempotency-Key"], original.idempotencyKey);
    assert.equal(options.body, JSON.stringify(original.request));
    return response({ id: "original-upstream-id", model: original.model, status: "succeeded", result_state: "ready", output: [{ content_url: "/api/v1/videos/original-upstream-id/content?index=0" }] });
  });
  const [result] = await state.context.recoverBaojuSubmissions({ ...config, model: "different-current-model" }, [original.idempotencyKey]);
  assert.equal(state.calls.length, 1);
  assert.equal(result.job.taskId, "original-upstream-id");
  assert.equal(result.job.model, original.model);
  assert.equal(result.job.status, "completed");
  assert.equal(result.submittedPrompt, original.request.prompt);
  assert.equal(result.parameters.duration, original.request.duration_seconds);
  assert.equal(result.parameters.ratio, original.request.aspect_ratio);
  assert.equal(state.journal.at(-1).taskId, "original-upstream-id");
  assert.ok(!JSON.stringify(state.journal).includes(config.apiKey));
});

test("Baoju unknown submission with another Key fingerprint never replays or fetches a replacement model", async () => {
  const original = { ...originalSubmission(), apiKeyFingerprint: "different-account-key" };
  const state = recoveryState(original, async () => { throw new Error("must not call upstream"); });
  const [result] = await state.context.recoverBaojuSubmissions(config, [original.idempotencyKey]);
  assert.equal(state.calls.length, 0);
  assert.equal(result.job, undefined);
  assert.match(result.reason, /原 API Key/);
  assert.equal(state.journal.length, 0);
});

test("Baoju recovery honors a pending Retry-After window without another upstream request", async () => {
  const original = { ...originalSubmission(), nextRecoveryAt: Date.now() + 60000 };
  const state = recoveryState(original, async () => { throw new Error("must wait before requesting"); });
  const [result] = await state.context.recoverBaojuSubmissions(config, [original.idempotencyKey]);
  assert.equal(state.calls.length, 0);
  assert.match(result.reason, /Retry-After/);
});

test("Baoju immediate failure exposes a plain-text reason instead of an error object", async () => {
  const state = creation(async () => response({ id: "failed-task", status: "failed", result_state: "failed", error: { code: "invalid_material", message: "参考图片无效" } }));
  const job = await state.context.createBaojuVideo(config, input);
  assert.equal(job.error, "参考图片无效");
});

test("Baoju malformed id is not journaled as an accepted task", async () => {
  const state = creation(async () => response({ id: { id: "not-a-string" }, status: "queued" }));
  await assert.rejects(state.context.createBaojuVideo(config, input), (caught) => caught.submissionUnknown === true);
  assert.ok(state.journal.every((row) => row.state !== "accepted"));
});

for (const [label, properties] of [["explicit stopReplay", { stopReplay: true }], ["rejected state", { state: "rejected" }]]) {
  test(`Baoju ${label} blocks recovery replay without calling the upstream`, async () => {
    const original = { ...originalSubmission(), ...properties };
    const state = recoveryState(original, async () => { throw new Error("must not call upstream"); });
    const [result] = await state.context.recoverBaojuSubmissions(config, [original.idempotencyKey]);
    assert.equal(state.calls.length, 0);
    assert.equal(result.job, undefined);
    assert.match(result.reason, /明确拒绝|停止重试/);
    assert.equal(state.journal.length, 0);
  });
}

test("Baoju accepted task recovery only queries its saved task ID and lets upstream authorize the account's new Key", async () => {
  const original = { ...originalSubmission(), state: "accepted", taskId: "already-accepted", apiKeyFingerprint: "old-key-fingerprint" };
  const current = { ...config, apiKey: "bj_live_new_account_key", model: "current-other-model" };
  const state = recoveryState(original, async (url, options) => {
    assert.equal(String(url), `${config.baseUrl}/api/v1/videos/already-accepted`);
    assert.equal(options.method || "GET", "GET");
    assert.equal(options.headers.Authorization, `Bearer ${current.apiKey}`);
    assert.equal(options.headers["Idempotency-Key"], undefined);
    return response({ id: "already-accepted", status: "succeeded", result_state: "ready", output: [{ content_url: "/api/v1/videos/already-accepted/content?index=0" }] });
  });
  const [result] = await state.context.recoverBaojuSubmissions(current, [original.idempotencyKey]);
  assert.equal(state.calls.length, 1);
  assert.equal(result.job.taskId, original.taskId);
  assert.equal(result.job.model, original.model);
  assert.equal(result.job.status, "completed");
  assert.equal(state.journal.length, 0);
});

test("Baoju expired creation and both recovery paths retain autoRetryBlocked", async () => {
  const expired = { id: "expired-original", status: "succeeded", result_state: "expired" };
  const created = creation(async () => response(expired));
  const createdJob = await created.context.createBaojuVideo(config, input);
  assert.equal(createdJob.status, "failed");
  assert.equal(createdJob.autoRetryBlocked, true);
  for (const properties of [{}, { state: "accepted", taskId: expired.id }]) {
    const original = { ...originalSubmission(), ...properties };
    const restored = recoveryState(original, async () => response(expired));
    const [result] = await restored.context.recoverBaojuSubmissions(config, [original.idempotencyKey]);
    assert.equal(result.job.taskId, expired.id);
    assert.equal(result.job.status, "failed");
    assert.equal(result.job.autoRetryBlocked, true);
    assert.match(String(result.job.error), /过期/);
  }
});

for (const body of [{ error: { code: "temporary", message: "stop", retryable: false } }, { retryable: false, error: { code: "temporary", message: "stop" } }]) {
  test(`Baoju HTTP 503 ${body.retryable === false ? "top-level" : "error-level"} retryable=false blocks paid replay`, async () => {
    const state = creation(async () => response(body, 503));
    await assert.rejects(state.context.createBaojuVideo(config, input), (caught) => caught.submissionUnknown === true);
    assert.equal(state.posts().length, 1);
    assert.equal(state.journal.at(-1).stopReplay, true);
  });
}
