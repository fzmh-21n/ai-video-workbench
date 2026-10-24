import assert from "node:assert/strict";
import test from "node:test";
import { submissionRecord } from "../src/submissionRecords.js";
import { modelSubmissionStats } from "../src/submissionAnalytics.js";
import { taskDatabase } from "./helpers/taskDatabase.mjs";

let moduleNumber = 0;
const task = (id, changes = {}) => ({
  id, upstreamTaskId: `upstream-${id}`, profileId: "provider", providerName: "中转A", model: "video-model",
  projectName: "原项目", status: "processing", createdAtMs: 100, prompt: "不得进入台账的长提示词",
  reuseSnapshot: { prompt: "不得进入台账的快照" }, downloadedAtMs: 500, ...changes,
});

async function harness(t, tasks = [], options = {}) {
  const fixture = taskDatabase(tasks, options);
  const previousDB = globalThis.indexedDB;
  const previousRange = globalThis.IDBKeyRange;
  globalThis.indexedDB = fixture.indexedDB;
  globalThis.IDBKeyRange = { only: (value) => value };
  t.after(() => {
    if (previousDB === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previousDB;
    if (previousRange === undefined) delete globalThis.IDBKeyRange; else globalThis.IDBKeyRange = previousRange;
  });
  const load = () => import(new URL(`../src/taskStore.js?submission-ledger=${++moduleNumber}`, import.meta.url));
  return { ...fixture, store: await load(), load };
}

test("submission receipts retain only accounting scalars and truncate errors to 500 characters", () => {
  const input = task("a", {
    batchId: "batch", batchTitle: "第1集", batchSection: 1, createdAt: "原创建时间", completedAt: "原完成时间",
    error: "错".repeat(600), retryOfTaskId: "original", retryAttempt: 2, cancelledByUser: true, cost: 3, archivedAtMs: 900, updatedAtMs: 199, submissionVerified: true,
    apiKey: "secret", headers: { authorization: "secret" }, url: "data:video/mp4;base64,large", media: new Uint8Array([1]),
    usage: { credits: 300 }, references: [{ file: new File(["large"], "large.png") }],
  });
  const record = submissionRecord(input);
  assert.deepEqual(Object.keys(record).sort(), [
    "id", "upstreamTaskId", "profileId", "providerName", "model", "projectName", "batchId", "batchTitle", "batchSection",
    "createdAtMs", "updatedAtMs", "createdAt", "completedAt", "status", "error", "retryOfTaskId", "retryAttempt", "cancelledByUser", "cost", "archivedAtMs", "submissionVerified",
  ].sort());
  assert.equal(record.error.length, 500);
  assert.equal(record.cost, 3);
  assert.ok(!JSON.stringify(record).includes("secret"));
  assert.equal(Object.hasOwn(submissionRecord({ id: "a", cost: { prompt: "nested data" } }), "cost"), false);
  assert.equal(input.error.length, 600);
});

test("version-1 upgrade backfills existing tasks without changing them and reads only the lightweight ledger", async (t) => {
  const originals = [task("a"), task("archived", { archivedAtMs: 200, status: "failed" })];
  const { store, stats } = await harness(t, originals, { version: 1 });
  assert.deepEqual(await store.getSubmissionRecords(), originals.map(submissionRecord));
  assert.equal(stats.transactions[0].mode, "versionchange");
  assert.deepEqual(stats.transactions.at(-1).names, ["submission_records"]);
  assert.equal(stats.transactions.at(-1).mode, "readonly");
  assert.deepEqual(await store.allTasks(), originals);
});

test("version changes close the connection and a later read reopens it", async (t) => {
  const { store, database, stats } = await harness(t);
  await store.openTaskDatabase();
  database.onversionchange();
  assert.equal(stats.closes, 1);
  await store.getSubmissionRecords();
  assert.equal(stats.opens, 2);
});

test("full writes, polling and retries mirror one receipt per accepted task and preserve download state", async (t) => {
  const original = task("a");
  const { store, load, stats } = await harness(t);
  await store.putTasks([original]);
  assert.deepEqual(stats.transactions[0].names, ["tasks", "submission_records"]);
  await store.putPolledTaskUpdates([{ id: "a", status: "completed", completedAt: "完成时间", downloadedAtMs: 0, cost: 2 }]);
  const persisted = (await store.getTasksByIds(["a"]))[0];
  assert.equal(persisted.downloadedAtMs, 500);
  assert.deepEqual(await store.getSubmissionRecords(), [submissionRecord(persisted)]);
  const retry = task("retry", { retryOfTaskId: "a", retryAttempt: 1, status: "failed", error: "重试失败" });
  await store.putTask(retry);
  const restarted = await load();
  const records = await restarted.getSubmissionRecords();
  assert.equal(records.length, 2, "polling does not invent submissions; a new accepted retry ID adds exactly one");
  const retryRecord = records.find((row) => row.id === "retry");
  assert.deepEqual(retryRecord, submissionRecord((await restarted.getTasksByIds(["retry"]))[0]));
  assert.ok(retryRecord.updatedAtMs > 0);
});

test("deleting tasks retains their latest receipts and missing IDs keep the old deletion semantics", async (t) => {
  const original = task("a", { status: "failed", error: "真实失败" });
  const { store, stats } = await harness(t, [original], { records: [] });
  await store.removeTasks(["a", "a", "missing"]);
  assert.deepEqual(stats.transactions[0].names, ["tasks", "submission_records"]);
  assert.deepEqual(await store.allTasks(), []);
  assert.deepEqual(await store.getSubmissionRecords(), [submissionRecord(original)]);
  await store.removeTask("a");
  assert.deepEqual(await store.getSubmissionRecords(), [submissionRecord(original)]);
});

test("project renaming updates active and ledger-only receipts in the same atomic transaction", async (t) => {
  const original = task("a");
  const deleted = submissionRecord(task("already-deleted", { status: "completed" }));
  const { store, stats } = await harness(t, [original], { records: [submissionRecord(original), deleted] });
  assert.equal(await store.renameTaskProjectRecords("原项目", "新项目"), 1);
  assert.deepEqual(stats.transactions[0].names, ["tasks", "submission_records"]);
  assert.equal((await store.allTasks())[0].projectName, "新项目");
  assert.deepEqual((await store.getSubmissionRecords()).map((row) => row.projectName), ["新项目", "新项目"]);
});

test("archived and cancelled polling guards are also reflected in the ledger", async (t) => {
  const originals = [task("archived", { archivedAtMs: 200, status: "failed", cost: 3 }),
    task("cancelled", { cancelledByUser: true, status: "failed", cost: 4 })];
  const { store } = await harness(t, originals);
  await store.putPolledTaskUpdates(originals.map((row) => ({ id: row.id, status: "completed", archivedAtMs: undefined, cancelledByUser: false, cost: 0 })));
  assert.deepEqual(await store.getSubmissionRecords(), (await store.allTasks()).map(submissionRecord));
  assert.ok((await store.allTasks()).every((row) => row.status === "failed" && row.downloadedAtMs === 500));
});

test("archiving failed tasks mirrors the final lightweight receipt without retaining prompt content", async (t) => {
  const original = task("a", { status: "failed", batchId: "failed-batch", cost: 3 });
  const { store } = await harness(t, [original]);
  await store.archiveUselessBatches(["failed-batch"], "原项目");
  const [archived] = await store.allTasks();
  const [record] = await store.getSubmissionRecords();
  assert.ok(record.archivedAtMs > 0);
  assert.deepEqual(record, submissionRecord(archived));
  assert.equal(record.cost, 3);
  assert.ok(!JSON.stringify(record).includes(original.prompt));
});

test("either task or receipt write failure rolls back both stores", async (t) => {
  for (const failingStore of ["tasks", "submission_records"]) {
    for (const operation of ["put", "poll", "delete", "rename"]) {
      for (const synchronous of [false, true]) await t.test(`${operation}: ${failingStore} (${synchronous ? "sync" : "async"})`, async (t) => {
        const original = task("a");
        const type = operation === "rename" ? "update" : operation === "delete" && failingStore === "tasks" ? "delete" : "put";
        const { store } = await harness(t, [original], { failOperation: { store: failingStore, type, synchronous }, errorMessage: "原子写入失败" });
        const action = {
          put: () => store.putTasks([task("a", { status: "completed" }), task("b")]),
          poll: () => store.putPolledTaskUpdates([{ id: "a", status: "completed" }]),
          delete: () => store.removeTasks(["a"]),
          rename: () => store.renameTaskProjectRecords("原项目", "新项目"),
        }[operation];
        await assert.rejects(action(), /原子写入失败/);
        assert.deepEqual(await store.allTasks(), [original]);
        assert.deepEqual(await store.getSubmissionRecords(), [submissionRecord(original)]);
      });
    }
  }
});

test("a failed upgrade does not delete tasks or commit a partial receipt store", async (t) => {
  const originals = [task("a"), task("b")];
  const { store, database, stats } = await harness(t, originals, {
    version: 1, failOperation: { store: "submission_records", type: "put", at: 2 }, errorMessage: "回填失败",
  });
  await assert.rejects(store.openTaskDatabase(), /回填失败/);
  assert.equal(database.objectStoreNames.contains("submission_records"), false);
  assert.equal(stats.commits, 0);
  assert.equal(stats.aborts, 1);
});

test("a transient upgrade failure can reopen the database after the underlying error is resolved", async (t) => {
  const original = task("a");
  const options = { version: 1, failOperation: { store: "submission_records", type: "put" }, errorMessage: "暂时写入失败" };
  const { store, stats } = await harness(t, [original], options);
  await assert.rejects(store.openTaskDatabase(), /暂时写入失败/);
  options.failOperation = null;
  assert.deepEqual(await store.getSubmissionRecords(), [submissionRecord(original)]);
  assert.equal(stats.opens, 2);
});

test("recovered or restored tasks cannot shift an existing receipt's first date or downgrade its verified acceptance", async (t) => {
  const original = task("a", { createdAtMs: 100, createdAt: new Date(100).toISOString(), submissionVerified: true, status: "completed" });
  const { store } = await harness(t, [original]);
  await store.removeTask("a");
  const recovered = task("a", { createdAtMs: 900, createdAt: new Date(900).toISOString(), submissionVerified: false });
  await store.putTask(recovered);
  let [record] = await store.getSubmissionRecords();
  assert.equal(record.createdAtMs, 100);
  assert.equal(record.createdAt, original.createdAt);
  assert.equal(record.submissionVerified, true);
  assert.equal(record.status, "processing", "only creation and verification are conservative; the incoming status still wins");
  assert.equal((await store.allTasks())[0].createdAtMs, 900, "full task replacement semantics remain unchanged");
  assert.equal((await store.allTasks())[0].submissionVerified, false);
  await store.putPolledTaskUpdates([{ id: "a", status: "failed", error: "新状态" }]);
  await store.removeTask("a");
  [record] = await store.getSubmissionRecords();
  assert.equal(record.createdAtMs, 100);
  assert.equal(record.createdAt, original.createdAt);
  assert.equal(record.submissionVerified, true);
  assert.equal(record.status, "failed");
});

test("receipt-only backup import preserves the earliest parseable legacy date and known verification state", async (t) => {
  const original = submissionRecord(task("a", { createdAtMs: undefined, createdAt: new Date(100).toISOString(), submissionVerified: false }));
  const { store } = await harness(t, [], { records: [original] });
  await store.putTaskBackup([], [task("a", { createdAtMs: 900, createdAt: new Date(900).toISOString() })]);
  let [record] = await store.getSubmissionRecords();
  assert.equal(record.createdAtMs, 100);
  assert.equal(record.createdAt, original.createdAt);
  assert.equal(record.submissionVerified, false, "an old backup without a flag does not verify a known unconfirmed task");
  await store.putTaskBackup([], [{ id: "a", createdAtMs: 50, createdAt: new Date(50).toISOString(), submissionVerified: true }]);
  await store.putTaskBackup([], [{ id: "a", createdAtMs: 0, createdAt: "", submissionVerified: false }]);
  [record] = await store.getSubmissionRecords();
  assert.equal(record.createdAtMs, 50);
  assert.equal(record.createdAt, new Date(50).toISOString());
  assert.equal(record.submissionVerified, true);
  assert.deepEqual(await store.allTasks(), []);
});

test("manual recovery cannot reduce historically accepted receipts while new unverified IDs stay excluded", async (t) => {
  const { store } = await harness(t, [task("legacy")]);
  const accepted = async () => modelSubmissionStats(await store.getSubmissionRecords()).reduce((total, group) => total + group.accepted, 0);
  assert.equal(await accepted(), 1);
  await store.removeTask("legacy");
  await store.putTask(task("legacy", { submissionVerified: false }));
  assert.equal(await accepted(), 1, "a same-ID unverified recovery cannot revoke the existing historical receipt");
  const legacy = (await store.getSubmissionRecords()).find((row) => row.id === "legacy");
  assert.equal(Object.hasOwn(legacy, "submissionVerified"), false, "keep the historical compatibility state rather than invent explicit verification");
  await store.putTask(task("new", { submissionVerified: false }));
  await store.putTaskBackup([], [task("new")]);
  assert.equal(await accepted(), 1, "undefined does not verify an existing known-unconfirmed receipt");
  assert.equal((await store.getSubmissionRecords()).find((row) => row.id === "new").submissionVerified, false);
  await store.putTask(task("new", { submissionVerified: true }));
  await store.putTask(task("new", { submissionVerified: false }));
  assert.equal(await accepted(), 2, "only actual verification upgrades the new ID, and it then cannot downgrade");
});

test("a delete/export/import roundtrip restores ledger-only history without reviving deleted tasks", async (t) => {
  const originals = [task("deleted", { submissionVerified: true }), task("live")];
  const { store, load } = await harness(t, originals);
  await store.removeTask("deleted");
  const backup = JSON.parse(JSON.stringify({ tasks: await store.allTasks(), submissionRecords: await store.getSubmissionRecords() }));
  const target = taskDatabase();
  globalThis.indexedDB = target.indexedDB;
  const restored = await load();
  await restored.putTaskBackup(backup.tasks, backup.submissionRecords);
  await restored.putTaskBackup(backup.tasks, backup.submissionRecords);
  assert.deepEqual((await restored.allTasks()).map((row) => row.id), ["live"]);
  assert.deepEqual((await restored.getSubmissionRecords()).map((row) => row.id).sort(), ["deleted", "live"]);
  assert.equal((await restored.getSubmissionRecords()).find((row) => row.id === "deleted").submissionVerified, true);
});

test("backup import accepts old task-only backups, sanitizes receipts, merges duplicate IDs and retains unrelated history", async (t) => {
  const { store } = await harness(t, [], { records: [submissionRecord(task("unrelated"))] });
  await store.putTaskBackup([task("legacy")]);
  const current = task("a", { createdAtMs: 900, createdAt: new Date(900).toISOString(), status: "completed" });
  await store.putTaskBackup([current], [
    task("a", { createdAtMs: 100, createdAt: new Date(100).toISOString(), submissionVerified: true }),
    task("a", { createdAtMs: 400, createdAt: new Date(400).toISOString(), submissionVerified: false }),
    task("receipt-only", { prompt: "SECRET-PROMPT", apiKey: "SECRET-KEY", media: "data:large", error: "错".repeat(600) }),
  ]);
  const rows = await store.getSubmissionRecords();
  assert.deepEqual(rows.map((row) => row.id).sort(), ["a", "legacy", "receipt-only", "unrelated"]);
  const merged = rows.find((row) => row.id === "a");
  assert.equal(merged.createdAtMs, 100);
  assert.equal(merged.createdAt, new Date(100).toISOString());
  assert.equal(merged.submissionVerified, true);
  assert.equal(merged.status, "completed", "the current full task supplies its current status");
  assert.equal((await store.getTasksByIds(["a"]))[0].createdAtMs, 900);
  assert.equal(rows.find((row) => row.id === "receipt-only").error.length, 500);
  assert.ok(!JSON.stringify(rows).includes("SECRET"));
  assert.deepEqual((await store.allTasks()).map((row) => row.id).sort(), ["a", "legacy"]);
});

test("backup imports roll back both normal tasks and ledger-only history on either store's write failure", async (t) => {
  for (const failingStore of ["tasks", "submission_records"]) {
    for (const synchronous of [false, true]) await t.test(`${failingStore} ${synchronous ? "sync" : "async"}`, async (t) => {
      const original = task("a");
      const { store } = await harness(t, [original], {
        failOperation: { store: failingStore, type: "put", at: 2, synchronous }, errorMessage: "备份导入失败",
      });
      await assert.rejects(store.putTaskBackup([task("a", { status: "completed" }), task("b")], [task("receipt-only")]), /备份导入失败/);
      assert.deepEqual(await store.allTasks(), [original]);
      assert.deepEqual(await store.getSubmissionRecords(), [submissionRecord(original)]);
    });
  }
});
