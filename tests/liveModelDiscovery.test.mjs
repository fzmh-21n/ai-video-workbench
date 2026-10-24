import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { FALLBACK_MODELS } from "../src/providerCatalog.js";
import { normalizeApiKey } from "../src/apiKey.js";
import { maxforaiModels } from "../src/maxforaiCatalog.js";
import { aiyrxModels } from "../src/aiyrxCatalog.js";
import { UNMAU_BASE_URL, unmauCatalog } from "../src/unmauCatalog.js";
import { SUANLIAI_BASE_URL, SUANLIAI_VIDEO_MODELS, suanliaiCatalog } from "../src/suanliaiCatalog.js";
import { normalizeModelNames, modelKeyFingerprint, modelCatalogMatches, readModelCatalogs, saveModelCatalog, restoreModelCatalogs, PROVIDER_MODEL_CATALOGS_KEY } from "../src/providerModelStore.js";

const serverSource = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
function section(source, start, end) {
  const offset = source.indexOf(start);
  const stop = source.indexOf(end, offset);
  assert.ok(offset >= 0 && stop > offset, `Missing source section: ${start}`);
  return source.slice(offset, stop);
}
function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function serverHarness(adapter, upstreamResponse) {
  const config = { adapter, baseUrl: "https://relay.example", apiKey: "mock-current-key" };
  const state = { requests: [], body: undefined, error: undefined };
  let handler;
  const context = vm.createContext({
    app: { get: (route, callback) => { assert.equal(route, "/api/config/models"); handler = callback; } },
    providerConfig: () => config,
    authHeaders: (provider) => ({ Authorization: `Bearer ${provider.apiKey}` }),
    fallbackModels: () => ["built-in-old-model"],
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    readJson: async (result) => {
      const body = await result.json();
      if (!result.ok) throw Object.assign(new Error(body.message || "upstream failure"), { status: result.status });
      return body;
    },
    upstream: async (url, options = {}) => {
      assert.equal(options.method || "GET", "GET", "discovery must never submit a paid request");
      state.requests.push({ url, ...options });
      return upstreamResponse(url, options);
    },
    maxforaiModels, aiyrxModels, UNMAU_BASE_URL, unmauCatalog,
    SUANLIAI_BASE_URL, SUANLIAI_VIDEO_MODELS, suanliaiCatalog,
  });
  vm.runInContext(section(serverSource, 'app.get("/api/config/models"', 'app.post("/api/materials"'), context);
  return { config, state, run: async () => {
    const res = { json: (body) => { state.body = JSON.parse(JSON.stringify(body)); return res; } };
    await handler({}, res, (error) => { state.error = error; });
    return state;
  } };
}

for (const adapter of ["lwaigc", "pidoi", "fmgo", "globalaiopc", "maxforai"]) {
  test(`${adapter} returns every live model without a built-in name whitelist or injection`, async () => {
    const harness = serverHarness(adapter, () => response({ data: [{ id: "supplier/New-SD2.5-v99" }, { id: "完全陌生模型" }, { id: "supplier/New-SD2.5-v99" }] }));
    const state = await harness.run();
    assert.equal(state.error, undefined);
    assert.deepEqual(state.body.models, ["supplier/New-SD2.5-v99", "完全陌生模型"]);
    assert.equal(state.body.source, "live");
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].url, "https://relay.example/v1/models");
    assert.equal(state.requests[0].headers.Authorization, "Bearer mock-current-key");
  });

  test(`${adapter} preserves an explicitly empty live directory rather than reviving fallback models`, async () => {
    const state = await serverHarness(adapter, () => response({ data: [] })).run();
    assert.equal(state.error, undefined);
    assert.deepEqual(state.body.models, []);
    assert.equal(state.body.source, "live");
  });
}

for (const status of [404, 500, 503]) {
  test(`discovery HTTP ${status} fallback is explicitly unverified, not successful Key authorization`, async () => {
    const state = await serverHarness("pidoi", () => response({ message: "directory unavailable" }, status)).run();
    assert.deepEqual(state.body.models, ["built-in-old-model"]);
    assert.equal(state.body.source, "fallback");
    assert.match(state.body.warning, /未核实.*Key.*权限/);
  });
}

test("discovery authentication failure never masquerades as a successful fallback list", async () => {
  const state = await serverHarness("lwaigc", () => response({ message: "invalid key" }, 401)).run();
  assert.equal(state.body, undefined);
  assert.equal(state.error.status, 401);
});

for (const status of [401, 403]) {
  test(`Suanliai two HTTP ${status} directory failures never fall back to unverified built-ins`, async () => {
    const state = await serverHarness("suanliai", () => response({ message: "account authorization failed" }, status)).run();
    assert.equal(state.requests.length, 2);
    assert.equal(state.body, undefined);
    assert.equal(state.error.status, status);
  });
}

test("AIYRX empty live directory is not replaced by built-in models", async () => {
  const state = await serverHarness("aiyrx", () => response({ data: [] })).run();
  assert.deepEqual(state.body.models, []);
  assert.equal(state.error, undefined);
});

test("Unmau retains newly authorized models if the optional pricing endpoint fails", async () => {
  const state = await serverHarness("unmau", (url) => url.endsWith("/api/pricing")
    ? response({ message: "pricing not synchronized" }, 503)
    : response({ data: [{ id: "new-opaque-model", object: "model" }] })).run();
  assert.equal(state.error, undefined);
  assert.deepEqual(state.body.models, ["new-opaque-model"]);
});

test("Unmau empty authorization is not replaced by a populated pricing catalog", async () => {
  const state = await serverHarness("unmau", (url) => url.endsWith("/api/pricing")
    ? response({ data: [{ model_name: "priced-but-not-authorized", supported_endpoint_types: ["openai-video"] }] })
    : response({ data: [] })).run();
  assert.deepEqual(state.body.models, []);
});

test("Unmau recognizes a direct empty authorization array instead of returning the pricing table", async () => {
  const state = await serverHarness("unmau", (url) => url.endsWith("/api/pricing")
    ? response({ data: [{ model_name: "priced-but-not-authorized", supported_endpoint_types: ["openai-video"] }] })
    : response([])).run();
  assert.equal(state.error, undefined);
  assert.deepEqual(state.body.models, []);
});

test("Unmau recognizes a direct new-ID authorization array before pricing synchronization", async () => {
  const state = await serverHarness("unmau", (url) => url.endsWith("/api/pricing")
    ? response({ data: [{ model_name: "older-price-row", supported_endpoint_types: ["openai-video"] }] })
    : response(["new-opaque-model"])).run();
  assert.equal(state.error, undefined);
  assert.deepEqual(state.body.models, ["new-opaque-model"]);
});

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
function clientHarness(adapter, body, storage = memoryStorage(), beforeReply) {
  const state = { draft: { id: "profile-a", adapter, baseUrl: "https://relay.example", model: "supplier/New-SD2.5-v99" }, models: {}, catalogs: {}, statuses: [], testing: [], requests: [] };
  const key = "mock-client-key";
  let context;
  context = vm.createContext({
    draft: state.draft, draftKey: key, FALLBACK_MODELS, normalizeModelNames, modelKeyFingerprint, modelCatalogMatches,
    modelCatalogRevisionRef: { current: 0 }, modelRequestScopeRef: { current: "" },
    inferAdapter: () => adapter,
    headersFor: (profile, explicitKey) => ({ "x-api-key": explicitKey, "x-api-adapter": profile.adapter }),
    readModelCatalogs: () => readModelCatalogs(storage),
    saveModelCatalog: (profile, fingerprint, payload) => saveModelCatalog(profile, fingerprint, payload, storage),
    setTesting: (value) => state.testing.push(value),
    setConfigStatus: (value) => state.statuses.push(value),
    setModelOptions: (update) => { state.models = update(state.models); },
    setModelCatalogs: (update) => { state.catalogs = update(state.catalogs); },
    setDraft: (update) => { state.draft = update(state.draft); context.draft = state.draft; updateScope(); },
    fetch: async (url, options) => {
      state.requests.push({ url, ...options });
      beforeReply?.(state, context);
      updateScope();
      const result = typeof body === "function" ? await body(url, options, state, context) : body;
      return { ok: true, json: async () => result };
    },
  });
  function updateScope() {
    const current = context.draft;
    context.modelRequestScopeRef.current = JSON.stringify([current.id, current.baseUrl, current.adapter, normalizeApiKey(context.draftKey)]);
  }
  updateScope();
  vm.runInContext(section(appSource, "function normalizeModels(", "function statusLabel(")
    + section(appSource, "  async function testProfile()", "  function selectProjectFolder("), context);
  return { state, storage, key, context, updateScope, run: () => { updateScope(); return context.testProfile(); } };
}

for (const adapter of ["lwaigc", "pidoi", "fmgo", "maxforai"]) {
  test(`${adapter} test button preserves the complete live list and saves it for same-Key restart`, async () => {
    const expected = ["supplier/New-SD2.5-v99", "新的模型/原样ID"];
    const harness = clientHarness(adapter, { models: expected, source: "live" });
    await harness.run();
    assert.deepEqual(Array.from(harness.state.models["profile-a"]), expected);
    assert.equal(harness.state.draft.model, expected[0]);
    assert.equal(harness.state.requests[0].cache, "no-store");
    assert.equal(harness.state.requests[0].headers["x-api-key"], harness.key);
    const restored = await restoreModelCatalogs([harness.state.draft], () => harness.key, harness.storage);
    assert.deepEqual(restored["profile-a"].models, expected);
    assert.deepEqual(await restoreModelCatalogs([harness.state.draft], () => "different-key", harness.storage), {});
    assert.ok(!harness.storage.getItem(PROVIDER_MODEL_CATALOGS_KEY).includes(harness.key));
  });
}

test("test button preserves an empty authorization directory without appending fallback models", async () => {
  const harness = clientHarness("lwaigc", { models: [], source: "live" });
  await harness.run();
  assert.deepEqual(Array.from(harness.state.models["profile-a"]), []);
  assert.match(harness.state.statuses.at(-1), /没有返回可用模型/);
  const restored = await restoreModelCatalogs([harness.state.draft], () => harness.key, harness.storage);
  assert.deepEqual(restored["profile-a"].models, []);
});

test("a live response without metadata does not inherit another Key's previous capabilities or labels", async () => {
  const harness = clientHarness("lwaigc", { models: ["new-current-model"], source: "live" });
  harness.state.draft = { ...harness.state.draft,
    routeCapabilities: { "new-current-model": { images: 50, durations: [60] } },
    routeLabels: { "new-current-model": "stale metadata from previous Key" },
  };
  harness.context.draft = harness.state.draft;
  await harness.run();
  assert.deepEqual(Object.keys(harness.state.draft.routeCapabilities), []);
  assert.deepEqual(Object.keys(harness.state.draft.routeLabels), []);
  assert.deepEqual(harness.state.catalogs["profile-a"].capabilities, {});
  assert.deepEqual(harness.state.catalogs["profile-a"].labels, {});
});

test("temporary fallback keeps a matching Key's last live directory rather than replacing it with stale names", async () => {
  const storage = memoryStorage();
  const profile = { id: "profile-a", adapter: "lwaigc", baseUrl: "https://relay.example" };
  saveModelCatalog(profile, await modelKeyFingerprint("mock-client-key"), { models: ["previous-live-model"], source: "live" }, storage);
  const harness = clientHarness("lwaigc", { models: ["built-in-old-model"], source: "fallback", warning: "目录暂不可用" }, storage);
  await harness.run();
  assert.deepEqual(Array.from(harness.state.models[profile.id]), ["previous-live-model"]);
  assert.equal(harness.state.catalogs[profile.id].source, "cached");
  assert.match(harness.state.statuses.at(-1), /保留.*上次读取/);
});

test("temporary fallback cannot borrow another Key's cached authorized model list", async () => {
  const storage = memoryStorage();
  saveModelCatalog({ id: "profile-a", adapter: "lwaigc", baseUrl: "https://relay.example" }, await modelKeyFingerprint("another-key"), { models: ["other-account-model"], source: "live" }, storage);
  const harness = clientHarness("lwaigc", { models: ["unverified-built-in"], source: "fallback", warning: "未核实权限" }, storage);
  await harness.run();
  assert.deepEqual(Array.from(harness.state.models["profile-a"]), ["unverified-built-in"]);
  assert.equal(harness.state.catalogs["profile-a"].source, "fallback");
});

test("a delayed response does not overwrite a different profile opened during discovery", async () => {
  const harness = clientHarness("lwaigc", { models: ["new-model"], source: "live" }, undefined, (state, context) => {
    state.draft = { id: "profile-b", adapter: "lwaigc", baseUrl: "https://another.example", model: "keep-this-model" };
    context.draft = state.draft;
  });
  await harness.run();
  assert.equal(harness.state.draft.id, "profile-b");
  assert.equal(harness.state.draft.model, "keep-this-model");
  assert.equal(harness.state.models["profile-a"], undefined);
  assert.equal(harness.state.models["profile-b"], undefined);
});

for (const change of ["Key", "URL", "adapter"]) {
  test(`same-profile ${change} change discards an old discovery response and does not cache it`, async () => {
    const harness = clientHarness("lwaigc", { models: ["old-key-only-model"], source: "live" }, undefined, (state, context) => {
      if (change === "Key") context.draftKey = "new-mock-key";
      else {
        state.draft = { ...state.draft, ...(change === "URL" ? { baseUrl: "https://new-relay.example" } : { adapter: "newapi" }) };
        context.draft = state.draft;
      }
    });
    await harness.run();
    assert.deepEqual(harness.state.models, {});
    assert.deepEqual(harness.state.catalogs, {});
    assert.deepEqual(readModelCatalogs(harness.storage), {});
    assert.ok(!harness.state.statuses.some((status) => /连接成功/.test(status)));
    assert.equal(harness.state.draft.model, "supplier/New-SD2.5-v99");
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("an older request's finally cannot clear the busy state of a newer parallel discovery", async () => {
  const first = deferred();
  const second = deferred();
  const harness = clientHarness("lwaigc", (_url, _options, state) => state.requests.length === 1 ? first.promise : second.promise);
  const firstRun = harness.run();
  harness.context.draftKey = "new-mock-key";
  const secondRun = harness.run();
  assert.deepEqual(harness.state.testing, [true, true]);
  first.resolve({ models: ["stale-model"], source: "live" });
  await firstRun;
  assert.deepEqual(harness.state.testing, [true, true]);
  assert.deepEqual(harness.state.models, {});
  second.resolve({ models: ["current-model"], source: "live" });
  await secondRun;
  assert.deepEqual(harness.state.testing, [true, true, false]);
  assert.deepEqual(Array.from(harness.state.models["profile-a"]), ["current-model"]);
  assert.equal(harness.state.draft.model, "current-model");
});

function restoreEffectHarness() {
  const restoring = deferred();
  const state = { catalogs: "not-restored", models: "not-restored", profiles: [{ id: "profile-a", model: "current-model" }] };
  let cleanup;
  const context = vm.createContext({
    modelCatalogRevisionRef: { current: 0 }, profiles: state.profiles, keyFor: () => "mock-key",
    restoreModelCatalogs: () => restoring.promise,
    useEffect: (callback) => { cleanup = callback(); },
    setModelCatalogs: (catalogs) => { state.catalogs = catalogs; },
    setModelOptions: (models) => { state.models = models; },
    setProfiles: (update) => { state.profiles = update(state.profiles); },
  });
  const marker = appSource.indexOf("    const revision = modelCatalogRevisionRef.current;", appSource.indexOf("function Workbench("));
  const start = appSource.lastIndexOf("  useEffect(() => {", marker);
  const end = appSource.indexOf("  useEffect(() => localStorage.setItem(ACTIVE_KEY", marker);
  assert.ok(start >= 0 && marker > start && end > marker);
  vm.runInContext(appSource.slice(start, end), context);
  return { state, context, cleanup: () => cleanup(), resolve: async () => {
    restoring.resolve({ "profile-a": { models: ["cached-model"], capabilities: { "cached-model": { images: 9 } }, labels: { "cached-model": "cached" } } });
    await restoring.promise;
    await Promise.resolve();
  } };
}

test("startup restore cannot replace a newer catalog revision after a test/save/delete", async () => {
  const harness = restoreEffectHarness();
  harness.context.modelCatalogRevisionRef.current += 1;
  await harness.resolve();
  assert.equal(harness.state.catalogs, "not-restored");
  assert.equal(harness.state.models, "not-restored");
  assert.equal(harness.state.profiles[0].model, "current-model");
});

test("startup restore still loads matching models and capabilities when no newer action occurred", async () => {
  const harness = restoreEffectHarness();
  await harness.resolve();
  assert.deepEqual(Array.from(harness.state.models["profile-a"]), ["cached-model"]);
  assert.equal(harness.state.profiles[0].routeCapabilities["cached-model"].images, 9);
});

test("an unmounted startup restore performs no state writes", async () => {
  const harness = restoreEffectHarness();
  harness.cleanup();
  await harness.resolve();
  assert.equal(harness.state.catalogs, "not-restored");
  assert.equal(harness.state.models, "not-restored");
});
