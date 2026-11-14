import assert from "node:assert/strict";
import test from "node:test";

import {
  HONGGUO_PLAYS_KEY,
  PROJECT_FINANCE_LUMP_KEY,
  cumulativeFinanceSummary,
  financeEntry,
  financeLumpEntry,
  latestHongguoPlay,
  loadFinanceLumpSums,
  loadHongguoPlays,
  lumpSumTotals,
  parsePlayCountInput,
  removeHongguoPlay,
  saveFinanceLumpSums,
  saveHongguoPlays,
  upsertHongguoPlay,
  withFinanceLumpSum,
} from "../src/projectFinance.js";
import { buildRevenueChart, chartMonths } from "../src/financeChart.js";
import { modelPriceKey } from "../src/costAnalytics.js";
import { persistTaskProjectRename, taskProjectRenamePlan } from "../src/taskProjectRename.js";

const storage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
};
const at = (value) => new Date(value).getTime();
const encoded = (id) => Buffer.from(JSON.stringify({ taskId: id, adapter: "seedancevideo", baseUrl: "https://relay", model: "m1" })).toString("base64url") + ".sig";
const settings = { [modelPriceKey("p1", "m1")]: { unitPrice: "2" } };
const tasks = [
  { id: encoded("a"), profileId: "p1", model: "m1", projectName: "项目A", status: "completed", createdAtMs: at("2026-10-02T10:00:00"), completedAt: "2026-10-02T12:00:00", updatedAtMs: 1 },
  { id: encoded("b"), profileId: "p1", model: "m1", status: "completed", createdAtMs: at("2026-11-02T10:00:00"), completedAt: "2026-11-02T12:00:00", updatedAtMs: 1 },
  { id: encoded("old"), profileId: "p1", model: "m1", projectName: "项目A", status: "completed", createdAtMs: at("2025-01-02T10:00:00"), completedAt: "2025-01-02T12:00:00", updatedAtMs: 1 },
];
const entries = [
  financeEntry({ projectName: "项目A", kind: "income", incomeChannel: "douyin", month: "2026-10", title: "10月", amount: "100" }, null, at("2026-10-30")),
  financeEntry({ projectName: "项目A", kind: "cost", month: "2026-11", title: "会员", amount: "30" }, null, at("2026-11-01")),
  financeEntry({ projectName: "未归类", kind: "income", incomeChannel: "baijiahao", month: "2026-11", title: "11月", amount: "50" }, null, at("2026-11-01")),
];

test("uncategorized lump sum is stored separately, validated and can be cleared", () => {
  const db = storage();
  assert.deepEqual(loadFinanceLumpSums(db), {});
  const lump = financeLumpEntry({ income: "18600", cost: "12350.5", note: "早期项目" }, 123);
  assert.deepEqual(lump, { incomeCents: 1860000, costCents: 1235050, note: "早期项目", updatedAtMs: 123 });
  saveFinanceLumpSums(withFinanceLumpSum({}, "未归类", lump), db);
  assert.deepEqual(loadFinanceLumpSums(db), { 未归类: lump });
  assert.equal(financeLumpEntry({ income: "", cost: "0" }), null);
  assert.deepEqual(withFinanceLumpSum({ 未归类: lump }, "未归类", null), {});
  assert.throws(() => financeLumpEntry({ income: "-1" }), /金额/);
  assert.throws(() => financeLumpEntry({ cost: "1.234" }), /金额/);
  db.values.set(PROJECT_FINANCE_LUMP_KEY, "oops");
  assert.throws(() => loadFinanceLumpSums(db), /损坏/);
});

test("lump sum counts for 全部项目 and 未归类 totals but not for other projects or months", () => {
  const lumps = { 未归类: { incomeCents: 100000, costCents: 40000, note: "", updatedAtMs: 1 } };
  assert.deepEqual(lumpSumTotals(lumps, "all"), { incomeCents: 100000, costCents: 40000, netCents: 60000, hasValue: true });
  assert.equal(lumpSumTotals(lumps, "项目A").hasValue, false);
  const all = cumulativeFinanceSummary(tasks, settings, entries, lumps, "all");
  // 账本：收入 100 + 50，成本 30 + API 3 条 × 2 元；再加历史汇总 1000 / 400
  assert.equal(all.incomeCents, 15000 + 100000);
  assert.equal(all.costCents, 3000 + 600 + 40000);
  assert.equal(all.netCents, all.incomeCents - all.costCents);
  const uncategorized = cumulativeFinanceSummary(tasks, settings, entries, lumps, "未归类");
  assert.equal(uncategorized.incomeCents, 5000 + 100000);
  assert.equal(uncategorized.costCents, 200 + 40000);
  assert.equal(cumulativeFinanceSummary(tasks, settings, entries, lumps, "项目A").incomeCents, 10000);
});

test("revenue chart aggregates monthly income, cost and net; cumulative view starts from the lump sum and earlier months", () => {
  assert.deepEqual(chartMonths("2026-02", 3), ["2025-12", "2026-01", "2026-02"]);
  assert.throws(() => chartMonths("2026-13"), /YYYY-MM/);
  const lumps = { 未归类: { incomeCents: 100000, costCents: 40000, note: "", updatedAtMs: 1 } };
  const chart = buildRevenueChart({ tasks, settings, entries, lumps, projectName: "all", endMonth: "2026-11", count: 3 });
  assert.deepEqual(chart.months.map((month) => month.key), ["2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(chart.months.map((month) => [month.incomeCents, month.costCents, month.netCents]), [[0, 0, 0], [10000, 200, 9800], [5000, 3200, 1800]]);
  assert.equal(chart.months[1].label, "10月");
  // 窗口之前：2025-01 的 API 成本 200 + 历史汇总
  assert.deepEqual(chart.baseline, { incomeCents: 100000, costCents: 40200, netCents: 59800 });
  assert.deepEqual(chart.cumulative.map((month) => month.netCents), [59800, 69600, 71400]);
  assert.equal(chart.cumulative.at(-1).netCents, chart.totals.netCents);
  assert.deepEqual(chart.lump, { incomeCents: 100000, costCents: 40000, netCents: 60000, hasValue: true });
  const projectA = buildRevenueChart({ tasks, settings, entries, lumps, projectName: "项目A", endMonth: "2026-11", count: 3 });
  assert.equal(projectA.lump, null);
  assert.deepEqual(projectA.months.map((month) => month.netCents), [0, 9800, -3000]);
});

test("manual Hongguo play counts are stored per project and month, overwritten within a month and parsed with 万/亿", () => {
  const db = storage();
  assert.equal(parsePlayCountInput("356.8万"), 3568000);
  assert.equal(parsePlayCountInput("1,234,567"), 1234567);
  assert.equal(parsePlayCountInput("1.2亿"), 120000000);
  assert.throws(() => parsePlayCountInput("很多"), /播放量/);
  let rows = upsertHongguoPlay([], { projectName: "剧A", month: "2026-10", playCount: 100 }, 1);
  rows = upsertHongguoPlay(rows, { projectName: "剧A", month: "2026-11", playCount: 200 }, 2);
  rows = upsertHongguoPlay(rows, { projectName: "剧A", month: "2026-11", playCount: 250 }, 3);
  assert.equal(rows.length, 2);
  saveHongguoPlays(rows, db);
  assert.deepEqual(loadHongguoPlays(db), rows);
  const { latest, previous } = latestHongguoPlay(rows, "剧A");
  assert.equal(latest.playCount, 250);
  assert.equal(previous.playCount, 100);
  assert.deepEqual(removeHongguoPlay(rows, "剧A", "2026-11").map((row) => row.month), ["2026-10"]);
  assert.throws(() => upsertHongguoPlay([], { projectName: "剧A", month: "2026-1", playCount: 1 }), /YYYY-MM/);
  db.values.set(HONGGUO_PLAYS_KEY, "{");
  assert.throws(() => loadHongguoPlays(db), /损坏/);
});

test("renaming a project also moves its Hongguo play counts", async () => {
  const rows = [{ projectName: "原项目", month: "2026-11", playCount: 10, updatedAtMs: 1 }, { projectName: "其他", month: "2026-11", playCount: 5, updatedAtMs: 1 }];
  const db = storage({ [HONGGUO_PLAYS_KEY]: JSON.stringify(rows) });
  const plan = taskProjectRenamePlan({ projects: ["原项目", "其他"], activeProject: "原项目", createdAtByName: {}, ratios: {}, fixedContent: {} }, "原项目", "上架剧名");
  await persistTaskProjectRename(plan, async () => 1, db);
  assert.deepEqual(JSON.parse(db.getItem(HONGGUO_PLAYS_KEY)).map((row) => row.projectName), ["上架剧名", "其他"]);
});
