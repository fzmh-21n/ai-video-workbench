import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { archivedUselessTask, uselessTaskBatches } from "../src/uselessBatches.js";
import { currentCostSummary } from "../src/costAnalytics.js";
import { mergeSubmissionRecord, submissionRecord } from "../src/submissionRecords.js";
import { taskDatabase } from "./helpers/taskDatabase.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const failed = (id, batchId = "batch", extra = {}) => ({
  id, batchId, status: "failed", projectName: "当前项目", createdAtMs: Date.now(),
  prompt: "长提示词", reuseSnapshot: { references: [] }, ...extra,
});

function harness(tasks, { failPutAt = 0, synchronousPutFailure = false } = {}) {
  const { database, stats, insert } = taskDatabase(tasks, { failPutAt, synchronousPutFailure });
  const context = vm.createContext({
    Promise, Date, String, Number, Map, Set, Error,
    IDBKeyRange: { only: (value) => value }, archivedUselessTask, uselessTaskBatches, mergeSubmissionRecord, submissionRecord,
  });
  const source = readFileSync(new URL("../src/taskStore.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
  vm.runInContext(source, context);
  context.databaseFixture = database;
  vm.runInContext("databasePromise = Promise.resolve(databaseFixture)", context);
  return { context, stats, insert };
}

test("archive transaction keeps all ten failed records and accounting while releasing large prompts", async () => {
  const tasks = Array.from({ length: 10 }, (_, index) => failed(`task-${index}`, "batch", {
    cost: 3, usage: { credits: 300 }, profileId: "relay", model: "video",
  }));
  const { context, stats } = harness(tasks);
  const result = plain(await context.archiveUselessBatches(["batch"], "当前项目"));
  assert.deepEqual(result, { taskIds: tasks.map((task) => task.id), batchCount: 1 });
  const stored = plain(await context.allTasks());
  assert.equal(stored.length, 10);
  assert.ok(stored.every((task) => task.archivedAtMs > 0 && !task.prompt && !task.reuseSnapshot));
  assert.deepEqual(stored.map((task) => [task.id, task.cost, task.usage]), tasks.map((task) => [task.id, task.cost, task.usage]));
  assert.deepEqual(currentCostSummary(stored, {}, "day"), currentCostSummary(tasks, {}, "day"));
  assert.equal(stats.modes[0], "readwrite");
  assert.equal(stats.commits, 1);
});

test("a completed or active task hidden by the failed-task filter protects its whole batch", async () => {
  for (const status of ["completed", "processing", "queued"]) {
    const tasks = [failed("visible"), failed("hidden", "batch", { status })];
    const { context, stats } = harness(tasks);
    const filtered = await context.listTasks({ status: "failed" });
    assert.deepEqual(Array.from(filtered.items, (task) => task.id), ["visible"]);
    assert.deepEqual(plain(await context.archiveUselessBatches(["batch"])), { taskIds: [], batchCount: 0 });
    assert.equal(stats.putCount, 0);
    assert.deepEqual(plain(await context.allTasks()), tasks);
  }
});

test("project-scoped cleanup protects cross-project batches while allowing a wholly local batch", async () => {
  const tasks = [failed("local"), failed("other", "batch", { projectName: "其他项目" }), failed("safe", "own")];
  const { context } = harness(tasks);
  const result = plain(await context.archiveUselessBatches(["batch", "own"], "当前项目"));
  assert.deepEqual(result, { taskIds: ["safe"], batchCount: 1 });
  const stored = plain(await context.allTasks());
  assert.equal(stored.find((task) => task.id === "local").archivedAtMs, undefined);
  assert.equal(stored.find((task) => task.id === "other").archivedAtMs, undefined);
  assert.ok(stored.find((task) => task.id === "safe").archivedAtMs);
});

test("a successful or queued retry inserted after confirmation protects the stale cleanup selection", async () => {
  for (const status of ["completed", "queued"]) {
    const { context, insert, stats } = harness([failed("original")]);
    const selection = uselessTaskBatches(plain(await context.allTasks())).map((batch) => batch.id);
    assert.deepEqual(selection, ["batch"]);
    insert(failed("new-retry", "batch", { status }));
    assert.deepEqual(plain(await context.archiveUselessBatches(selection)), { taskIds: [], batchCount: 0 });
    assert.equal(stats.putCount, 0);
    assert.equal((await context.allTasks()).length, 2);
  }
});

test("both asynchronous and synchronous put failures roll back earlier archive writes", async () => {
  for (const synchronousPutFailure of [false, true]) {
    const tasks = [failed("first"), failed("second")];
    const { context, stats } = harness(tasks, { failPutAt: 2, synchronousPutFailure });
    await assert.rejects(context.archiveUselessBatches(["batch"]), /模拟数据库写入失败/);
    assert.equal(stats.commits, 0);
    assert.equal(stats.aborts, 1);
    assert.deepEqual(plain(await context.allTasks()), tasks);
  }
});

test("archived records are hidden from task pages and failed polling but remain in allTasks", async () => {
  const tasks = [failed("archive"), failed("single", ""), failed("success", "kept", { status: "completed" })];
  const { context } = harness(tasks);
  await context.archiveUselessBatches(["batch"]);
  const page = await context.listTasks({ pageSize: 100 });
  assert.equal(page.total, 2);
  assert.deepEqual(Array.from(page.items, (task) => task.id).sort(), ["single", "success"]);
  assert.deepEqual(Array.from(await context.getFailedTasks(10), (task) => task.id), ["single"]);
  assert.equal((await context.allTasks()).length, 3);
  assert.ok((await context.getTasksByIds(["archive"]))[0].archivedAtMs);
});

test("an in-flight polling write cannot revive an archived record or replace its cost metadata", async () => {
  const { context } = harness([failed("archive", "batch", { cost: 3, usage: { credits: 300 } })]);
  await context.archiveUselessBatches(["batch"]);
  await context.putPolledTaskUpdates([{ id: "archive", status: "completed", archivedAtMs: undefined, cost: 0 }]);
  const stored = (await context.allTasks())[0];
  assert.ok(stored.archivedAtMs);
  assert.equal(stored.status, "failed");
  assert.equal(stored.cost, 3);
  assert.deepEqual(plain(stored.usage), { credits: 300 });
  assert.equal((await context.listTasks()).total, 0);
});
