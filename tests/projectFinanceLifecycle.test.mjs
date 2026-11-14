import assert from "node:assert/strict";
import test from "node:test";

import { persistTaskProjectRename, taskProjectRenamePlan } from "../src/taskProjectRename.js";

const FINANCE_KEY = "video-workbench-project-finance-v1";

function storageFixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function plan() {
  return taskProjectRenamePlan({
    projects: ["原项目", "其他项目"],
    activeProject: "原项目",
    createdAtByName: { 原项目: 100 },
    ratios: { 原项目: "16:9" },
    fixedContent: { 原项目: "fixed-1" },
  }, "原项目", "新项目");
}

test("renaming a project migrates its finance ledger rows while preserving IDs and timestamps", async () => {
  const entries = [
    { id: "cost-1", projectName: "原项目", kind: "cost", incomeChannel: "", month: "2026-11", amountCents: 999, title: "GPT会员", note: "", createdAtMs: 123, updatedAtMs: 456 },
    { id: "income-1", projectName: "其他项目", kind: "income", incomeChannel: "douyin", month: "2026-11", amountCents: 5000, title: "结算", note: "", createdAtMs: 222, updatedAtMs: 333 },
  ];
  const storage = storageFixture({ [FINANCE_KEY]: JSON.stringify(entries) });
  let renamed;
  await persistTaskProjectRename(plan(), async (from, to) => { renamed = [from, to]; return 1; }, storage);
  assert.deepEqual(renamed, ["原项目", "新项目"]);
  assert.deepEqual(JSON.parse(storage.getItem(FINANCE_KEY)), [
    { ...entries[0], projectName: "新项目" },
    entries[1],
  ]);
});

test("does not create an empty finance ledger when the project has no ledger history", async () => {
  const storage = storageFixture();
  await persistTaskProjectRename(plan(), async () => 0, storage);
  assert.equal(storage.getItem(FINANCE_KEY), null);
});

test("rejects a target project that already has historical finance rows without calling record migration", async () => {
  const storage = storageFixture({ [FINANCE_KEY]: JSON.stringify([{ id: "old", projectName: "新项目", kind: "cost", month: "2026-11", title: "旧成本", amountCents: 100, createdAtMs: 100, updatedAtMs: 100 }]) });
  let called = false;
  await assert.rejects(
    persistTaskProjectRename(plan(), async () => { called = true; }, storage),
    /已经存在目标项目的历史记录.*不会合并账本/,
  );
  assert.equal(called, false);
  assert.deepEqual(JSON.parse(storage.getItem(FINANCE_KEY)), [{ id: "old", projectName: "新项目", kind: "cost", month: "2026-11", title: "旧成本", amountCents: 100, createdAtMs: 100, updatedAtMs: 100 }]);
});

test("rejects a corrupt finance ledger before changing project settings", async () => {
  const storage = storageFixture({ [FINANCE_KEY]: "{not-json" });
  const before = [...storage.values];
  await assert.rejects(persistTaskProjectRename(plan(), async () => 1, storage), /项目成本账本格式损坏/);
  assert.deepEqual([...storage.values], before);
});

test("rolls the finance ledger back when task record migration fails", async () => {
  const entries = [{ id: "cost-1", projectName: "原项目", kind: "cost", month: "2026-11", title: "旧成本", amountCents: 100, createdAtMs: 100, updatedAtMs: 100, note: "" }];
  const storage = storageFixture({ [FINANCE_KEY]: JSON.stringify(entries) });
  const before = [...storage.values];
  await assert.rejects(
    persistTaskProjectRename(plan(), async () => { throw new Error("数据库写入失败"); }, storage),
    /数据库写入失败/,
  );
  assert.deepEqual([...storage.values], before);
});
