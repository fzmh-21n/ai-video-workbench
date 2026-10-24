import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { matchSeedanceSubmission, seedanceSubmissionJournal, seedanceSubmissionKey, seedanceTaskHistory, seedanceReplayAllowed } from "../src/seedanceSubmissionRecovery.js";
import { beginBatchSubmission, failBatchSubmission, recoverInterruptedBatchItems, canBatchSubmit, overnightRetryableItems } from "../src/batchPrompts.js";
import { taskReuseSnapshot } from "../src/taskReuse.js";

const submission = { idempotencyKey: "key-a", createdAt: "2026-10-12T07:48:16Z", request: { model: "seedance-2.5", input: { prompt: "第27集：同一节不能串集", media: [{ type: "reference_image", url: "https://test/a" }] }, parameters: { duration: 30, ratio: "16:9", resolution: "720p" } } };
const task = { id: "task-a", model: submission.request.model, input: submission.request.input, parameters: submission.request.parameters, created_at: Date.parse(submission.createdAt) / 1000 + 4, status: "failed" };

test("only recent lost-response 772808 submissions may replay their original request", () => {
  const row = { ...submission, baseUrl: "https://772808.xyz", connectionError: "TimeoutError" };
  const now = Date.parse(submission.createdAt) + 1000;
  assert.equal(seedanceReplayAllowed(row, now), true);
  for (const changed of [{ stopReplay: true }, { connectionError: undefined }, { baseUrl: "https://panda626.com" }, { request: null }])
    assert.equal(seedanceReplayAllowed({ ...row, ...changed }, now), false);
  assert.equal(seedanceReplayAllowed(row, now + 24 * 60 * 60 * 1000), false);
  assert.equal(seedanceReplayAllowed(row, now - 2000), false);
});

test("unknown requests are recovered by original snapshot and time, including failed tasks", () => {
  assert.deepEqual(matchSeedanceSubmission(submission, [task]), { taskId: "task-a" });
  for (const changed of [{ input: { prompt: "另一个集数" } }, { created_at: task.created_at - 3600 }, { model: "another-model" }, { parameters: { ...task.parameters, ratio: "9:16" } }, { input: { ...task.input, media: [] } }]) {
    assert.ok(matchSeedanceSubmission(submission, [{ ...task, ...changed }]).reason);
  }
});
test("ambiguous duplicate prompts and missing history never authorize new generation", () => {
  assert.ok(matchSeedanceSubmission(submission, [task, { ...task, id: "task-b" }]).reason);
  assert.ok(matchSeedanceSubmission(submission, []).reason);
  assert.deepEqual(matchSeedanceSubmission(submission, [{ ...task, idempotency_key: "key-a" }, { ...task, id: "other", idempotency_key: "key-b" }]), { taskId: "task-a" });
});
test("journal preserves request through state updates and tolerates an incomplete last line", () => {
  const rows = seedanceSubmissionJournal(`${JSON.stringify(submission)}\n${JSON.stringify({ idempotencyKey: "key-a", state: "unknown" })}\n{broken`);
  assert.equal(rows.get("key-a").request.input.prompt, submission.request.input.prompt);
  assert.equal(rows.get("key-a").state, "unknown");
  assert.equal(seedanceSubmissionKey({ error: "幂等编号：b859cd98-753f-4580-b422-04dd0acfbad3" }), "b859cd98-753f-4580-b422-04dd0acfbad3");
});
test("history follows every server cursor using only GET callback and rejects incomplete pagination", async () => {
  const urls = [];
  assert.deepEqual(await seedanceTaskHistory("https://772808.xyz", async (url) => {
    urls.push(url);
    return urls.length === 1 ? { data: [task], has_more: true, next_cursor: "a/b" } : { data: [], has_more: false };
  }), [task]);
  assert.deepEqual(urls, ["https://772808.xyz/v1/videos?limit=20", "https://772808.xyz/v1/videos?limit=20&cursor=a%2Fb"]);
  await assert.rejects(seedanceTaskHistory("https://772808.xyz", async () => ({ data: [], has_more: true })), /分页不完整/);
});

test("interrupted single-task submission retains its original key and is excluded from automatic paid retries", () => {
  const key = "12345678-1234-4123-8123-123456789abc";
  const started = beginBatchSubmission({ id: "item-a", references: [] }, { id: "bear", model: "seedance-2.5" });
  started.lastSubmission = { ...started.lastSubmission, idempotencyKey: key, requestStartedAt: Date.now() };
  const [restored] = recoverInterruptedBatchItems([JSON.parse(JSON.stringify(started))]);
  assert.equal(restored.status, "submission_unknown");
  assert.equal(seedanceSubmissionKey(restored), key);
  assert.equal(canBatchSubmit(restored), false);
  assert.deepEqual(overnightRetryableItems([restored], { itemIds: [restored.id] }), []);
  const failed = failBatchSubmission(started, { message: "连接中断", submissionUnknown: true, idempotencyKey: key }, { id: "bear" });
  assert.equal(seedanceSubmissionKey(failed), key);
});

test("real recovery handler keeps repeated section numbers in their original source episodes and never submits video", async () => {
  const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("  async function recoverSeedanceTasks("), source.indexOf("  async function recoverMeaiccTasks()"));
  const items = [
    { id: "a", sourceName: "第27集.txt", section: 1, prompt: "第一集角色", references: [], status: "submission_unknown", lastSubmission: { profileId: "bear", batchId: "original-batch", idempotencyKey: "key-a" } },
    { id: "b", sourceName: "第28集.txt", section: 1, prompt: "另一个集角色", references: [], status: "submission_unknown", lastSubmission: { profileId: "bear", batchId: "original-batch", idempotencyKey: "key-b" } },
    { id: "c", section: 1, status: "submission_unknown", lastSubmission: { profileId: "other", idempotencyKey: "other-key" } },
  ];
  let stored = [], updated = items, calls = [];
  const context = vm.createContext({ items, apiKey: "mock", activeProfile: { id: "bear", name: "小熊" }, headers: {}, taskProjectName: "当前项目", projectName: "资产", sourceName: "合并批次", seedanceSubmissionKey, taskReuseSnapshot,
    Date, Map, Number, String, JSON, Math, uid: () => "unused", seedanceRecoveryRunningRef: { current: false }, setSeedanceRecovering: () => {}, setBusy: () => {}, onNotice: () => {}, onTasksAdded: () => {},
    putTasks: async (records) => { stored = records; }, setItems: (update) => { updated = update(items); },
    fetch: async (url, options) => {
      calls.push(url);
      assert.equal(url, "/api/tasks/recover-submissions");
      assert.deepEqual(JSON.parse(options.body).idempotencyKeys, ["key-a", "key-b"]);
      return { ok: true, json: async () => ({ results: [{ idempotencyKey: "key-a", submittedPrompt: "原始提交词", parameters: { duration: 30 }, createdAt: submission.createdAt, task: { id: "official-a", status: "failed", error: "后台素材失败", model: "seedance-2.5" } }, { idempotencyKey: "key-b", reason: "后台没有对应记录" }] }) };
    },
  });
  vm.runInContext(handler, context);
  await context.recoverSeedanceTasks();
  assert.equal(calls.length, 1);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].batchTitle, "第27集");
  assert.equal(stored[0].batchSection, 1);
  assert.equal(stored[0].batchId, "original-batch");
  assert.equal(stored[0].prompt, "原始提交词");
  assert.equal(updated[0].status, "generation_failed");
  assert.equal(updated[0].error, "后台素材失败");
  assert.equal(updated[0].lastSubmission.taskCreated, true);
  assert.equal(updated[1].status, "submission_unknown");
  assert.match(updated[1].recoveryNote, /后台没有对应记录.*30 秒后自动继续核对/);
  assert.equal(updated[2], items[2]);
});

function autoRecoveryHarness(items, fetchResponse) {
  const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("  async function recoverSeedanceTasks("), source.indexOf("  async function recoverMeaiccTasks()"));
  const state = { items, requests: [], records: [], notices: [], busy: [], additions: 0 };
  const context = vm.createContext({ items, apiKey: "mock-key", activeProfile: { id: "bear", name: "小熊" },
    headers: {}, taskProjectName: "项目", projectName: "资产", sourceName: "合集",
    Date, Map, Number, String, JSON, Math, seedanceSubmissionKey, taskReuseSnapshot,
    seedanceRecoveryRunningRef: { current: false }, setSeedanceRecovering: () => {},
    setBusy: (value) => state.busy.push(value), onNotice: (value) => state.notices.push(value),
    onTasksAdded: () => { state.additions += 1; }, putTasks: async (records) => { state.records.push(...records); },
    setItems: (update) => { state.items = update(state.items); context.items = state.items; },
    fetch: async (url, options) => {
      assert.equal(url, "/api/tasks/recover-submissions", "only the local read-only recovery route may be used");
      state.requests.push(JSON.parse(options.body).idempotencyKeys);
      return fetchResponse(state, context);
    },
  });
  vm.runInContext(handler, context);
  return { state, context };
}

function unknownItem(key = "original-key") {
  return { id: key, status: "submission_unknown", section: 3, sourceName: "第24集.txt", prompt: "原提示词", references: [],
    lastSubmission: { idempotencyKey: key, profileId: "bear", batchId: "original-batch" } };
}

test("automatic recovery keeps checking after missing history, network loss and throttling, then returns a real failure", async () => {
  let turn = 0;
  const { state, context } = autoRecoveryHarness([unknownItem()], () => {
    turn += 1;
    if (turn === 2) throw new TypeError("网络暂时断开");
    if (turn === 3) return { ok: false, json: async () => ({ message: "限流", retryAfterMs: 90000 }) };
    return { ok: true, json: async () => ({ results: [{ idempotencyKey: "original-key",
      ...(turn === 1 ? { reason: "暂时没有原任务" } : { task: { id: "real-task", model: "seedance-2.5", status: "failed", progress: 100, error: "上游未接受请求；积分已退" }, createdAt: submission.createdAt, submittedPrompt: "原提示词", parameters: { duration: 30 } }),
    }] }) };
  });
  for (const delay of [30000, 30000, 90000]) {
    assert.equal(await context.recoverSeedanceTasks({ automatic: true }), delay);
    assert.equal(state.items[0].status, "submission_unknown");
    assert.equal(state.items[0].lastSubmission.idempotencyKey, "original-key");
    assert.ok(state.items[0].lastSubmission.lastRecoveryAt);
    assert.match(state.items[0].recoveryNote, /自动继续核对/);
    assert.equal(state.records.length, 0);
  }
  await context.recoverSeedanceTasks({ automatic: true });
  assert.equal(state.items[0].status, "generation_failed");
  assert.equal(state.items[0].error, "上游未接受请求；积分已退");
  assert.equal(state.records.length, 1);
  assert.equal(state.notices.length, 1, "waiting checks must not overwrite the main notice every 30 seconds");
  assert.deepEqual(state.busy, [], "read-only background checks must not block existing submission or uploads");
  assert.deepEqual(state.requests, [["original-key"], ["original-key"], ["original-key"], ["original-key"]]);
});

test("automatic recovery rotates over more than 50 pending items without starving the remaining queue", async () => {
  const { state, context } = autoRecoveryHarness(Array.from({ length: 60 }, (_, index) => unknownItem(`key-${index}`)), (state) => ({
    ok: true, json: async () => ({ results: state.requests.at(-1).map((key) => ({ idempotencyKey: key, reason: "未找到" })) }),
  }));
  await context.recoverSeedanceTasks({ automatic: true });
  await context.recoverSeedanceTasks({ automatic: true });
  assert.equal(state.requests[0].length, 50);
  assert.equal(state.requests[1].length, 50);
  assert.ok(Array.from({ length: 10 }, (_, index) => `key-${50 + index}`).every((key) => state.requests[1].includes(key)));
  assert.equal(state.records.length, 0);
});

test("an in-flight lookup cannot overwrite a newly submitted attempt of the same section", async () => {
  const { state, context } = autoRecoveryHarness([unknownItem()], (state) => {
    state.items = [{ ...state.items[0], status: "submitting", lastSubmission: { ...state.items[0].lastSubmission, idempotencyKey: "new-key" } }];
    return { ok: true, json: async () => ({ results: [{ idempotencyKey: "original-key", task: { id: "old-task", status: "failed" }, createdAt: submission.createdAt }] }) };
  });
  await context.recoverSeedanceTasks({ automatic: true });
  assert.equal(state.items[0].status, "submitting");
  assert.equal(state.items[0].lastSubmission.idempotencyKey, "new-key");
});

test("real automatic loop starts on reopen, repeats after waiting/errors, and stops when recovered rows leave the queue", async () => {
  const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
  const effect = source.slice(source.indexOf("  // 待确认只查原任务"), source.indexOf("  const mentionSuggestions"));
  let cleanup, turn = 0;
  const scheduled = [], cancelled = [];
  const context = vm.createContext({ apiKey: "mock", activeProfile: { id: "bear" }, seedanceRecoveryKeys: "original-key",
    useEffect: (callback) => { cleanup = callback(); },
    window: { setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, clearTimeout: (timer) => cancelled.push(timer) },
    seedanceRecoveryHandlerRef: { current: async (options) => {
      assert.equal(options.automatic, true);
      turn += 1;
      if (turn === 3) cleanup(); // Found the original task; React removes the pending key.
      return turn === 2 ? 90000 : 30000;
    } },
  });
  vm.runInContext(effect, context);
  assert.equal(scheduled[0].delay, 1000);
  await scheduled[0].callback();
  assert.equal(scheduled[1].delay, 30000);
  await scheduled[1].callback();
  assert.equal(scheduled[2].delay, 90000);
  await scheduled[2].callback();
  assert.equal(scheduled.length, 3);
  assert.equal(cancelled.length, 1);
});
