import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { COST_SETTINGS_KEY, costSeries, loadCostSettings, migrateCostSettings, modelPriceKey, modelResolutionPrices,
  projectSuccessfulModels, resolvedTaskPrice, saveCostSettings, taskEstimatedCost, withCostUnitPrice } from "../src/costAnalytics.js";
import { modelSubmissionStats, submissionRecordsCsv } from "../src/submissionAnalytics.js";
import { mergeSubmissionRecord, submissionRecord } from "../src/submissionRecords.js";
import { projectFinanceSummary } from "../src/projectFinance.js";
import { buildRevenueChart } from "../src/financeChart.js";
import { recordedTaskResolution } from "../src/taskResolution.js";
import { regeneratedTaskRecord } from "../src/taskRegeneration.js";
import { taskDatabase } from "./helpers/taskDatabase.mjs";

const model = "lg-sd2.5-v2", profileId = "lwaigc";
const key = modelPriceKey(profileId, model);
const settings = { [key]: { unitPrice: "4.5", favorite: true }, [modelPriceKey("other", "ordinary")]: { unitPrice: "2" } };
const at = (month, day) => new Date(2026, month - 1, day, 12).getTime();
function task(id, resolution, changes = {}) {
  return { id, upstreamTaskId: id, profileId, providerName: "LWAIGC", model, projectName: "项目A", status: "completed", createdAtMs: at(11, 3),
    ...(resolution !== undefined ? { reuseSnapshot: { resolution } } : {}), ...changes };
}
const tasks = [task("480", "480P"), task("720", "720p"), task("unknown", undefined),
  task("old", "480", { createdAtMs: at(10, 3) }),
  task("other", "480p", { profileId: "other", model: "ordinary" })];

test("the same LG model uses recorded resolution prices, not its generic 4.5 price", () => {
  assert.equal(taskEstimatedCost(tasks[0], settings), 3.5);
  assert.equal(taskEstimatedCost(tasks[1], settings), 4.5);
  assert.equal(taskEstimatedCost(tasks[2], settings), 4.5);
  assert.equal(taskEstimatedCost(tasks[4], settings), 2);
  assert.equal(taskEstimatedCost({ ...tasks[0], status: "failed" }, settings), 0);
  assert.equal(taskEstimatedCost({ ...tasks[0], status: "processing" }, settings), 0);
  assert.equal(resolvedTaskPrice(tasks[2], settings).resolution, "");
  assert.equal(resolvedTaskPrice(tasks[2], settings).source, "model");
  for (const resolution of ["1080p", "4K"]) {
    assert.equal(taskEstimatedCost(task("unpriced-tier", resolution), settings), 4.5, "undocumented price falls back, not invented");
    assert.equal(resolvedTaskPrice(task("unpriced-tier", resolution), {}).priced, false);
  }
});

test("case/numeric aliases are normalized and immutable submission evidence wins", () => {
  for (const alias of ["480", 480, " 480P "]) assert.equal(recordedTaskResolution(task("alias", alias)), "480p");
  assert.equal(recordedTaskResolution(task("alias", " 4K ")), "4k");
  assert.equal(recordedTaskResolution({ submittedResolution: "480p", resolution: "720p", reuseSnapshot: { resolution: "1080p" } }), "480p");
  assert.equal(recordedTaskResolution({ reuseSnapshot: { resolution: "480p" }, resolution: "720p" }), "480p");
  assert.equal(recordedTaskResolution({ model, profile: { resolution: "720p" } }), "");
});

test("legacy settings migration is additive/idempotent, supports overrides, blank fallback and zero prices", () => {
  const map = new Map([[COST_SETTINGS_KEY, JSON.stringify(settings)]]);
  const storage = { getItem: (k) => map.get(k), setItem: (k,v) => map.set(k,v) };
  const loaded = loadCostSettings(storage);
  assert.equal(loaded[key].unitPrice, "4.5");
  assert.equal(loaded[key].favorite, true);
  assert.deepEqual(loaded[key].resolutionPrices, { "480p": "3.5", "720p": "4.5" });
  assert.deepEqual(loaded[modelPriceKey("other", "ordinary")], settings[modelPriceKey("other", "ordinary")]);
  assert.deepEqual(migrateCostSettings(loaded), loaded);
  let next = withCostUnitPrice(loaded, profileId, model, "3.8", "480P");
  next = withCostUnitPrice(next, profileId, model, "0", "720p");
  next = withCostUnitPrice(next, profileId, model, "", "1080p");
  saveCostSettings(next, storage);
  next = loadCostSettings(storage);
  assert.equal(taskEstimatedCost(task("a", "480p"), next), 3.8);
  assert.equal(resolvedTaskPrice(task("b", "720p"), next).priced, true);
  assert.equal(taskEstimatedCost(task("b", "720p"), next), 0);
  next = withCostUnitPrice(next, profileId, model, "", "480p");
  assert.equal(taskEstimatedCost(task("a", "480p"), next), 4.5);
  saveCostSettings(next, storage);
  assert.equal(taskEstimatedCost(task("a", "480p"), loadCostSettings(storage)), 4.5, "blank override must not reseed default");
  const alias = { ...settings, [key]: { unitPrice: "9", resolutionPrices: { "480P": "6", "720": "7", "4K": "8" } } };
  assert.deepEqual(modelResolutionPrices(model, alias[key]), { "480p": "6", "720p": "7", "4k": "8" });
  assert.equal(taskEstimatedCost(task("4k", "4K"), alias), 8);
  assert.equal(resolvedTaskPrice(task("new", "480p"), {}).priced, true);
});

test("receipts keep scalar resolution without retaining prompts/files; polling cannot erase or relabel it", () => {
  const receipt = submissionRecord({ ...tasks[0], prompt: "secret prompt", reuseSnapshot: { resolution: "480p", references: [{ secret: "file" }] } });
  assert.equal(receipt.resolution, "480p");
  assert.equal("reuseSnapshot" in receipt, false);
  assert.equal("prompt" in receipt, false);
  assert.equal(mergeSubmissionRecord(receipt, { ...receipt, resolution: undefined, status: "completed" }).resolution, "480p");
  assert.equal(mergeSubmissionRecord(receipt, { ...receipt, resolution: "720p" }).resolution, "480p");
  const duplicate = { ...receipt, resolution: undefined, updatedAtMs: 9999 };
  const records = modelSubmissionStats([receipt, duplicate]).flatMap((g) => g.records);
  assert.equal(records.length, 1);
  assert.equal(records[0].resolution, "480p");
  assert.equal(modelSubmissionStats([duplicate, receipt])[0].records[0].resolution, "480p");
  assert.ok(submissionRecordsCsv(records).includes('"提交分辨率"'));
});

test("monthly/all-time project finance, chart and daily/monthly trends agree on mixed resolutions", () => {
  const entries = [{ id: "income", kind: "income", projectName: "项目A", month: "2026-11", title: "收入", incomeChannel: "douyin", amountCents: 10000, createdAtMs: at(11,3), updatedAtMs: at(11,3) },
    { id: "cost", kind: "cost", projectName: "项目A", month: "2026-11", title: "成本", amountCents: 1000, createdAtMs: at(11,3), updatedAtMs: at(11,3) }];
  const receipts = tasks.map(submissionRecord);
  const monthly = projectFinanceSummary(receipts, settings, entries, { projectName: "项目A", month: "2026-11" });
  assert.equal(monthly.apiCostCents, 1450);
  assert.equal(monthly.totalCostCents, 2450);
  assert.equal(monthly.netCents, 7550);
  assert.equal(projectFinanceSummary(receipts, settings, entries).apiCostCents, 1800);
  assert.equal(projectFinanceSummary(receipts, settings, entries, { projectName: "别的项目" }).apiCostCents, 0);
  const normalized = modelSubmissionStats(receipts).flatMap((g) => g.records);
  assert.deepEqual(costSeries(normalized, settings, "month", 2, at(11,19)).map((b) => b.cost), [3.5, 14.5]);
  assert.equal(costSeries(normalized, settings, "day", 1, at(11,3))[0].cost, 14.5);
  const chart = buildRevenueChart({ tasks: receipts, settings, entries, endMonth: "2026-11", count: 2 });
  assert.deepEqual(chart.months.map((b) => b.costCents), [350, 2450]);
  assert.equal(chart.totals.costCents, 2800);
  const groups = projectSuccessfulModels(normalized, settings, "项目A");
  assert.equal(groups.reduce((s,g) => s + g.subtotal, 0), 18);
  assert.equal(groups.find((g) => g.resolution === "480p").subtotal, 7);
  assert.equal(groups.find((g) => g.resolution === "720p").subtotal, 4.5);
  assert.equal(groups.find((g) => g.model === model && !g.resolution).subtotal, 4.5);
  const free = withCostUnitPrice(settings, profileId, model, "0", "480p");
  assert.equal(projectFinanceSummary([receipts[0]], free, []).unpricedTasks, 0);
});

test("new single/batch/retry tasks pin resolution at submission instead of reading a later selection", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const batch = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
  assert.match(app, /submittedResolution: resolution/);
  assert.match(batch, /submittedResolution: params.resolution/);
  const retry = regeneratedTaskRecord({ sourceTask: tasks[0], createdTask: { id: "new-retry" }, profile: { id: profileId, name: "LWAIGC" },
    model, reuseSnapshot: { resolution: "720p" }, createdAtMs: at(11,19) });
  assert.equal(retry.submittedResolution, "720p");
  assert.equal(submissionRecord(retry).resolution, "720p");
  assert.equal(recordedTaskResolution(tasks[0]), "480p", "source task is not mutated");
});

test("v2 database upgrade recovers existing snapshots, preserves newer ledger facts and leaves deleted unknowns unknown", async (t) => {
  const original = task("live", "480p", { status: "processing", updatedAtMs: 10 });
  const receipt = { ...submissionRecord(original), status: "completed", updatedAtMs: 99 }; delete receipt.resolution;
  const deleted = { id: "deleted", profileId, model, status: "completed", createdAtMs: at(11,3) };
  const fixture = taskDatabase([original], { version: 2, records: [receipt, deleted] });
  const oldDB = globalThis.indexedDB, oldRange = globalThis.IDBKeyRange;
  globalThis.indexedDB = fixture.indexedDB;
  globalThis.IDBKeyRange = { only: (v) => v };
  t.after(() => { globalThis.indexedDB = oldDB; globalThis.IDBKeyRange = oldRange; });
  const store = await import("../src/taskStore.js?resolution-upgrade");
  const records = await store.getSubmissionRecords();
  const live = records.find((r) => r.id === "live");
  assert.equal(live.resolution, "480p");
  assert.equal(live.status, "completed");
  assert.equal(live.updatedAtMs, 99);
  assert.equal(records.find((r) => r.id === "deleted").resolution, undefined);
  assert.equal(taskEstimatedCost(live, settings), 3.5);
  assert.equal(taskEstimatedCost(records.find((r) => r.id === "deleted"), settings), 4.5);
  assert.deepEqual(await store.allTasks(), [original], "full task data must not be rewritten by backfill");
});
