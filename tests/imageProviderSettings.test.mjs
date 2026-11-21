import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { imageBaseUrl, IMAGE_PROVIDERS_KEY, loadImageProviders, saveImageProviders, normalizeImageProvider,
  imageProfileHeaders, imageProviderSnapshot, imageTaskProvider } from "../src/imageProviderSettings.js";
import { imageModelsFor, IMAGE_PROVIDER_PROFILES, FMGO_IMAGE_MODELS, CANSEEDREAM_IMAGE_MODELS, QIQI_IMAGE_BASE_URL,
  isFmgoGptImageModel, isFmgoGeminiImageModel, fmgoGptImagePayload, fmgoGeminiImagePayload, canSeeDreamImagePayload } from "../src/imageCatalog.js";
import { imagePromptWithFixedContent } from "../src/imageBatch.js";

const serverSource = readFileSync(new URL("../server.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ui = readFileSync(new URL("../src/ImageWorkbench.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const relay = { ...IMAGE_PROVIDER_PROFILES[0], baseUrl: "https://relay.example.invalid" };
function storage(entries = []) { const values = new Map(entries); return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }
function section(source, start, end) { const index = source.indexOf(start); assert.ok(index >= 0, start); const stop = source.indexOf(end, index + start.length); assert.ok(stop > index, end); return source.slice(index, stop); }
function jobId(job) { return Buffer.from(JSON.stringify({ mediaType: "image", taskId: "mock-task", statusPath: "/v1/tasks/mock-task", ...job })).toString("base64url") + ".mock-signature"; }
const plain = (value) => JSON.parse(JSON.stringify(value));

test("old installations acquire image defaults without changing model choices, keys, prompts or video profiles", () => {
  const old = [["image-workbench-models-v1", '{"image-fmgo":"gpt-image-2-pro"}'], ["video-api-key:image-fmgo", "mock-only"], ["image-workbench-json-prompts-v1", "[]"], ["video-workbench-profiles-v1", "unchanged"]];
  const local = storage(old);
  assert.deepEqual(loadImageProviders(local), IMAGE_PROVIDER_PROFILES);
  assert.deepEqual([...local.values], old);
  local.values.set(IMAGE_PROVIDERS_KEY, "malformed");
  assert.deepEqual(loadImageProviders(local), IMAGE_PROVIDER_PROFILES);
});

test("public image overrides and custom compatible relays persist independently without serializing credentials", () => {
  const local = storage([["video-workbench-profiles-v1", "do-not-touch"]]);
  saveImageProviders([{ ...relay, apiKey: "do-not-save", mediaUploadKey: "do-not-save" }, { ...relay, id: "image-custom-unit", name: "自定义兼容站" }], local);
  const profiles = loadImageProviders(local);
  assert.equal(profiles.length, 4);
  assert.equal(profiles.find((profile) => profile.id === relay.id).baseUrl, relay.baseUrl);
  assert.equal(profiles.find((profile) => profile.id === "image-cansee").baseUrl, IMAGE_PROVIDER_PROFILES[1].baseUrl);
  assert.equal(profiles.find((profile) => profile.id === "image-custom-unit").adapter, "fmgo");
  assert.doesNotMatch(local.getItem(IMAGE_PROVIDERS_KEY), /apiKey|mediaUploadKey|do-not-save/);
  assert.equal(local.getItem("video-workbench-profiles-v1"), "do-not-touch");
});

test("provider switching preserves each configured origin, model and explicit protocol on an unfamiliar host", () => {
  const local = storage();
  saveImageProviders([relay, { ...IMAGE_PROVIDER_PROFILES[1], baseUrl: "https://cansee.example.invalid", model: "Nano2" }], local);
  const profiles = loadImageProviders(local);
  for (const id of ["image-fmgo", "image-cansee", "image-fmgo"]) {
    const profile = profiles.find((item) => item.id === id);
    const headers = imageProfileHeaders(profile, "mock-key");
    assert.equal(headers["x-api-base-url"], profile.baseUrl);
    assert.equal(headers["x-api-adapter"], profile.adapter);
    assert.equal(decodeURIComponent(headers["x-api-model"]), profile.model);
  }
});

test("image URL validation retains the public HTTPS boundary and does not expose credentials or arbitrary paths", () => {
  assert.equal(imageBaseUrl(" https://relay.example.invalid:8443/v1/ "), "https://relay.example.invalid:8443");
  for (const url of ["http://relay.example.invalid", "https://localhost", "https://127.0.0.1", "https://10.0.0.2", "https://172.16.1.2", "https://192.168.0.1", "https://169.254.1.2", "https://[::1]", "https://[fc00::1]", "https://user:pass@relay.example.invalid", "https://relay.example.invalid?key=private", "https://relay.example.invalid#secret", "file:///tmp", "not a URL"]) assert.throws(() => imageBaseUrl(url), /HTTPS|Base URL/);
  assert.throws(() => normalizeImageProvider({ ...relay, adapter: "arbitrary" }), /协议/);
});

test("new and legacy signed image tasks keep their original effective origin after profile edits and provider switching", () => {
  const old = { ...relay, baseUrl: "https://old.example.invalid" };
  const task = { id: jobId(old), providerId: old.id, model: old.model, providerSnapshot: imageProviderSnapshot({ ...old, apiKey: "never-copy" }) };
  assert.doesNotMatch(JSON.stringify(task.providerSnapshot), /apiKey|never-copy/);
  const profiles = [relay, IMAGE_PROVIDER_PROFILES[1]];
  assert.equal(imageTaskProvider(task, profiles).baseUrl, old.baseUrl);
  assert.equal(imageTaskProvider({ ...task, providerSnapshot: undefined }, profiles).baseUrl, old.baseUrl);
  // The signed job takes precedence over an outdated alias stored by the UI.
  assert.equal(imageTaskProvider({ ...task, providerSnapshot: relay }, profiles).baseUrl, old.baseUrl);
  assert.equal(imageTaskProvider({ ...task, id: "old-opaque-task" }, profiles).baseUrl, old.baseUrl);
  assert.equal(imageTaskProvider({ ...task, id: "opaque", providerSnapshot: undefined }, profiles).baseUrl, relay.baseUrl);
  assert.equal(task.id, jobId(old));
});

function configHarness() {
  const context = vm.createContext({ URL, normalizeApiKey: (value) => String(value || "").trim(), QIQI_IMAGE_BASE_URL,
    httpError: (status, message) => Object.assign(new Error(message), { status }) });
  vm.runInContext(section(serverSource, "function isPrivateHost", "function inferAdapter"), context);
  vm.runInContext(section(serverSource, "function providerConfig", "function authHeaders"), context);
  return (profile, scope) => context.providerConfig({ get: (name) => imageProfileHeaders(profile, "mock-key")[name] }, true, scope);
}

test("server image scopes honor public QIQI/FMGO overrides while video/default behavior and validation remain intact", () => {
  const config = configHarness();
  assert.equal(config(relay, "image").baseUrl, relay.baseUrl);
  const qiqi = { ...IMAGE_PROVIDER_PROFILES[2], baseUrl: "https://qiqi.example.invalid" };
  assert.equal(config(qiqi, "image").baseUrl, qiqi.baseUrl);
  assert.equal(config(qiqi, "video").baseUrl, QIQI_IMAGE_BASE_URL);
  assert.equal(config(qiqi).baseUrl, QIQI_IMAGE_BASE_URL);
  for (const url of ["https://127.0.0.1", "http://public.example.invalid", "https://192.168.1.1"]) assert.throws(() => config({ ...qiqi, baseUrl: url }, "image"), /HTTPS|公网/);
  const imageRoutes = section(serverSource, 'app.get("/api/image-tasks/recent"', 'app.post("/api/tasks"');
  assert.equal((imageRoutes.match(/providerConfig\(req, true, "image"\)/g) || []).length, 4);
});

test("server image generation and multipart reference uploads target the configured compatible relay", async () => {
  const requests = [];
  const context = vm.createContext({ FMGO_IMAGE_MODELS, CANSEEDREAM_IMAGE_MODELS, isFmgoGptImageModel, isFmgoGeminiImageModel, fmgoGptImagePayload, fmgoGeminiImagePayload, canSeeDreamImagePayload,
    crypto: { randomUUID: () => "mock-uuid" }, FormData, Blob, URL,
    imageDataUrl: () => "data:image/png;base64,eA==", fileBytes: (file) => file.buffer,
    authHeaders: (_config, extra = {}) => ({ ...extra, Authorization: "Bearer mock-key" }),
    upstream: async (url, options) => { requests.push({ url, options }); return { id: "mock-task", status: "queued" }; },
    readJson: async (response) => response, taskIdFrom: (body) => body.id,
    httpError: (status, message) => Object.assign(new Error(message), { status }),
  });
  vm.runInContext(section(serverSource, "function imageTaskStatusPath", "function verifyJobConfig"), context);
  const input = { prompt: "MOCK ONLY", aspectRatio: "1:1", size: "auto", quality: "auto" };
  for (const files of [[], [{ buffer: Buffer.from("fake image"), mimetype: "image/png", originalname: "mock.png" }]]) {
    const job = await context.createImage({ ...relay, apiKey: "mock-key" }, input, files);
    assert.equal(job.baseUrl, relay.baseUrl);
  }
  assert.equal(requests[0].url, relay.baseUrl + "/v1/images/generations");
  assert.equal(requests[1].url, relay.baseUrl + "/v1/images/edits");
  assert.equal(requests[1].options.body.getAll("image").length, 1);
  await context.createImage({ ...IMAGE_PROVIDER_PROFILES[1], baseUrl: relay.baseUrl }, input, []);
  assert.equal(requests[2].url, relay.baseUrl + "/api/v3/images/generations/tasks");
});

test("server polling and content routes use task-matching configured origin without weakening job checks", async () => {
  const requests = [];
  const handlers = new Map();
  const job = { adapter: "fmgo", baseUrl: relay.baseUrl, mediaType: "image", taskId: "mock-task", statusPath: "/v1/tasks/mock-task" };
  const context = vm.createContext({ app: { get: (path, callback) => handlers.set(path, callback) },
    providerConfig: (_req, _required, scope) => { assert.equal(scope, "image"); return relay; }, decodeJob: () => job,
    PANDA626_BASE_URL: "https://panda.example.invalid", requiresOriginalTaskKey: () => false,
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    upstream: async (url) => { requests.push(url); return { status: "completed" }; }, readJson: async (body) => body,
    authHeaders: () => ({}), normalizeStatus: (value) => value, normalizedTaskProgress: () => 100,
    imageUrlsFrom: () => ["data:image/png;base64,eA=="], dateText: () => null, Buffer,
  });
  vm.runInContext(section(serverSource, "function verifyJobConfig", "async function pollJob"), context);
  const start = serverSource.indexOf('app.get("/api/image-tasks/:id"');
  const next = serverSource.indexOf('\napp.', serverSource.indexOf('app.get("/api/image-tasks/:id/content"', start) + 1);
  vm.runInContext(serverSource.slice(start, next), context);
  let content;
  await handlers.get("/api/image-tasks/:id")({ params: { id: "signed-mock" } }, { json: () => {} }, (error) => { throw error; });
  await handlers.get("/api/image-tasks/:id/content")({ params: { id: "signed-mock" } }, { type: () => ({ send: (bytes) => { content = bytes.toString(); } }) }, (error) => { throw error; });
  assert.deepEqual(requests, [relay.baseUrl + job.statusPath, relay.baseUrl + job.statusPath]);
  assert.equal(content, "x");
  assert.throws(() => context.verifyJobConfig({ ...relay, baseUrl: "https://wrong.example.invalid" }, job), /不一致/);
});

test("frontend settings save persists only the selected profile and leaves imported prompts/history storage untouched", () => {
  const local = storage([["image-workbench-json-prompts-v1", "preserved"], ["image-workbench-tasks-v1", "preserved"]]);
  const context = vm.createContext({ providerDraftKey: "mock-key", providerDraftRemember: false, activeProfile: relay, setApiKey: () => {}, setRememberKey: () => {}, saveCredentials: () => {}, submitting: false, providerDraft: { ...relay, name: "修改飞猫地址" }, providers: IMAGE_PROVIDER_PROFILES,
    normalizeImageProvider, saveImageProviders: (profiles) => saveImageProviders(profiles, local), providersRef: { current: IMAGE_PROVIDER_PROFILES },
    setProviders: () => {}, setModels: (updater) => { context.savedModels = updater({ "image-cansee": "Nano2" }); },
    setActiveId: (id) => { context.activeId = id; }, setProviderDraft: () => {}, setNotice: () => {}, setProviderError: (message) => { throw new Error(message); },
  });
  vm.runInContext(section(ui, "  function saveImageProvider()", "  function saveCurrentCredentials"), context);
  context.saveImageProvider();
  assert.equal(context.activeId, relay.id);
  assert.equal(context.savedModels["image-cansee"], "Nano2");
  assert.equal(loadImageProviders(local)[0].baseUrl, relay.baseUrl);
  assert.equal(local.getItem("image-workbench-json-prompts-v1"), "preserved");
  assert.equal(local.getItem("image-workbench-tasks-v1"), "preserved");
});

test("frontend submission uses edited headers, preserves reference form data and records a credential-free route snapshot", async () => {
  let request;
  let saved;
  const context = vm.createContext({ apiKey: "mock-only-key", workMode: "single", prompt: "MOCK ONLY", fixedContent: "", capability: { references: 5 },
    references: [{ name: "mock.png", file: new Blob(["fake"], { type: "image/png" }) }], activeProfile: relay, model: relay.model,
    aspectRatio: "1:1", size: "auto", quality: "auto", FormData, crypto: { randomUUID: () => "mock-uuid" },
    imageModelsFor, imagePromptWithFixedContent, profileHeaders: imageProfileHeaders, imageProviderSnapshot,
    mapWithConcurrency: async (items, _limit, mapper) => Promise.all(items.map(mapper)),
    setSubmitting: () => {}, setNotice: () => {}, setTasks: (updater) => { saved = updater([]); },
    fetch: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ tasks: [{ id: jobId(relay), status: "queued" }] }) }; },
  });
  vm.runInContext(section(ui, "  async function submitImage()", "  async function fetchImageBlob"), context);
  await context.submitImage();
  assert.equal(request.url, "/api/image-tasks");
  assert.equal(request.options.headers["x-api-base-url"], relay.baseUrl);
  assert.equal(request.options.body.getAll("references").length, 1);
  assert.equal(saved[0].providerSnapshot.baseUrl, relay.baseUrl);
  assert.doesNotMatch(JSON.stringify(saved), /mock-only-key/);
});

test("frontend download resolves legacy signed task origin rather than the currently edited URL", async () => {
  const old = { ...relay, baseUrl: "https://old.example.invalid" };
  const task = { id: jobId(old), providerId: relay.id, model: relay.model, imageUrl: "/api/image-tasks/mock/content" };
  let request;
  const context = vm.createContext({ imageTaskProvider, providersRef: { current: [relay] }, readCredentials: () => ({ apiKey: "mock-only-key" }), profileHeaders: imageProfileHeaders,
    fetch: async (url, options) => { request = { url, options }; return { ok: true, blob: async () => new Blob(["fake image"]) }; },
  });
  vm.runInContext(section(ui, "  async function fetchImageBlob", "  async function loadImage"), context);
  await context.fetchImageBlob(task);
  assert.equal(request.options.headers["x-api-base-url"], old.baseUrl);
  assert.equal(request.url, task.imageUrl);
});
