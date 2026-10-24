import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const handlers = source.slice(source.indexOf("  async function exportTaskBackup()"),
  source.indexOf("  return (\n    <main", source.indexOf("  async function exportTaskBackup()")));

function contextFor(overrides = {}) {
  const result = { writes: [] };
  const context = vm.createContext({
    Blob, Date, JSON, Array,
    allTasks: async () => [{ id: "visible" }],
    getSubmissionRecords: async () => [{ id: "visible" }, { id: "deleted-ledger-only" }],
    putTaskBackup: async (...values) => result.writes.push(JSON.parse(JSON.stringify(values))),
    setTaskRefreshVersion: () => {},
    setNotice: (value) => { result.notice = value; },
    URL: { createObjectURL: (blob) => { result.blob = blob; return "blob:test"; }, revokeObjectURL: () => {} },
    document: { createElement: () => ({ click() {} }) },
    window: { setTimeout: (callback) => callback() },
    ...overrides,
  });
  vm.runInContext(handlers, context);
  return { context, result };
}

test("the actual backup export includes lightweight receipts for deleted tasks", async () => {
  const { context, result } = contextFor();
  await context.exportTaskBackup();
  const backup = JSON.parse(await result.blob.text());
  assert.equal(backup.version, 2);
  assert.deepEqual(backup.tasks, [{ id: "visible" }]);
  assert.deepEqual(backup.submissionRecords, [{ id: "visible" }, { id: "deleted-ledger-only" }]);
  assert.match(result.notice, /2 条轻量提交台账/);
});

test("the actual import keeps ledger-only records separate and accepts old task-only backups", async () => {
  for (const backup of [
    { version: 2, tasks: [{ id: "visible" }], submissionRecords: [{ id: "deleted-ledger-only" }] },
    { version: 1, tasks: [{ id: "visible" }] },
    [{ id: "visible" }],
  ]) {
    const { context, result } = contextFor();
    await context.importTaskBackup({ text: async () => JSON.stringify(backup) });
    assert.deepEqual(result.writes, [[[{ id: "visible" }], backup.submissionRecords || []]]);
    assert.match(result.notice, /已导入/);
  }
});

test("invalid receipt backups are rejected before either task or ledger writes", async () => {
  for (const submissionRecords of [{ id: "not-an-array" }, [{}]]) {
    const { context, result } = contextFor();
    await context.importTaskBackup({ text: async () => JSON.stringify({ tasks: [], submissionRecords }) });
    assert.equal(result.writes.length, 0);
    assert.match(result.notice, /提交台账备份格式无效/);
  }
});
