import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECT_FINANCE_KEY,
  financeEntry,
  financeMonthKey,
  financeMonths,
  loadProjectFinance,
  projectFinanceSummary,
  removeFinanceEntry,
  saveProjectFinance,
  upsertFinanceEntry,
} from "../src/projectFinance.js";
import { modelPriceKey } from "../src/costAnalytics.js";

const storage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
};
const at = (value) => new Date(value).getTime();

test("creates and edits precise two-decimal finance entries while preserving identity", () => {
  const created = financeEntry({ projectName: "项目A", kind: "cost", month: "2026-11", title: "GPT会员", amount: "20.05", note: "按项目分摊" }, null, at("2026-11-01T10:00:00"));
  assert.equal(created.amountCents, 2005);
  const edited = financeEntry({ amount: "3", title: "会员分摊" }, created, at("2026-11-02T10:00:00"));
  assert.equal(edited.id, created.id);
  assert.equal(edited.createdAtMs, created.createdAtMs);
  assert.equal(edited.amountCents, 300);
  assert.equal(edited.updatedAtMs, at("2026-11-02T10:00:00"));
  assert.equal(financeEntry({ title: "只改名称" }, edited, at("2026-11-03T10:00:00")).amountCents, 300);
  for (const amount of ["0", "1.234", "-1", "abc", ""]) assert.throws(() => financeEntry({ projectName: "A", kind: "cost", month: "2026-11", title: "x", amount }), /金额/);
});

test("loads, saves, upserts and removes a project ledger without silently accepting corruption", () => {
  const db = storage();
  const row = financeEntry({ projectName: "项目A", kind: "income", incomeChannel: "douyin", month: "2026-11", title: "平台结算", amount: "100" }, null, at("2026-11-01"));
  saveProjectFinance([row], db);
  assert.deepEqual(loadProjectFinance(db), [row]);
  const updated = { ...row, title: "月结", updatedAtMs: at("2026-11-02") };
  assert.equal(upsertFinanceEntry([row], updated)[0].title, "月结");
  assert.deepEqual(removeFinanceEntry([row], row.id), []);
  db.values.set(PROJECT_FINANCE_KEY, "not-json");
  assert.throws(() => loadProjectFinance(db), /损坏/);
  db.values.set(PROJECT_FINANCE_KEY, JSON.stringify([{ ...row, id: row.id }, { ...row, id: row.id }]));
  assert.throws(() => loadProjectFinance(db), /重复 ID/);
});

test("summarizes manual income, manual cost and deduplicated API cost by project and month", () => {
  const settings = { [modelPriceKey("p1", "m1")]: { unitPrice: "1.25" }, [modelPriceKey("p1", "free")]: { unitPrice: "0" } };
  const encoded = (id, model = "m1") => Buffer.from(JSON.stringify({ taskId: id, adapter: "seedancevideo", baseUrl: "https://relay", model })).toString("base64url") + ".sig";
  const tasks = [
    { id: encoded("one"), profileId: "p1", model: "m1", projectName: "项目A", status: "completed", createdAtMs: at("2026-11-02"), completedAt: "2026-11-03T10:00:00Z", updatedAtMs: 2 },
    { id: encoded("one"), profileId: "p1", model: "m1", projectName: "项目A", status: "processing", createdAtMs: at("2026-11-02"), updatedAtMs: 1 },
    { id: encoded("two"), profileId: "p1", model: "m1", projectName: "项目A", status: "completed", createdAtMs: at("2026-10-02"), completedAt: "2026-10-03T10:00:00Z", updatedAtMs: 3 },
    { id: encoded("free", "free"), profileId: "p1", model: "free", projectName: "项目A", status: "completed", createdAtMs: at("2026-11-04"), updatedAtMs: 1 },
    { id: encoded("fail"), profileId: "p1", model: "m1", projectName: "项目A", status: "failed", createdAtMs: at("2026-11-04"), updatedAtMs: 1 },
  ];
  const entries = [
    financeEntry({ projectName: "项目A", kind: "income", incomeChannel: "douyin", month: "2026-11", title: "平台结算", amount: "10" }, null, at("2026-11-05")),
    financeEntry({ projectName: "项目A", kind: "cost", month: "2026-11", title: "GPT会员分摊", amount: "2.50" }, null, at("2026-11-05")),
  ];
  assert.deepEqual(projectFinanceSummary(tasks, settings, entries, { projectName: "项目A", month: "2026-11" }), {
    incomeCents: 1000, douyinIncomeCents: 1000, baijiahaoIncomeCents: 0, manualCostCents: 250, apiCostCents: 125, totalCostCents: 375, netCents: 625, unpricedTasks: 0, undatedTasks: 0,
  });
  assert.equal(projectFinanceSummary(tasks, settings, entries, { projectName: "项目A", month: "2026-10" }).apiCostCents, 125);
  assert.deepEqual(financeMonths(tasks, entries, "项目A"), ["2026-11", "2026-10"]);
});

test("keeps undated completed tasks visible in cumulative totals and reports missing dates and prices", () => {
  const task = { id: "raw", profileId: "p1", model: "m2", projectName: "项目A", status: "completed" };
  const summary = projectFinanceSummary([task], {}, [], { projectName: "项目A" });
  assert.deepEqual(summary, { incomeCents: 0, douyinIncomeCents: 0, baijiahaoIncomeCents: 0, manualCostCents: 0, apiCostCents: 0, totalCostCents: 0, netCents: 0, unpricedTasks: 1, undatedTasks: 1 });
  assert.equal(financeMonthKey(new Date(2026, 10, 14)), "2026-11");
});
