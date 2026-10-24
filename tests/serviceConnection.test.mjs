import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { redactDiagnosticValue } from "../src/diagnostics.js";

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const checkIndex = source.indexOf("    async function checkService()");
const effect = source.slice(source.lastIndexOf("  useEffect(", checkIndex), source.indexOf("  useEffect(", checkIndex));

async function harness(results) {
  const state = { notices: [], logs: [], timers: [], requests: [], cancelledTimers: [] };
  let cleanup;
  const context = vm.createContext({
    performance: { now: () => state.requests.length * 100 },
    AbortSignal: { timeout: (ms) => ({ timeoutMs: ms }) },
    useEffect: (callback) => { cleanup = callback(); },
    setServiceConnection: (value) => state.notices.push(value),
    setServiceUnavailable: (value) => state.notices.push(value ? "disconnected" : "healthy"),
    recordDiagnostic: (value) => state.logs.push(value),
    window: {
      setTimeout: (callback, delay) => { state.timers.push({ callback, delay }); return state.timers.length; },
      setInterval: (callback, delay) => { state.timers.push({ callback, delay, repeat: true }); return state.timers.length; },
      clearTimeout: (id) => state.cancelledTimers.push(id),
      clearInterval: (id) => state.cancelledTimers.push(id),
    },
    fetch: async (url, options) => {
      assert.equal(url, "/api/health");
      assert.equal(options.cache, "no-store");
      assert.equal(options.method, undefined, "connection checks must never create or retry media tasks");
      const result = results[Math.min(state.requests.length, results.length - 1)];
      state.requests.push({ url, options });
      if (result instanceof Error) throw result;
      return typeof result === "function" ? result() : result;
    },
  });
  vm.runInContext(effect, context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  return { state, cleanup: () => cleanup(), settle, advance: async () => {
    const timer = state.timers.shift();
    assert.ok(timer, "a connection recheck must be scheduled");
    if (timer.repeat) state.timers.push(timer);
    await timer.callback();
    await settle();
  } };
}

const healthy = { ok: true, status: 200 };
const timeout = Object.assign(new Error("private text must not enter diagnostics"), { name: "TimeoutError" });

test("one timed-out health request shows slow connection instead of claiming the server disconnected", async () => {
  const { state } = await harness([timeout]);
  assert.equal(state.notices.at(-1), "slow");
  assert.equal(state.logs[0].stage, "client_service_health_failed");
  assert.equal(state.logs[0].consecutiveFailures, 1);
  assert.equal(state.logs[0].error, "TimeoutError");
  assert.ok(state.logs[0].durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(state.logs), /private text/);
});

test("only three consecutive failures show unavailable, and successful recovery resets the count", async () => {
  const { state, advance } = await harness([timeout, timeout, timeout, healthy, timeout]);
  await advance();
  assert.equal(state.notices.at(-1), "slow");
  await advance();
  assert.equal(state.notices.at(-1), "disconnected");
  await advance();
  assert.equal(state.notices.at(-1), "healthy");
  assert.equal(state.logs.at(-1).stage, "client_service_health_recovered");
  assert.equal(state.logs.at(-1).previousFailures, 3);
  await advance();
  assert.equal(state.notices.at(-1), "slow");
  assert.equal(state.logs.at(-1).consecutiveFailures, 1);
});

test("healthy checks do not fill the diagnostic log and intermittent failures do not accumulate", async () => {
  const { state, advance } = await harness([healthy, timeout, healthy, healthy, timeout]);
  assert.equal(state.logs.length, 0);
  for (let index = 0; index < 4; index += 1) await advance();
  assert.equal(state.logs.length, 3);
  assert.ok(!state.notices.includes("disconnected"));
});

test("HTTP errors record the actual health status without reading arbitrary response text", async () => {
  const { state } = await harness([{ ok: false, status: 503 }]);
  assert.equal(state.notices.at(-1), "slow");
  assert.equal(state.logs[0].status, 503);
  assert.match(state.logs[0].reason, /503/);
});

test("health checks are serialized and cleanup ignores a late response", async () => {
  let resolveResponse;
  const { state, cleanup, settle } = await harness([() => new Promise((resolve) => { resolveResponse = resolve; })]);
  assert.equal(state.requests.length, 1);
  assert.equal(state.timers.length, 0, "the next timer must wait for this request to finish");
  cleanup();
  resolveResponse(healthy);
  await settle();
  assert.equal(state.notices.length, 0);
  assert.equal(state.logs.length, 0);
  assert.equal(state.timers.length, 0);
});

test("slow and unavailable messages do not claim that video generation has failed", () => {
  assert.ok(source.includes("连接较慢"));
  assert.ok(source.includes("连续多次无法连接工作台"));
  assert.ok(!source.includes("工作台服务已断开，任务状态暂时无法更新"));
});

test("a relay log export includes this session's workbench health events without leaking another relay or session", () => {
  const diagnosticsSource = readFileSync(new URL("../src/diagnostics.js", import.meta.url), "utf8");
  const entries = [
    { sessionId: "current", adapter: "seedancevideo", stage: "client_task_submit_completed" },
    { sessionId: "current", scope: "workbench", stage: "client_service_health_failed", consecutiveFailures: 1 },
    { sessionId: "current", scope: "workbench", stage: "client_service_health_recovered" },
    { sessionId: "other", scope: "workbench", stage: "client_service_health_failed" },
    { sessionId: "current", adapter: "maxforai", stage: "client_task_submit_failed" },
  ];
  const context = vm.createContext({ Date, String, Array, redactDiagnosticValue,
    diagnosticSessionId: () => "current", readEntries: () => entries });
  vm.runInContext(diagnosticsSource.slice(diagnosticsSource.indexOf("export function diagnosticExportPayload"), diagnosticsSource.indexOf("function filenamePart")).replace("export function", "function"), context);
  const payload = context.diagnosticExportPayload({ name: "小熊", adapter: "seedancevideo" }, { entries: [] });
  assert.equal(payload.clientEntries.length, 3);
  assert.equal(payload.summary.failures.length, 1);
  assert.equal(payload.summary.failures[0].scope, "workbench");
  assert.doesNotMatch(JSON.stringify(payload), /maxforai|"other"/);
});
