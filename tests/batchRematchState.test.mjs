import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as batch from "../src/batchPrompts.js";
import * as references from "../src/batchReferences.js";
import * as project from "../src/projectReferences.js";
import * as downloads from "../src/taskDownload.js";
import { needsBatchStatusSync, syncBatchTaskStates } from "../src/batchPerformance.js";
import { normalizedTaskProgress } from "../src/taskProgress.js";
import { taskReuseSnapshot } from "../src/taskReuse.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
const profile = { id: "mock", name: "本地测试", model: "mock" };
const prompt = "【出场人物】角色图_001_测试.png\n【角色声线】声音1\n【画面】角色看向门口。";
const assets = [["image", "角色图_001_测试.png"], ["audio", "声音1.wav"]].map(([kind, name]) => ({
  key: `${kind}:${name}`, kind, name, stem: name.replace(/\.[^.]+$/, ""), file: new File(["fixture"], name),
}));

function extract(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `extract real ${from}`);
  return source.slice(start, end);
}

function item(status = "generation_failed", id = "retry") {
  return {
    id, section: 1, sourceName: "第01集.txt", prompt, references: [], status,
    taskIds: [`old-${id}`], progress: 100, error: "原失败原因", downloaded: false, downloadedCount: 0,
    lastSubmission: { batchId: "old-batch", profileId: "mock", attemptedAt: 100, failedAt: 200, statusCode: 500 },
  };
}

function storedTask(row, changes = {}) {
  return {
    id: row.taskIds[0], status: "failed", error: "原任务失败", progress: 100,
    batchId: "old-batch", batchTitle: "第01集", batchSection: row.section,
    prompt: row.prompt, reuseSnapshot: taskReuseSnapshot(row), ...changes,
  };
}

function harness(initialItems) {
  let items = initialItems;
  let saved;
  let nextId = 0;
  const notices = [];
  const context = vm.createContext({
    ...batch, ...references, ...project, ...downloads, normalizedTaskProgress,
    reindex: references.reindexBatchReferences, projectAssets: assets, capability: { images: 9, audios: 3, videos: 3 },
    readMediaDuration: async () => null, uid: () => `reference-${++nextId}`,
    items, itemsRef: { current: items }, setBusy: () => {}, onNotice: (message) => notices.push(message),
    STORAGE_KEY: "video-workbench-batch-v1", localStorage: { getItem: () => saved },
    setItems(update) {
      items = typeof update === "function" ? update(items) : update;
      context.items = items;
      context.itemsRef.current = items;
    },
  });
  vm.runInContext(extract("function withDownloadedFlags(", "function persistedOvernightPlan("), context);
  vm.runInContext(extract("  async function matchItem(", "  async function addManualFiles("), context);
  vm.runInContext(extract("  async function matchAllAudio(", "  async function undoBatchItemUnusable("), context);
  return {
    context, notices, get items() { return items; },
    async match(method, id = items[0].id) {
      if (["matchItem", "matchAudioItem"].includes(method)) {
        const matched = await context[method](items.find((row) => row.id === id));
        context.setItems((rows) => rows.map((row) => row.id === id ? matched : row));
      } else await context[method](id);
    },
    refresh(tasks) {
      context.setItems(context.withDownloadedFlags(items, tasks));
      context.setItems(syncBatchTaskStates(items, tasks));
    },
    restart() {
      saved = JSON.stringify({ items: batch.batchSerializable(items) });
      context.setItems(context.persistedState().items);
    },
  };
}

test("real single, bulk and audio rematching survives task refreshes and restart without retrying old failures", async (t) => {
  for (const method of ["matchItem", "matchAudioItem", "matchOne", "matchAll", "matchAllAudio"]) {
    for (const initialStatus of ["generation_failed", "failed"]) await t.test(`${method} from ${initialStatus}`, async () => {
      const original = item(initialStatus);
      const task = storedTask(original);
      const unchangedTask = structuredClone(task);
      const state = harness([original]);
      const plan = { itemIds: [original.id], autoRetryFailures: true };
      await state.match(method);
      assert.equal(state.items[0].status, "matched");
      assert.equal(state.items[0].error, "");
      assert.ok(state.items[0].references.length > 0, "the real project planner matched fixture assets");
      for (let refresh = 0; refresh < 4; refresh += 1) {
        if (refresh === 2) state.restart();
        state.refresh([task]);
        const matched = state.items[0];
        assert.equal(matched.status, "matched", "old task refresh must not undo an explicit reference rematch");
        assert.equal(matched.error, "");
        assert.deepEqual([...matched.taskIds], original.taskIds, "history IDs are retained rather than deleted to hide the failure");
        assert.deepEqual(JSON.parse(JSON.stringify(matched.lastSubmission)), original.lastSubmission);
        assert.equal(batch.overnightRetryableItems(state.items, plan).length, 0, "a prepared row must not reenter unattended retries");
        assert.equal(batch.canBatchSubmit(matched), true);
        assert.equal(needsBatchStatusSync(matched), false);
      }
      assert.deepEqual(task, unchangedTask, "the historical failed record and its reason are untouched");
    });
  }
});

test("prepared rows are not overwritten by old completed, queued, failed or unusable tasks", async (t) => {
  const cases = [
    ["completed", { status: "completed", downloadedAtMs: 123 }],
    ["queued", { status: "queued", progress: 40 }],
    ["failed", { status: "failed" }],
    ["unusable", { status: "completed", reviewStatus: "dissatisfied" }],
  ];
  for (const status of ["unmatched", "matched"]) {
    for (const [label, patch] of cases) await t.test(`${status} with old ${label}`, () => {
      const prepared = { ...item(status), error: "" };
      const task = storedTask(prepared, patch);
      const candidates = downloads.batchItemDownloadCandidates(prepared, [task]);
      assert.equal(batch.reconciledBatchTerminalState(prepared, [task], candidates.length > 0), null);
      const state = harness([prepared]);
      for (let refresh = 0; refresh < 3; refresh += 1) {
        state.refresh([task]);
        assert.equal(state.items[0].status, status);
        assert.deepEqual([...state.items[0].taskIds], prepared.taskIds);
      }
      assert.equal(downloads.batchItemDownloadCandidates(state.items[0], [task]).length, candidates.length, "historical candidates remain available without controlling draft preparation status");
      assert.equal(batch.overnightRetryableItems(state.items, { itemIds: [prepared.id] }).length, 0);
    });
  }
});

test("an interrupted not-submitted row still recovers its exact recorded task instead of submitting it twice", async (t) => {
  for (const status of ["processing", "completed", "failed"]) await t.test(status, () => {
    const interrupted = { ...item("not_submitted"), taskIds: [],
      lastSubmission: { attemptedAt: 1000, batchId: "accepted-batch", profileId: "mock", model: "mock" } };
    const accepted = storedTask({ ...interrupted, taskIds: ["accepted-task"] }, {
      batchId: "accepted-batch", profileId: "mock", model: "mock", createdAtMs: 1100,
      status, progress: status === "processing" ? 45 : 100, error: status === "failed" ? "已收单任务失败" : "",
    });
    const unrelated = { ...accepted, id: "other-task", batchId: "other-batch", status: "completed", downloadedAtMs: 123 };
    const state = harness([interrupted]);
    state.restart();
    state.refresh([accepted, unrelated]);
    assert.deepEqual([...state.items[0].taskIds], [accepted.id], "the saved submission batch identifies the accepted task precisely");
    assert.equal(state.items[0].status, { processing: "generating", completed: "generated", failed: "generation_failed" }[status]);
    assert.equal(state.items[0].error, accepted.error);
    assert.equal(state.items[0].downloaded, false, "another submission's downloaded result is not inherited");
    assert.equal(batch.canBatchSubmit(state.items[0]), status === "failed");
  });
});

test("an explicit new submission still synchronizes its new task's failure or completion", async (t) => {
  for (const terminalStatus of ["failed", "completed"]) await t.test(terminalStatus, async () => {
    const original = item();
    const history = storedTask(original);
    const state = harness([original]);
    await state.match("matchOne");
    const matched = state.items[0];
    const submitted = batch.beginBatchSubmission(matched, profile, 1000, "new-batch");
    assert.equal(submitted.status, "submitting");
    assert.deepEqual(submitted.taskIds, []);
    assert.deepEqual([...matched.taskIds], original.taskIds, "starting a new submission never mutates the retained history snapshot");
    state.context.setItems([{ ...submitted, status: "generating", taskIds: ["new-task"] }]);
    const accepted = state.items[0];
    const current = storedTask(accepted, { id: "new-task", status: "processing", progress: 45, error: "", batchId: "new-batch" });
    state.refresh([history, current]);
    assert.equal(state.items[0].status, "generating");
    assert.equal(state.items[0].progress, 45);
    state.refresh([history, { ...current, status: terminalStatus, progress: 100, error: terminalStatus === "failed" ? "新任务失败" : "" }]);
    assert.equal(state.items[0].status, terminalStatus === "failed" ? "generation_failed" : "generated");
    assert.equal(state.items[0].error, terminalStatus === "failed" ? "新任务失败" : "");
    assert.deepEqual([...state.items[0].taskIds], ["new-task"]);
    assert.equal(history.status, "failed");
    assert.equal(history.error, "原任务失败");
  });
});

test("rematching a failed row leaves its generating neighbor's progress and completion synchronization working", async () => {
  const original = item();
  const neighbor = { ...item("generating", "neighbor"), section: 2, progress: 10, error: "" };
  const history = storedTask(original);
  const active = storedTask(neighbor, { status: "processing", progress: 65, error: "" });
  const state = harness([original, neighbor]);
  await state.match("matchAll");
  assert.equal(state.items[1], neighbor, "bulk matching skips the in-flight neighbor");
  state.refresh([history, active]);
  assert.equal(state.items[1].status, "generating");
  assert.equal(state.items[1].progress, 65);
  state.refresh([history, { ...active, status: "completed", progress: 100 }]);
  assert.equal(state.items[1].status, "generated");
  assert.equal(state.items[0].status, "matched");
});

test("unknown receipts and in-flight rows remain excluded from bulk rematching and duplicate submission", async () => {
  const rows = ["submission_unknown", "submitting", "submitted", "generating"].map((status) => item(status, status));
  const state = harness(rows);
  for (const row of rows) {
    assert.equal(batch.canBatchMatch(row), false, row.status);
    assert.equal(batch.canBatchSubmit(row), false, row.status);
    assert.equal(batch.canBatchResubmit(row), false, row.status);
  }
  await state.match("matchAll");
  await state.match("matchAllAudio");
  assert.equal(state.items, rows);
  for (const [index, row] of rows.entries()) assert.equal(state.items[index], row);
});

test("single-item rematching cannot make blocked rows eligible for a duplicate submission", async (t) => {
  const cases = ["submission_unknown", "submitting", "submitted", "generating", "generated"].map((status) => [status, { status }]);
  cases.push(["deferred", { status: "matched", deferred: true }]);
  for (const [label, changes] of cases) await t.test(label, async () => {
    const original = { ...item(), ...changes };
    const state = harness([original]);
    await state.match("matchOne");
    assert.equal(state.items[0], original, "single-item matching must not alter a blocked row");
    assert.equal(batch.canBatchSubmit(state.items[0]), false);
    assert.deepEqual([...state.items[0].taskIds], original.taskIds);
    assert.deepEqual(state.items[0].lastSubmission, original.lastSubmission);
  });
});

test("the single-item reference button follows the same matching eligibility guard", () => {
  const button = source.match(/<button disabled=\{([^}]+)\} onClick=\{\(\) => matchOne\(item\.id\)\}>本节一键参考<\/button>/);
  assert.ok(button, "find the real single-item matching control");
  assert.match(button[1], /!canBatchMatch\(item\)/);
});
