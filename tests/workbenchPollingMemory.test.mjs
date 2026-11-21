import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { imageTaskProvider } from "../src/imageProviderSettings.js";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const imageSource = readFileSync(new URL("../src/ImageWorkbench.jsx", import.meta.url), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function effectContaining(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, marker);
  const start = source.lastIndexOf("  useEffect(", markerIndex);
  const closingLine = source.indexOf("\n  }, [", markerIndex);
  return source.slice(start, source.indexOf("\n", closingLine + 1));
}
const appPollEffect = effectContaining(appSource, "const activePending = await getPendingTasks(10)");
const listEffect = effectContaining(appSource, "const result = await listTasks({");
const imageEffect = effectContaining(imageSource, "async function pollTasks()");

function videoHarness(overrides = {}) {
  const state = { reads: 0, requests: [], writes: [], refreshes: 0, auth: [], notices: [] };
  let timer;
  const pending = Array.from({ length: 10 }, (_, index) => ({ id: `video-${index}`, profileId: "profile", status: "processing" }));
  const context = vm.createContext({
    taskDatabaseReady: true,
    pollingRef: { current: false },
    profilesRef: { current: [{ id: "profile", adapter: "canseedream" }] },
    deletedTaskIdsRef: { current: new Set() },
    getPendingTasks: async () => { state.reads += 1; return pending; },
    getFailedTasks: async () => [],
    isWorkbenchAuthFailure: (message) => /请先登录工作台/.test(String(message || "")),
    keyFor: () => "test-key",
    headersFor: () => ({}),
    diagnosticHeaders: () => ({}),
    pollDelayForAdapter: () => 30_000,
    TRANSIENT_NETWORK_STATUSES: new Set([500, 502, 503]),
    putPolledTaskUpdates: async (updates) => { state.writes.push([...updates]); },
    setTaskRefreshVersion: () => { state.refreshes += 1; },
    onAuthExpired: () => state.auth.push("anonymous"),
    setNotice: (value) => state.notices.push(value),
    AbortSignal,
    fetch: async (url) => { state.requests.push(url); return { ok: true, json: async () => ({ status: "completed" }) }; },
    window: { setInterval: (callback) => { timer = callback; return 1; }, clearInterval() {} },
    useEffect: (callback) => callback(),
    ...overrides,
  });
  vm.runInContext(appPollEffect, context);
  return { state, context, tick: () => timer() };
}

test("video polling takes its busy lock before database reads and releases it", async () => {
  const wait = deferred();
  let reads = 0;
  const poll = videoHarness({ getPendingTasks: async () => { reads += 1; await wait.promise; return []; } });
  const first = poll.tick();
  const second = poll.tick();
  await settle();
  assert.equal(reads, 1);
  wait.resolve();
  await Promise.all([first, second]);
  assert.equal(poll.context.pollingRef.current, false);
  await poll.tick();
  assert.equal(reads, 2);
});

test("ten video polling responses produce one database write and one list refresh", async () => {
  const poll = videoHarness();
  await poll.tick();
  assert.equal(poll.state.requests.length, 10);
  assert.equal(poll.state.writes.length, 1);
  assert.equal(poll.state.writes[0].length, 10);
  assert.equal(poll.state.refreshes, 1);
});

test("video polling network or login errors keep tasks recoverable", async () => {
  const poll = videoHarness({ fetch: async () => ({ ok: false, status: 401, json: async () => ({ message: "请先登录工作台" }) }) });
  await poll.tick();
  assert.deepEqual(poll.state.auth, Array(10).fill("anonymous"));
  assert.ok(poll.state.writes.flat().every((task) => task.status === "processing" && task.nextPollAt > 0));
  assert.equal(poll.context.pollingRef.current, false);
});

test("video polling resets the lock even when a database write fails", async () => {
  const poll = videoHarness({ putPolledTaskUpdates: async () => { throw new Error("database unavailable"); } });
  await poll.tick();
  assert.match(poll.state.notices[0], /原任务已保留.*database unavailable/);
  assert.equal(poll.context.pollingRef.current, false);
});

test("video polling skips future-due tasks without rewriting or refreshing", async () => {
  const poll = videoHarness({ getPendingTasks: async () => [{ id: "later", profileId: "profile", nextPollAt: Date.now() + 60_000 }] });
  await poll.tick();
  assert.equal(poll.state.requests.length, 0);
  assert.equal(poll.state.writes.length, 0);
  assert.equal(poll.state.refreshes, 0);
  assert.equal(poll.context.pollingRef.current, false);
});

test("video polling uses a bounded GET and preserves transient timeout state", async () => {
  let signal;
  const timeout = Object.assign(new Error("query timeout"), { name: "TimeoutError" });
  const poll = videoHarness({ fetch: async (_url, options) => { signal = options.signal; throw timeout; } });
  await poll.tick();
  assert.ok(signal instanceof AbortSignal);
  assert.ok(poll.state.writes[0].every((task) => task.status === "processing" && task.nextPollAt > 0));
  assert.equal(poll.context.pollingRef.current, false);
});

test("aggregating video updates retains the original MEAICC failure recheck", async () => {
  const poll = videoHarness({
    profilesRef: { current: [{ id: "profile", adapter: "meaicc" }] },
    fetch: async () => ({ ok: true, json: async () => ({ status: "failed", error: "视频生成失败" }) }),
  });
  await poll.tick();
  assert.ok(poll.state.writes[0].every((task) => task.status === "processing" && task.meaiccFailureChecks === 1));
  assert.equal(poll.state.refreshes, 1);
});

test("task list reads never overlap and coalesce pending requests to the latest filters", async () => {
  const wait = deferred();
  const state = { reads: [], activeReads: 0, maximumReads: 0, results: [] };
  let cleanup;
  const context = vm.createContext({
    taskDatabaseReady: true, taskRefreshVersion: 0, taskStatusFilter: "all", taskProjectFilter: "first", taskQuery: "",
    taskListLoadRef: { current: { running: false, refresh: null } },
    useEffect: (callback) => { cleanup = callback(); },
    listTasks: async (options) => {
      state.reads.push(options.projectName);
      state.maximumReads = Math.max(state.maximumReads, ++state.activeReads);
      if (state.reads.length === 1) await wait.promise;
      state.activeReads -= 1;
      return { items: [options.projectName] };
    },
    getTaskProjectNames: async () => [],
    setTasks: (items) => state.results.push([...items]),
    setTaskProjectOptions() {}, setNotice() {},
  });
  vm.runInContext(listEffect, context);
  for (const project of ["second", "third"]) {
    cleanup();
    context.taskProjectFilter = project;
    vm.runInContext(listEffect, context);
  }
  await settle();
  assert.equal(state.maximumReads, 1);
  wait.resolve();
  await settle();
  assert.deepEqual(state.reads, ["first", "third"]);
  assert.deepEqual(state.results, [["third"]]);
});

function imageHarness(overrides = {}) {
  const state = { requests: [], updates: 0 };
  let timer;
  const tasks = Array.from({ length: 25 }, (_, index) => ({ id: `image-${index}`, providerId: "profile", status: "processing" }));
  const context = vm.createContext({
    tasksRef: { current: tasks },
    imagePollingRef: { current: false },
    imagePollCursorRef: { current: 0 },
    providersRef: { current: [{ id: "profile", name: "Mock image relay", adapter: "fmgo", baseUrl: "https://mock.invalid", model: "gpt-image-2" }] },
    imageTaskProvider,
    readCredentials: () => ({ apiKey: "test-key" }),
    profileHeaders: () => ({}),
    AbortSignal,
    fetch: async (url) => { state.requests.push(url); return { ok: true, json: async () => ({ status: "processing" }) }; },
    setTasks: (updater) => { state.updates += 1; context.tasksRef.current = updater(context.tasksRef.current); },
    useEffect: (callback) => callback(),
    window: { setInterval: (callback) => { timer = callback; return 1; }, clearInterval() {} },
    ...overrides,
  });
  vm.runInContext(imageEffect, context);
  return { state, context, tick: () => timer() };
}

test("image polling checks at most ten tasks and fairly reaches all pending tasks", async () => {
  const poll = imageHarness();
  await settle();
  assert.equal(poll.state.requests.length, 10);
  await poll.tick();
  await poll.tick();
  assert.equal(new Set(poll.state.requests).size, 25);
  assert.equal(poll.state.requests.length, 30);
  assert.equal(poll.state.updates, 3);
});

test("slow image polling does not start additional overlapping rounds", async () => {
  const wait = deferred();
  let requests = 0;
  const poll = imageHarness({ fetch: async () => { requests += 1; await wait.promise; return { ok: true, json: async () => ({ status: "processing" }) }; } });
  const overlapping = poll.tick();
  await settle();
  const pendingRequests = requests;
  wait.resolve();
  await overlapping;
  await settle();
  assert.equal(pendingRequests, 10);
  assert.equal(poll.context.imagePollingRef.current, false);
});

test("image query timeouts preserve generation state and release the busy lock", async () => {
  let signal;
  const poll = imageHarness({ fetch: async (_url, options) => { signal = options.signal; throw new Error("temporarily unavailable"); } });
  await settle();
  assert.ok(signal instanceof AbortSignal);
  assert.equal(poll.context.imagePollingRef.current, false);
  assert.ok(poll.context.tasksRef.current.every((task) => task.status === "processing"));
  assert.equal(poll.context.tasksRef.current.filter((task) => task.pollError).length, 10);
});
