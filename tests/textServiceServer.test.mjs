import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServer, request as httpRequest } from "node:http";
import { textServiceRouter } from "../serverTextService.mjs";

const key = "sk_txt_mock_secret";
const requestKey = "request-00000001";
const encoder = new TextEncoder();
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
async function mockServer(t, fetchImpl) {
  const app = express();
  app.use("/api/text", textServiceRouter({ fetchImpl }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/text`;
  return {
    base,
    post: (endpoint, body, headers = {}) => fetch(`${base}/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-text-api-key": key, "Idempotency-Key": requestKey, ...headers }, body: JSON.stringify(body),
    }),
  };
}

test("model list uses fixed native text host, normalized dedicated Bearer key and no redirect", async (t) => {
  const calls = [];
  const server = await mockServer(t, async (url, options) => {
    calls.push([url, options]);
    return json({ object: "list", data: [{ id: "native-model" }] });
  });
  const result = await fetch(`${server.base}/models`, { headers: { "x-text-api-key": `Bearer ${key}`, "x-api-base-url": "https://attacker.example" } });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).data[0].id, "native-model");
  assert.equal(calls[0][0], "https://see.ximeiedu.org/text/v1/models");
  assert.equal(calls[0][1].method, "GET");
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${key}`);
  assert.equal(calls[0][1].redirect, "error");
});

for (const [endpoint, body] of [
  ["responses", { model: "response-model", input: "写一段对话", max_output_tokens: 256, stream: true, store: false }],
  ["messages", { model: "message-model", messages: [{ role: "user", content: "写一段对话" }], max_tokens: 256, stream: true }],
  ["chat/completions", { model: "chat-model", messages: [{ role: "user", content: "写一段对话" }], max_tokens: 256, stream: true, stream_options: { include_usage: true } }],
]) {
  test(`${endpoint} forwards native body, endpoint, stable request key and correct authentication`, async (t) => {
    const calls = [];
    const server = await mockServer(t, async (url, options) => {
      calls.push([url, options]);
      return json({ id: "native-response", output: "native output" }, 200, { "x-request-id": "native-request", "x-idempotent-replay": "true" });
    });
    const result = await server.post(endpoint, body);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("x-request-id"), "native-request");
    assert.equal(result.headers.get("x-idempotent-replay"), "true");
    assert.equal((await result.json()).id, "native-response");
    assert.equal(calls.length, 1);
    const [url, options] = calls[0];
    assert.equal(url, `https://see.ximeiedu.org/text/v1/${endpoint}`);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["Idempotency-Key"], requestKey);
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(options.body), body);
    if (endpoint === "messages") {
      assert.equal(options.headers["x-api-key"], key);
      assert.equal(options.headers["anthropic-version"], "2023-06-01");
      assert.equal(options.headers.Authorization, undefined);
    } else {
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      assert.equal(options.headers["x-api-key"], undefined);
    }
  });
}

test("SSE chunks and native error events pass through unchanged without fake successful completion", async (t) => {
  const chunks = ["event: response.output_text.delta\ndata: {\"delta\":\"你好\"}\n\n", "event: error\ndata: {\"code\":\"TEXT_UPSTREAM_ERROR\"}\n\n"];
  const server = await mockServer(t, async () => new Response(new ReadableStream({
    start(controller) { chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk))); controller.close(); },
  }), { headers: { "content-type": "text/event-stream", "x-request-id": "stream-request" } }));
  const result = await server.post("responses", { model: "native-model", input: "你好", stream: true });
  assert.equal(result.headers.get("content-type"), "text/event-stream");
  assert.equal(result.headers.get("x-request-id"), "stream-request");
  assert.equal(await result.text(), chunks.join(""));
});

for (const [status, code] of [[400, "TEXT_IDEMPOTENCY_CONFLICT"], [401, "TEXT_AUTH_INVALID"], [410, "TEXT_RESPONSE_UNAVAILABLE"], [429, "TEXT_RATE_LIMIT_EXCEEDED"], [502, "TEXT_UPSTREAM_ERROR"]]) {
  test(`native HTTP ${status} ${code} remains exact and never replays a paid POST`, async (t) => {
    let calls = 0;
    const payload = { error: { type: "native_error", code, message: "native reason" } };
    const server = await mockServer(t, async () => { calls += 1; return json(payload, status, { "Retry-After": "30", "x-request-id": "error-request" }); });
    const result = await server.post("responses", { model: "native-model", input: "你好" });
    assert.equal(result.status, status);
    assert.equal(result.headers.get("retry-after"), "30");
    assert.deepEqual(await result.json(), payload);
    assert.equal(calls, 1);
  });
}

test("upstream network errors never retry POST or expose upstream error/key details", async (t) => {
  let calls = 0;
  const server = await mockServer(t, async () => { calls += 1; throw new Error(`socket closed ${key}`); });
  const result = await server.post("responses", { model: "native-model", input: "你好" });
  assert.equal(result.status, 502);
  const text = await result.text();
  assert.equal(JSON.parse(text).error.code, "TEXT_UPSTREAM_UNAVAILABLE");
  assert.ok(!text.includes(key));
  assert.equal(calls, 1);
});

test("video keys or missing dedicated key are rejected before upstream access", async (t) => {
  let calls = 0;
  const server = await mockServer(t, async () => { calls += 1; return json({}); });
  for (const invalidKey of ["", "sk-video-key", "sd_live_video", "sk_txt_"]) {
    const result = await fetch(`${server.base}/models`, { headers: { "x-text-api-key": invalidKey } });
    assert.equal(result.status, 401);
    assert.equal((await result.json()).error.code, "TEXT_AUTH_INVALID");
  }
  assert.equal(calls, 0);
});

test("POST requires a stable Idempotency-Key rather than silently creating a new paid request", async (t) => {
  let calls = 0;
  const server = await mockServer(t, async () => { calls += 1; return json({}); });
  const result = await fetch(`${server.base}/responses`, { method: "POST", headers: { "Content-Type": "application/json", "x-text-api-key": key }, body: JSON.stringify({ model: "native", input: "你好" }) });
  assert.equal(result.status, 400);
  assert.equal((await result.json()).error.code, "TEXT_IDEMPOTENCY_REQUIRED");
  assert.equal(calls, 0);
});

test("session storage/background/paid tiers/hosted tools are blocked but native function and cache/thinking fields survive", async (t) => {
  const bodies = [];
  const server = await mockServer(t, async (_url, options) => { bodies.push(JSON.parse(options.body)); return json({ ok: true }); });
  for (const unsupported of [
    { store: true }, { store: "true" }, { previous_response_id: "old-response" }, { conversation: "stored-conversation" }, { background: true },
    { service_tier: "priority" }, { speed: "fast" }, { tools: [{ type: "web_search" }] }, { tools: [{ type: "code_interpreter" }] }, { tools: [{ type: "image_generation" }] },
    { modalities: ["text", "audio"] }, { response_modalities: ["IMAGE"] }, { audio: { voice: "alloy", format: "wav" } },
  ]) {
    const result = await server.post("responses", { model: "native", input: "你好", ...unsupported });
    assert.equal(result.status, 400);
    assert.equal((await result.json()).error.code, "TEXT_REQUEST_UNSUPPORTED");
  }
  assert.equal(bodies.length, 0);
  const native = { model: "native", messages: [{ role: "user", content: [{ type: "text", text: "你好", cache_control: { type: "ephemeral" } }] }], max_tokens: 256,
    tools: [{ name: "lookup_local", input_schema: { type: "object", properties: {} } }], thinking: { type: "enabled", budget_tokens: 128 } };
  assert.equal((await server.post("messages", native)).status, 200);
  assert.deepEqual(bodies[0], native);
  const responseFunction = { model: "native", input: "你好", tools: [{ type: "function", name: "client_function", parameters: { type: "object" } }], tool_choice: "auto", prompt_cache_key: "cache-key" };
  assert.equal((await server.post("responses", responseFunction)).status, 200);
  assert.deepEqual(bodies[1], responseFunction);
});

test("single-turn native validation refuses empty/multiturn/non-text content and invalid token or stream types", async (t) => {
  let calls = 0;
  const server = await mockServer(t, async () => { calls += 1; return json({}); });
  for (const body of [
    { model: "native", input: "" }, { model: "", input: "你好" }, { model: "native", input: "你好", max_output_tokens: 0 },
    { model: "native", input: "你好", stream: "true" },
  ]) assert.equal((await server.post("responses", body)).status, 400);
  for (const messages of [[{ role: "assistant", content: "你好" }], [{ role: "user", content: "a" }, { role: "user", content: "b" }], [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }] }], [{ role: "user", content: [{ type: "text", text: " " }] }]]) {
    assert.equal((await server.post("chat/completions", { model: "native", messages })).status, 400);
  }
  assert.equal(calls, 0);
});

test("router supports attachment requests beyond 1MiB but enforces its 20MiB boundary", async (t) => {
  const bodies = [];
  const server = await mockServer(t, async (_url, options) => { bodies.push(JSON.parse(options.body)); return json({ ok: true }); });
  const accepted = { model: "native", input: "x".repeat(1024 * 1024 + 1) };
  assert.equal((await server.post("responses", accepted)).status, 200);
  assert.deepEqual(bodies[0], accepted);
  const rejected = await server.post("responses", { model: "native", input: "x".repeat(20 * 1024 * 1024) });
  assert.equal(rejected.status, 413);
  assert.equal((await rejected.json()).error.code, "TEXT_REQUEST_TOO_LARGE");
  assert.equal(bodies.length, 1);
});

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY+kAAAAASUVORK5CYII=";
for (const [endpoint, body] of [
  ["responses", { model: "vision", input: [{ role: "user", content: [{ type: "input_text", text: "阅读图片和附件正文" }, { type: "input_image", image_url: image }] }], stream: true, store: false }],
  ["messages", { model: "vision", messages: [{ role: "user", content: [{ type: "text", text: "阅读图片和附件正文" }, { type: "image", source: { type: "base64", media_type: "image/png", data: image.split(",")[1] } }] }], max_tokens: 256, stream: true }],
  ["chat/completions", { model: "vision", messages: [{ role: "user", content: [{ type: "text", text: "阅读图片和附件正文" }, { type: "image_url", image_url: { url: image } }] }], stream: true }],
]) {
  test(`${endpoint} forwards native single-user image attachment without media upload or URL rewriting`, async (t) => {
    const calls = [];
    const server = await mockServer(t, async (url, options) => { calls.push([url, options]); return json({ ok: true }); });
    assert.equal((await server.post(endpoint, body)).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], `https://see.ximeiedu.org/text/v1/${endpoint}`);
    assert.deepEqual(JSON.parse(calls[0][1].body), body);
  });
}

test("image input accepts only bounded PNG/JPEG/WEBP Base64, never remote/blob/file/local URLs", async (t) => {
  let calls = 0;
  const server = await mockServer(t, async () => { calls += 1; return json({}); });
  for (const value of ["https://example.com/image.png", "http://127.0.0.1/private", "file:///C:/secret.png", "blob:http://localhost/id", "C:/secret.png", "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,", "data:image/png;base64,%%%%", `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64")}`]) {
    const result = await server.post("responses", { model: "vision", input: [{ role: "user", content: [{ type: "input_image", image_url: value }] }] });
    assert.equal(result.status, 400);
  }
  assert.equal(calls, 0);
});

test("downstream disconnect aborts an active upstream stream and never replays", { timeout: 3000 }, async (t) => {
  let calls = 0;
  let aborted;
  const abortObserved = new Promise((resolve) => { aborted = resolve; });
  const server = await mockServer(t, async (_url, options) => {
    calls += 1;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode("data: first\n\n"));
      options.signal.addEventListener("abort", () => { controller.error(new Error("aborted")); aborted(); }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const request = httpRequest(`${server.base}/responses`, { method: "POST", headers: { "Content-Type": "application/json", "x-text-api-key": key, "Idempotency-Key": requestKey } });
  request.on("error", () => {});
  request.on("response", (incoming) => { incoming.once("data", () => { incoming.destroy(); request.destroy(); }); });
  request.end(JSON.stringify({ model: "native", input: "你好", stream: true }));
  await abortObserved;
  assert.equal(calls, 1);
});

test("upstream stream transport failure after headers terminates download, not fake success JSON", async (t) => {
  let calls = 0;
  const server = await mockServer(t, async () => {
    calls += 1;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode("data: partial\n\n"));
      setTimeout(() => controller.error(new Error("upstream lost connection")), 10);
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const result = await server.post("responses", { model: "native", input: "你好", stream: true });
  assert.equal(result.headers.get("content-type"), "text/event-stream");
  await assert.rejects(result.text());
  assert.equal(calls, 1);
});
