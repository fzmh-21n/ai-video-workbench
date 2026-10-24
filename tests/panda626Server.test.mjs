import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as catalog from "../src/seedanceVideoCatalog.js";
import { mediaUploadMode, requiresProviderAssetUpload } from "../src/uploadPolicy.js";
import { directTaskContentPaths, shouldRejectUnfinishedVideo } from "../src/taskContent.js";
import { normalizedTaskProgress } from "../src/taskProgress.js";
import { taskFailureDetails } from "../src/upstreamTaskFailure.js";
import * as recovery from "../src/seedanceSubmissionRecovery.js";

const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
function section(start, end) {
  const offset = source.indexOf(start);
  const stop = source.indexOf(end, offset);
  assert.ok(offset >= 0 && stop > offset, `Missing server section: ${start}`);
  return source.slice(offset, stop);
}
const config = { adapter: "seedancevideo", baseUrl: "https://panda626.com", apiKey: "mock-secret", mediaUploadKey: "mock-secret", model: "opaque-model", mediaUploadUrl: "https://panda626.com/v1/uploads/images" };
const input = { prompt: "人物自然转身", duration: 15, resolution: "1080pp", aspectRatio: "9:16", materials: [{ kind: "image", url: "https://assets.example/reference.png" }] };
const error = (status, message) => Object.assign(new Error(message), { status });
function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function sandbox(overrides = {}) {
  const journal = [];
  const delays = [];
  let now = Date.now();
  class MockDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    ...catalog, ...recovery, FormData, Blob, Buffer, URL, Number, String, Date: MockDate, Promise, Map, path,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" }, dataDir: "mock-data",
    appendFileSync: (_path, record) => journal.push(JSON.parse(record)),
    apiKeyFingerprint: () => "mock-fingerprint", authHeaders: (provider, extra = {}) => ({ Authorization: `Bearer ${provider.apiKey}`, ...extra }),
    httpError: error, friendlyUpstreamError: (value) => String(value),
    setTimeout: (resolve, delay) => { delays.push(delay); now += delay; resolve(); },
    normalizeApiKey: (value) => String(value || "").trim(),
    baseUrl: (value) => new URL(value).origin, publicUrl: (value) => new URL(value),
    fileBytes: (file) => file.buffer, cosConfig: () => null, mediaUploadMode, requiresProviderAssetUpload,
    writeDiagnostic: () => {}, signedUrlExpiresAt: () => null,
    normalizedTaskProgress, taskFailureDetails, completedVideoUrls: new Map(), ...overrides,
  });
  vm.runInContext(section("async function readJson", "function fallbackModels") + section("function normalizeStatus", "function imageUrlsFrom"), context);
  return { context, journal, delays };
}
function creation(upstream) {
  const result = sandbox({ upstream });
  vm.runInContext(section("async function createSeedanceVideo", "function isFmgoFeimiaoChatModel"), result.context);
  return result;
}

test("Panda providerConfig keeps its own host and official image upload path", () => {
  const { context } = sandbox();
  vm.runInContext(section("function inferAdapter", "function authHeaders"), context);
  const headers = { "x-api-base-url": "https://panda626.com/api", "x-api-key": config.apiKey, "x-api-model": "opaque-model" };
  const result = context.providerConfig({ get: (key) => headers[key] });
  assert.equal(result.baseUrl, "https://panda626.com");
  assert.equal(result.adapter, "seedancevideo");
  assert.equal(result.mediaUploadUrl, "https://panda626.com/v1/uploads/images");
  assert.equal(result.apiKey, "mock-secret");
  const legacy = context.providerConfig({ get: (key) => ({ ...headers, "x-api-base-url": "https://772808.xyz", "x-api-adapter": "seedancevideo" })[key] });
  assert.equal(legacy.baseUrl, "https://772808.xyz");
});

test("Panda accepts another account key for upstream permission checks while legacy key and provider guards remain", () => {
  const { context } = sandbox({ requiresOriginalTaskKey: (adapter) => adapter !== "fmgo" });
  vm.runInContext(section("function verifyJobConfig", "async function pollJob"), context);
  const job = { baseUrl: config.baseUrl, adapter: config.adapter, apiKeyFingerprint: "different-key-fingerprint" };
  assert.doesNotThrow(() => context.verifyJobConfig(config, job));
  for (const provider of [
    { ...config, baseUrl: "https://772808.xyz" },
    { ...config, adapter: "lwaigc", baseUrl: "https://ai.lwaigc.cn" },
  ]) {
    assert.throws(() => context.verifyJobConfig(provider, { ...job, baseUrl: provider.baseUrl, adapter: provider.adapter }), (caught) => caught.status === 409);
  }
  assert.throws(() => context.verifyJobConfig(config, { ...job, baseUrl: "https://772808.xyz" }), (caught) => caught.status === 400);
  assert.throws(() => context.verifyJobConfig(config, { ...job, adapter: "lwaigc" }), (caught) => caught.status === 400);
});

test("creation preserves opaque resolution, saves request before POST, and keeps only successful id", async () => {
  const calls = [];
  let state;
  state = creation(async (url, options) => {
    calls.push([url, options]);
    assert.ok(state.journal.length > 0, "request must survive a crash before the paid POST");
    return response({ id: "public-task", task_id: "other-id", local_task_id: "trace-only", status: "processing" });
  });
  const job = await state.context.createSeedanceVideo(config, input);
  const [url, options] = calls[0];
  assert.equal(url, "https://panda626.com/v1/videos");
  assert.equal(options.headers.Authorization, "Bearer mock-secret");
  assert.equal(JSON.parse(options.body).parameters.resolution, "1080pp");
  assert.equal(JSON.parse(options.body).input.media[0].type, "reference_image");
  assert.equal(job.taskId, "public-task");
  assert.equal(job.statusPath, "/v1/videos/public-task");
  assert.ok(JSON.stringify(state.journal).includes(options.headers["Idempotency-Key"]));
  assert.ok(!JSON.stringify(state.journal).includes(config.apiKey));
  const storedRequest = state.journal[0].request || state.journal[0].bodyText || state.journal[0].requestBody;
  assert.deepEqual(typeof storedRequest === "string" ? JSON.parse(storedRequest) : storedRequest, JSON.parse(options.body));
});

test("only request_in_progress retries creation with identical key and exact request body", async () => {
  const calls = [];
  const state = creation(async (url, options) => {
    calls.push([url, options]);
    return calls.length === 1
      ? response({ error: { code: "request_in_progress", message: "still submitting" }, local_task_id: "trace-only", retryable: true }, 409, { "Retry-After": "25" })
      : response({ id: "accepted-task", status: "processing" });
  });
  const job = await state.context.createSeedanceVideo(config, input);
  assert.equal(job.taskId, "accepted-task");
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].headers["Idempotency-Key"], calls[1][1].headers["Idempotency-Key"]);
  assert.equal(calls[0][1].body, calls[1][1].body);
  assert.ok(state.delays.includes(25_000), "Retry-After must not be clamped to another provider's short wait");
  assert.ok(!JSON.stringify(state.journal).includes(config.apiKey));
});

test("a pre-persisted client key reaches the paid POST unchanged and is not added to provider JSON", async () => {
  const key = "12345678-1234-4123-8123-123456789abc";
  const state = creation(async (_url, options) => {
    assert.equal(options.headers["Idempotency-Key"], key);
    assert.equal(JSON.parse(options.body).clientSubmissionKey, undefined);
    return response({ id: "client-key-task", status: "processing" });
  });
  await state.context.createSeedanceVideo(config, { ...input, clientSubmissionKey: key });
  assert.equal(state.journal[0].idempotencyKey, key);
});

test("772808 lost POST response reconciles full paginated history via GET and never posts again", async () => {
  const calls = [];
  const request = catalog.seedanceVideoPayload(config.model, input);
  const state = creation(async (url, options) => {
    calls.push([url, options.method || "GET"]);
    if (options.method === "POST") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
    if (url.includes("?limit=")) return response({ data: [{ id: "recovered-id", model: config.model, input: request.input, parameters: request.parameters, created_at: Date.now() / 1000 }], has_more: false });
    return response({ id: "recovered-id", status: "failed", error: { message: "上游素材上传失败" } });
  });
  const { matchSeedanceSubmission, seedanceSubmissionJournal, seedanceTaskHistory } = await import("../src/seedanceSubmissionRecovery.js");
  Object.assign(state.context, { matchSeedanceSubmission, seedanceSubmissionJournal, seedanceTaskHistory,
    existsSync: () => true, readFileSync: () => state.journal.map((row) => JSON.stringify(row)).join("\n"),
    pollJob: async (provider, job) => {
      const body = await (await state.context.upstream(`${provider.baseUrl}${job.statusPath}`, { headers: {} })).json();
      return { body, status: "failed", progress: 100 };
    },
  });
  const job = await state.context.createSeedanceVideo({ ...config, baseUrl: "https://772808.xyz" }, input);
  assert.equal(job.taskId, "recovered-id");
  assert.equal(job.status, "failed");
  assert.equal(job.error, "上游素材上传失败");
  assert.deepEqual(calls.map((call) => call[1]), ["POST", "GET", "GET"]);
  assert.equal(state.journal.at(-1).state, "accepted");
  assert.equal(state.journal.find((row) => row.connectionCode)?.connectionCode, "UND_ERR_SOCKET");
});

test("772808 history HTTP 500 recovers a timed-out request by exact original idempotency replay", async () => {
  const calls = [];
  const state = creation(async (url, options) => {
    calls.push({ url, ...options });
    if (options.method !== "POST") return response({ error: "history unavailable" }, 500);
    return response({ id: "existing-task", status: "succeeded", video_url: "https://772808.xyz/v1/videos/existing-task/content" });
  });
  const original = { idempotencyKey: "12345678-1234-4123-8123-123456789abc", baseUrl: "https://772808.xyz", apiKeyFingerprint: "mock-fingerprint",
    createdAt: new Date().toISOString(), connectionError: "TimeoutError", model: config.model, request: catalog.seedanceVideoPayload(config.model, input) };
  Object.assign(state.context, { existsSync: () => true, readFileSync: () => JSON.stringify(original),
    pollJob: async () => ({ status: "completed", progress: 100, videoUrl: "https://772808.xyz/v1/videos/existing-task/content", body: {} }) });
  const [result] = await state.context.recoverSeedanceSubmissions({ ...config, baseUrl: original.baseUrl }, [original.idempotencyKey]);
  assert.equal(result.job.taskId, "existing-task");
  assert.equal(result.job.status, "completed");
  const posts = calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers["Idempotency-Key"], original.idempotencyKey);
  assert.equal(posts[0].body, JSON.stringify(original.request));
  assert.equal(state.journal.at(-1).taskId, "existing-task");
});

test("recovery persists a discovered task ID even if its first status query fails", async () => {
  const state = creation(async () => response({ data: [{ id: "found-task", model: config.model, idempotency_key: "original-key" }] }));
  Object.assign(state.context, { existsSync: () => true,
    readFileSync: () => JSON.stringify({ idempotencyKey: "original-key", baseUrl: "https://772808.xyz", apiKeyFingerprint: "mock-fingerprint", model: config.model,
      createdAt: new Date().toISOString(), request: catalog.seedanceVideoPayload(config.model, input) }),
    pollJob: async () => { throw error(503, "status unavailable"); } });
  const [result] = await state.context.recoverSeedanceSubmissions({ ...config, baseUrl: "https://772808.xyz" }, ["original-key"]);
  assert.equal(state.journal.at(-1).taskId, "found-task");
  assert.equal(result.job.taskId, "found-task");
  assert.equal(result.job.status, "processing");
  assert.equal(result.job.videoUrl, null);
});

test("an explicit stop during replay is persisted and never retried", async () => {
  const calls = [];
  const state = creation(async (_url, options) => {
    calls.push(options.method || "GET");
    return options.method === "POST" ? response({ retryable: false, error: { code: "request_state_uncertain", message: "stop" } }, 409) : response({ error: "history unavailable" }, 500);
  });
  const original = { idempotencyKey: "original-key", baseUrl: "https://772808.xyz", apiKeyFingerprint: "mock-fingerprint", connectionError: "TimeoutError",
    createdAt: new Date().toISOString(), model: config.model, request: catalog.seedanceVideoPayload(config.model, input) };
  Object.assign(state.context, { existsSync: () => true, readFileSync: () => [original, ...state.journal].map(JSON.stringify).join("\n") });
  const provider = { ...config, baseUrl: original.baseUrl };
  await state.context.recoverSeedanceSubmissions(provider, [original.idempotencyKey]);
  assert.equal(state.journal.at(-1).stopReplay, true);
  await state.context.recoverSeedanceSubmissions(provider, [original.idempotencyKey]);
  assert.equal(calls.filter((method) => method === "POST").length, 1);
});

test("over 1 MiB create body is rejected locally before journal or paid POST", async () => {
  let calls = 0;
  const state = creation(async () => { calls += 1; return response({ id: "unexpected" }); });
  await assert.rejects(state.context.createSeedanceVideo(config, { ...input, materials: [{ kind: "image", url: `https://assets.example/${"x".repeat(1024 * 1024)}` }] }), (caught) => caught.status === 413 && !caught.submissionUnknown);
  assert.equal(calls, 0);
  assert.equal(state.journal.length, 0);
});

test("accepted creation honors immediate failed reason and immediate succeeded media result", async () => {
  for (const body of [
    { id: "immediate-failure", status: "failed", error: { code: "invalid_material", message: "图片格式不符合要求" } },
    { id: "immediate-success", status: "succeeded", video_url: "https://panda626.com/v1/videos/immediate-success/content" },
  ]) {
    const state = creation(async () => response(body));
    const job = await state.context.createSeedanceVideo(config, input);
    assert.equal(job.taskId, body.id);
    assert.equal(state.journal.at(-1).state, "accepted");
    if (body.status === "failed") {
      assert.equal(job.status, "failed");
      assert.equal(job.error, "图片格式不符合要求");
      assert.equal(job.videoUrl, null);
    } else {
      assert.equal(job.status, "completed");
      assert.equal(job.progress, 100);
      assert.equal(job.videoUrl, body.video_url);
    }
  }
});

for (const [label, upstreamResponse] of [
  ["network loss", () => { throw new TypeError("fetch failed"); }],
  ["upstream 503", () => response({ error: "upstream unavailable" }, 503)],
  ["success without id", () => response({ task_id: "not-a-success-id", local_task_id: "trace-only" })],
  ["uncertain result", () => response({ error: { code: "request_state_uncertain", message: "uncertain" }, local_task_id: "trace-only" }, 409)],
  ["explicit stop", () => response({ error: { code: "request_in_progress", message: "stop" }, retryable: false }, 409)],
  ["expired request", () => response({ error: { code: "idempotency_task_expired", message: "expired" } }, 410)],
]) {
  test(`creation ${label} preserves unknown state and never repeats paid POST`, async () => {
    let attempts = 0;
    const state = creation(async () => { attempts += 1; return upstreamResponse(); });
    await assert.rejects(state.context.createSeedanceVideo(config, input), (caught) => caught.submissionUnknown === true);
    assert.equal(attempts, 1);
    assert.ok(state.journal.length > 0);
  });
}
for (const status of [400, 401, 402]) {
  test(`known HTTP ${status} rejection stays a normal failed submission without retry`, async () => {
    let attempts = 0;
    const state = creation(async () => { attempts += 1; return response({ error: { code: "rejected", message: "known rejection" } }, status); });
    await assert.rejects(state.context.createSeedanceVideo(config, input), (caught) => caught.status === status && !caught.submissionUnknown);
    assert.equal(attempts, 1);
  });
}

for (const status of [202, 409]) {
  test(`HTTP ${status} video_result_pending keeps original task processing`, async () => {
    const state = sandbox({ upstream: async (url, options) => {
      assert.equal(url, "https://panda626.com/v1/videos/original-task");
      assert.equal(options.headers.Authorization, "Bearer mock-secret");
      return response({ status: "succeeded", progress: 100, error: { code: "video_result_pending", message: "preparing" }, result_pending: true }, status, { "Retry-After": "20" });
    } });
    vm.runInContext(section("async function pollJob", "function streamResponse"), state.context);
    const result = await state.context.pollJob(config, { taskId: "original-task", statusPath: "/v1/videos/original-task" });
    assert.equal(result.status, "processing");
    assert.ok(result.progress < 100);
    assert.equal(result.videoUrl, null);
    assert.equal(result.retryAfterMs, 20_000);
    assert.equal(state.context.completedVideoUrls.size, 0);
  });
}

test("polling distinguishes final failure from success and caches only real result URL", async () => {
  const results = [response({ status: "failed", error: { message: "material rejected" }, progress: 100 }), response({ status: "succeeded", progress: 100, video_url: "https://panda626.com/v1/videos/original-task/content" })];
  const state = sandbox({ upstream: async () => results.shift() });
  vm.runInContext(section("async function pollJob", "function streamResponse"), state.context);
  const job = { taskId: "original-task", statusPath: "/v1/videos/original-task" };
  const failure = await state.context.pollJob(config, job);
  assert.equal(failure.status, "failed");
  assert.equal(failure.body.error.message, "material rejected");
  assert.equal(state.context.completedVideoUrls.size, 0);
  const success = await state.context.pollJob(config, job);
  assert.equal(success.status, "completed");
  assert.equal(success.videoUrl, "https://panda626.com/v1/videos/original-task/content");
  assert.equal(state.context.completedVideoUrls.size, 1);
});

test("image multipart uses file and originalName, reads top-level URL and rejects over 8 MiB before upload", async () => {
  const calls = [];
  const state = sandbox({ upstream: async (url, options) => {
    calls.push([url, options]);
    return response({ url: "https://panda626.com/api/uploaded-image/uploads/image.png", data: { url: "https://wrong.example/image.png" } });
  } });
  vm.runInContext(section("async function uploadMedia", "async function importUnmauImage"), state.context);
  const file = { buffer: Buffer.from("mock PNG"), originalname: "参考.png", mimetype: "image/png" };
  const url = await state.context.uploadMedia(config, file, { kind: "image" });
  assert.equal(url, "https://panda626.com/api/uploaded-image/uploads/image.png");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], config.mediaUploadUrl);
  assert.equal(calls[0][1].headers.Authorization, "Bearer mock-secret");
  assert.equal(calls[0][1].headers["Content-Type"], undefined);
  assert.equal(calls[0][1].headers["Idempotency-Key"], undefined);
  assert.equal(calls[0][1].body.get("originalName"), "参考.png");
  assert.equal(calls[0][1].body.get("file").size, file.buffer.length);
  await assert.rejects(state.context.uploadMedia(config, { ...file, buffer: Buffer.alloc(8 * 1024 * 1024 + 1) }, { kind: "image" }), (caught) => caught.status === 413);
  assert.equal(calls.length, 1);
});

test("Panda upload 429 waits Retry-After and retries multipart without invented idempotency", async () => {
  const calls = [];
  const state = sandbox({ upstream: async (url, options) => {
    calls.push([url, options]);
    return calls.length === 1
      ? response({ error: { code: "rate_limit_exceeded", message: "wait" } }, 429, { "Retry-After": "25" })
      : response({ url: "https://panda626.com/api/uploaded-image/uploads/image.png" });
  } });
  vm.runInContext(section("async function uploadMedia", "async function importUnmauImage"), state.context);
  await state.context.uploadMedia(config, { buffer: Buffer.from("PNG"), originalname: "参考.png", mimetype: "image/png" }, { kind: "image" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].body, calls[1][1].body);
  assert.ok(calls.every(([, options]) => options.headers["Idempotency-Key"] === undefined));
  assert.ok(state.delays.includes(25_000));
});

test("HTTP 429 JSON exposes upstream Retry-After for client polling backoff", async () => {
  const { context } = sandbox();
  await assert.rejects(context.readJson(response({ error: { code: "rate_limit_exceeded", message: "wait" } }, 429, { "Retry-After": "25" })), (caught) => caught.status === 429 && caught.retryAfterMs === 25_000);
});

test("concurrent authenticated Panda requests start at least 550ms apart; public content bypasses the gate", async () => {
  let now = 1_800_000_000_000;
  const timers = [];
  const starts = [];
  class ClockDate extends Date { static now() { return now; } }
  const state = sandbox({
    Date: ClockDate, AbortSignal,
    setTimeout: (callback, delay) => timers.push({ callback, time: now + delay }),
    fetch: async (url) => { starts.push({ url, time: now }); return response({ ok: true }); },
  });
  vm.runInContext(section("const retryableStatuses", "async function readJson"), state.context);
  const auth = { headers: { Authorization: "Bearer mock-secret" } };
  const all = Promise.all(["models", "balance", "videos"].map((endpoint) => state.context.upstream(`https://panda626.com/v1/${endpoint}`, auth)));
  while (timers.length) {
    timers.sort((left, right) => left.time - right.time);
    const timer = timers.shift();
    now = timer.time;
    timer.callback();
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
  }
  await all;
  assert.equal(starts.length, 3);
  assert.ok(starts[1].time - starts[0].time >= 550);
  assert.ok(starts[2].time - starts[1].time >= 550);
  const publicStartedAt = now;
  await state.context.upstream("https://panda626.com/v1/videos/task/content", { headers: { Range: "bytes=0-99" } });
  assert.equal(starts[3].time, publicStartedAt);
  assert.equal(timers.length, 0);
});

test("/api/tasks preserves resolution enum and immediate completion or failed reason instead of queuing", async () => {
  let handler;
  let captured;
  let result;
  let returnedJob = { ...config, taskId: "immediate-task", status: "completed", progress: 100, videoUrl: "https://panda626.com/v1/videos/immediate-task/content" };
  const state = sandbox({
    app: { post: (_route, _middleware, callback) => { handler = callback; } },
    upload: { array: () => () => {} }, providerConfig: () => config,
    validateLwaigcLimits: () => {}, validateMeaiccLimits: () => {}, validateProviderLimits: () => {},
    safeNumber: (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback,
    prepareMaterials: async () => [], withReferenceMapping: (prompt) => prompt,
    createVideo: async (_provider, request) => {
      captured = request;
      return returnedJob;
    }, encodeJob: () => "signed-token", cleanupFiles: () => {}, isAmbiguousMeaiccSubmission: () => false,
  });
  vm.runInContext(section('app.post("/api/tasks",', 'app.post("/api/tasks/recover"'), state.context);
  await handler({ files: [], body: { prompt: input.prompt, duration: "15", resolution: "1080pp", aspectRatio: "9:16" } }, {
    status: (status) => { assert.equal(status, 202); return { json: (body) => { result = body; } }; },
  }, (caught) => { throw caught; });
  assert.equal(captured.resolution, "1080pp");
  assert.equal(result.tasks[0].status, "completed");
  assert.equal(result.tasks[0].progress, 100);
  assert.equal(result.tasks[0].sourceVideoUrl, "https://panda626.com/v1/videos/immediate-task/content");
  returnedJob = { ...returnedJob, status: "failed", error: "图片格式不符合要求", videoUrl: null };
  await handler({ files: [], body: { prompt: input.prompt, duration: "15", resolution: "1080pp", aspectRatio: "9:16" } }, {
    status: () => ({ json: (body) => { result = body; } }),
  }, (caught) => { throw caught; });
  assert.equal(result.tasks[0].status, "failed");
  assert.equal(result.tasks[0].error, "图片格式不符合要求");
  assert.equal(result.tasks[0].sourceVideoUrl, undefined);
});

test("multi-quantity submission stops after partial acceptance and never auto-repeats accepted jobs", async () => {
  let handler;
  let attempts = 0;
  const state = sandbox({
    app: { post: (_route, _middleware, callback) => { handler = callback; } },
    upload: { array: () => () => {} }, providerConfig: () => config,
    validateLwaigcLimits: () => {}, validateMeaiccLimits: () => {}, validateProviderLimits: () => {},
    safeNumber: (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback,
    prepareMaterials: async () => [], withReferenceMapping: (prompt) => prompt,
    createVideo: async () => {
      attempts += 1;
      if (attempts === 1) return { ...config, taskId: "first-accepted-id", status: "processing", progress: 0 };
      throw error(400, "second request rejected");
    }, cleanupFiles: () => {}, isAmbiguousMeaiccSubmission: () => false,
  });
  vm.runInContext(section('app.post("/api/tasks",', 'app.post("/api/tasks/recover"'), state.context);
  const run = () => handler({ files: [], body: { prompt: input.prompt, duration: "15", resolution: "1080pp", quantity: "3" } }, {}, (caught) => { throw caught; });
  await assert.rejects(run(), (caught) => caught.submissionUnknown === true && caught.message.includes("first-accepted-id"));
  assert.equal(attempts, 2, "third job must not submit after the second job is rejected");
  attempts = 0;
  state.context.createVideo = async () => { attempts += 1; throw error(400, "first request rejected"); };
  await assert.rejects(run(), (caught) => caught.status === 400 && !caught.submissionUnknown);
  assert.equal(attempts, 1);
});

function contentRoute(upstream, result, jobOverride = {}) {
  let handler;
  const streamed = [];
  const state = sandbox({
    app: { get: (_route, callback) => { handler = callback; } }, upstream,
    decodeJob: () => ({ adapter: config.adapter, baseUrl: config.baseUrl, taskId: "original-task", statusPath: "/v1/videos/original-task", ...jobOverride }),
    providerConfig: () => { throw new Error("providerConfig called (requires API Key)"); }, verifyJobConfig: () => {}, recoveredFmgoVideoUrl: () => null,
    directTaskContentPaths, shouldRejectUnfinishedVideo,
    sameSiteHost: (left, right) => left.hostname === right.hostname,
    pollJob: async () => result || { status: "processing", body: {}, videoUrl: null },
    streamResponse: (incoming) => streamed.push(incoming),
  });
  vm.runInContext(section('app.get("/api/tasks/:id/content"', 'if (!process.argv.includes("--api-only"))'), state.context);
  return { streamed, run: () => handler({ params: { id: "signed-task-token" }, query: {}, get: (header) => header === "range" ? "bytes=0-99" : undefined }, {}, (caught) => { throw caught; }) };
}

test("public content forwards Range without Authorization or cookies", async () => {
  const calls = [];
  const route = contentRoute(async (url, options) => {
    calls.push([String(url), options]);
    return new Response("mock video", { status: 206, headers: { "content-type": "video/mp4" } });
  });
  await route.run();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://panda626.com/v1/videos/original-task/content");
  assert.equal(calls[0][1].headers.Range, "bytes=0-99");
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.equal(calls[0][1].headers.Cookie, undefined);
  assert.equal(route.streamed.length, 1);
});

test("legacy 772808 content keeps its authenticated providerConfig flow", async () => {
  let calls = 0;
  const route = contentRoute(async () => { calls += 1; return new Response("unexpected content"); }, undefined, { baseUrl: "https://772808.xyz" });
  await assert.rejects(route.run(), /providerConfig called \(requires API Key\)/);
  assert.equal(calls, 0);
  assert.equal(route.streamed.length, 0);
});

test("pending content JSON is never streamed as a video or retried with API credentials", async () => {
  const calls = [];
  const route = contentRoute(async (url, options) => {
    calls.push([String(url), options]);
    return response({ error: { code: "video_result_pending", message: "preparing result" } }, 409, { "Retry-After": "20" });
  });
  await assert.rejects(route.run());
  assert.equal(route.streamed.length, 0);
  assert.ok(calls.every(([, options]) => !options.headers.Authorization && !options.headers.Cookie));
});

test("successful HTTP JSON from content is rejected instead of pretending download success", async () => {
  const calls = [];
  const route = contentRoute(async (url, options) => {
    calls.push([String(url), options]);
    return response({ error: { code: "video_result_pending", message: "still preparing" } });
  });
  await assert.rejects(route.run());
  assert.equal(route.streamed.length, 0);
  assert.ok(calls.every(([, options]) => !options.headers.Authorization));
});
