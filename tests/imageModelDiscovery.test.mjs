import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { IMAGE_PROVIDER_PROFILES } from "../src/imageCatalog.js";
import { normalizeImageProvider } from "../src/imageProviderSettings.js";
import { fetchImageModelCatalog, parseImageModelCatalog, imageModelScope, imageSelectableModels, saveImageModelCatalog,
  readImageModelCatalogs, imageCatalogMatches, imageModelFingerprint, imageModelCatalogStatus, IMAGE_MODEL_CATALOGS_KEY } from "../src/imageModelDiscovery.js";
const profile = { ...IMAGE_PROVIDER_PROFILES[0], baseUrl: "https://mock-relay.invalid" };
const key = "mock-key-no-real-credentials";
const ui = readFileSync(new URL("../src/ImageWorkbench.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length));
function storage() { const map = new Map([["unrelated", "preserved"]]); return { map, getItem: (name) => map.get(name) ?? null, setItem: (name, value) => map.set(name, value) }; }
function response(body, status = 200) { return { status, ok: status >= 200 && status < 300, json: async () => body }; }
const result = () => parseImageModelCatalog({ data: [{ id: "gpt-image-2" }, { id: "unknown-image-model" }, { id: "mystery", output_modalities: ["image"] }, { id: "text-only" }] }, "fmgo");

test("discovery uses the unsaved public HTTPS origin/protocol/key and only a read-only local request", async () => {
  let call;
  const catalog = await fetchImageModelCatalog(profile, key, { fetchImpl: async (url, options) => { call = { url, options }; return response({ data: [{ id: "gpt-image-2" }, { id: "text-only" }] }); } });
  assert.equal(call.url, "/api/image-config/models");
  assert.equal(call.options.method, undefined);
  assert.equal(call.options.body, undefined);
  assert.equal(call.options.headers["x-api-base-url"], profile.baseUrl);
  assert.equal(call.options.headers["x-api-adapter"], "fmgo");
  assert.equal(call.options.headers["x-api-key"], key);
  assert.equal(catalog.groups.supported.length, 1);
  assert.equal(catalog.groups.other.length, 1);
  assert.equal(catalog.keyFingerprint, await imageModelFingerprint(key));
  assert.doesNotMatch(JSON.stringify(catalog), new RegExp(key));
});

test("missing keys and invalid/private/non-HTTPS addresses fail before a request", async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls++; throw new Error("must not call"); } };
  await assert.rejects(fetchImageModelCatalog(profile, "", options), /填写图片 API Key/);
  for (const baseUrl of ["http://mock.invalid", "https://127.0.0.1", "https://192.168.0.2", "https://localhost", "bad URL"]) await assert.rejects(fetchImageModelCatalog({ ...profile, baseUrl }, key, options), /HTTPS|Base URL/);
  assert.equal(calls, 0);
});

test("401/403, network, timeout, malformed JSON/list and missing backend produce safe actionable statuses", async () => {
  for (const status of [401, 403]) {
    await assert.rejects(fetchImageModelCatalog(profile, key, { fetchImpl: async () => response({ message: key }, status) }), (error) => error.message.includes(`HTTP ${status}`) && !error.message.includes(key));
  }
  await assert.rejects(fetchImageModelCatalog(profile, key, { fetchImpl: async () => { throw new TypeError(key); } }), /连接失败.*未提交生成/);
  await assert.rejects(fetchImageModelCatalog(profile, key, { fetchImpl: async () => { throw new DOMException(key, "TimeoutError"); } }), /超时/);
  await assert.rejects(fetchImageModelCatalog(profile, key, { fetchImpl: async () => ({ status: 200, ok: true, json: async () => { throw new Error(key); } }) }), /有效 JSON.*空闲时重启/);
  await assert.rejects(fetchImageModelCatalog(profile, key, { fetchImpl: async () => response({ unexpected: "shape" }) }), /模型列表格式无效/);
  await assert.rejects(fetchImageModelCatalog(profile, key, { fetchImpl: async () => response({}, 404) }), /任务结束后重启/);
});

test("empty/fallback catalogs retain manual selection and known models; unknown/non-image models remain visible but not auto-selected", async () => {
  const catalog = result();
  assert.deepEqual(catalog.groups, { supported: ["gpt-image-2"], candidates: ["unknown-image-model", "mystery"], other: ["text-only"] });
  assert.deepEqual(parseImageModelCatalog(catalog, "fmgo").groups, catalog.groups);
  const manual = "user-custom-model";
  assert.equal(normalizeImageProvider({ ...profile, model: manual }).model, manual);
  const names = imageSelectableModels(profile, { ...catalog, baseUrl: profile.baseUrl, adapter: "fmgo" }, manual);
  assert.equal(names[0], manual);
  assert.ok(names.includes("text-only"));
  assert.ok(names.includes("unknown-image-model"));
  assert.equal(parseImageModelCatalog([], "fmgo").models.length, 0);
  assert.match(imageModelCatalogStatus(parseImageModelCatalog([], "fmgo")), /空列表.*原选择已保留/);
  assert.match(imageModelCatalogStatus(parseImageModelCatalog({ models: [], source: "fallback" }, "fmgo")), /尚未核实 Key 权限/);
  assert.equal(parseImageModelCatalog({ models: [key, { id: "safe-image" }] }, "fmgo", key).models.length, 1);
});

test("catalog persistence is image-only and isolated by provider, origin, protocol and key fingerprint", async () => {
  const local = storage();
  const fingerprint = await imageModelFingerprint(key);
  const entry = saveImageModelCatalog(profile, fingerprint, result(), local);
  assert.ok(local.map.has(IMAGE_MODEL_CATALOGS_KEY));
  assert.equal(local.getItem("unrelated"), "preserved");
  assert.doesNotMatch(local.getItem(IMAGE_MODEL_CATALOGS_KEY), new RegExp(key));
  assert.ok(imageCatalogMatches(readImageModelCatalogs(local)[profile.id], profile, fingerprint));
  assert.equal(imageCatalogMatches(entry, { ...profile, baseUrl: "https://other.invalid" }, fingerprint), false);
  assert.equal(imageCatalogMatches(entry, { ...profile, adapter: "qiqi" }, fingerprint), false);
  assert.equal(imageCatalogMatches(entry, profile, "different-key"), false);
  assert.equal(readImageModelCatalogs(local)["another-provider"], undefined);
  const retained = saveImageModelCatalog(profile, fingerprint, { models: [], source: "fallback" }, local);
  assert.equal(retained.retained, true);
  assert.deepEqual(retained.models, entry.models);
});

function uiHarness() {
  const state = { catalogs: {}, status: [], testing: [], saves: 0 };
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const scope = JSON.stringify([profile.id, imageModelScope(profile, key)]);
  const context = vm.createContext({ providerDraft: { ...profile, model: "manual-keep" }, providerDraftKey: key, submitting: false,
    modelReadRevisionRef: { current: 0 }, modelReadScopeRef: { current: scope }, modelReadAbortRef: { current: null }, imageCatalogScopesRef: { current: {} },
    AbortController, normalizeImageProvider, imageModelScope, imageModelCatalogStatus,
    fetchImageModelCatalog: async () => pending,
    saveImageModelCatalog: (_profile, fingerprint, payload) => { state.saves++; return { ...payload, keyFingerprint: fingerprint }; },
    setImageCatalogs: (updater) => { state.catalogs = updater(state.catalogs); }, setModelTestStatus: (value) => state.status.push(value), setModelTesting: (value) => state.testing.push(value),
  });
  vm.runInContext(section(ui, "  async function testImageProvider()", "  function saveCurrentCredentials"), context);
  return { context, state, resolve, run: () => context.testImageProvider() };
}

test("a response after switching provider/address/key is ignored and cannot replace another provider's model list", async () => {
  for (const replacement of ["different-provider", "different-origin", "different-key"]) {
    const h = uiHarness();
    const pending = h.run();
    h.context.modelReadScopeRef.current = replacement;
    h.resolve({ ...result(), keyFingerprint: "fingerprint" });
    await pending;
    assert.equal(h.state.saves, 0);
    assert.deepEqual(h.state.catalogs, {});
    assert.equal(h.context.providerDraft.model, "manual-keep");
  }
});

test("overlapping reads keep the newest result and preserve draft/manual model/configuration", async () => {
  const h = uiHarness();
  const pending = h.run();
  h.resolve({ ...result(), keyFingerprint: "fingerprint" });
  await pending;
  assert.equal(h.state.saves, 1);
  assert.equal(h.state.testing.at(-1), false);
  assert.match(h.state.status.at(-1), /已读取 4 个模型/);
  assert.equal(h.context.providerDraft.model, "manual-keep");
  const stale = uiHarness();
  const old = stale.run();
  stale.context.modelReadRevisionRef.current += 1;
  stale.resolve({ ...result(), keyFingerprint: "fingerprint" });
  await old;
  assert.equal(stale.state.saves, 0);
});

function backendHarness({ status = 200, payload = { models: ["gpt-image-2", "text-only"] }, failure } = {}) {
  let handler;
  const calls = [];
  const context = vm.createContext({ app: { get: (_path, callback) => { handler = callback; } },
    providerConfig: (_req, required, scope) => { assert.equal(required, false); assert.equal(scope, "image"); return { ...profile, apiKey: key }; },
    authHeaders: () => ({ Authorization: "Bearer mock-key" }),
    upstream: async (url, options, timeout) => { calls.push({ url, options, timeout }); if (failure) throw failure; return { status, ok: status >= 200 && status < 300, body: { cancel: async () => {} } }; },
    readJson: async () => payload, parseImageModelCatalog,
    FMGO_IMAGE_MODELS: ["gpt-image-2"], CANSEEDREAM_IMAGE_MODELS: ["GPT Image 2"], QIQI_IMAGE_MODELS: ["gpt-image-2"],
    httpError: (code, message) => Object.assign(new Error(message), { status: code }),
  });
  vm.runInContext(section(server, 'app.get("/api/image-config/models"', 'app.get("/api/config/models"'), context);
  async function run() { let body; let error; await handler({}, { json: (value) => { body = value; } }, (value) => { error = value; }); return { body, error }; }
  return { run, calls };
}

test("backend discovery makes only authenticated GET model-list requests to validated configured origin", async () => {
  const h = backendHarness();
  const { body, error } = await h.run();
  assert.equal(error, undefined);
  assert.deepEqual(Array.from(body.models), ["gpt-image-2", "text-only"]);
  assert.equal(h.calls[0].url, profile.baseUrl + "/v1/models");
  assert.equal(h.calls[0].options.method, undefined);
  assert.equal(h.calls[0].options.body, undefined);
  assert.equal(h.calls[0].timeout, 8000);
});

test("backend auth, unsupported listing, malformed content and network errors never echo upstream credentials", async () => {
  for (const status of [401, 403]) { const { error } = await backendHarness({ status }).run(); assert.equal(error.status, status); assert.ok(!error.message.includes(key)); }
  for (const status of [404, 405, 501]) { const { body } = await backendHarness({ status }).run(); assert.equal(body.source, "fallback"); assert.deepEqual(Array.from(body.models), ["gpt-image-2"]); }
  assert.equal((await backendHarness({ payload: { bad: "shape" } }).run()).error.status, 502);
  assert.equal((await backendHarness({ payload: { models: [] } }).run()).body.models.length, 0);
  const { error } = await backendHarness({ failure: Object.assign(new Error(key), { status: 502 }) }).run();
  assert.equal(error.status, 502);
  assert.ok(!error.message.includes(key));
});
