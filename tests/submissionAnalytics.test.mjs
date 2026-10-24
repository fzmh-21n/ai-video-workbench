import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { modelSubmissionStats, submissionRecordsCsv } from "../src/submissionAnalytics.js";
import { costSeries, modelPriceKey } from "../src/costAnalytics.js";

const at = (day, hour = 12) => new Date(2026, 9, day, hour).getTime();
const task = (id, patch = {}) => ({
  id, profileId: "relay", providerName: "小熊猫", model: "wanzhou-seedance-2.0",
  projectName: "项目A", createdAtMs: at(23), status: "processing", ...patch,
});
const signed = (taskId, extra = {}) => Buffer.from(JSON.stringify({
  taskId, adapter: "seedancevideo", baseUrl: "https://772808.xyz", model: "wanzhou-seedance-2.0", ...extra,
})).toString("base64url") + ".signature";

test("accepted counts distinct task IDs regardless of final success, failure or refund wording", () => {
  const [group] = modelSubmissionStats([
    task("a", { status: "completed" }), task("b", { status: "failed", error: "积分已退回" }),
    task("c", { status: "queued" }), task("d", { status: "failed", cancelledByUser: true }),
    task("e", { status: "unknown" }), task("b", { status: "failed" }), task(""),
  ]);
  assert.deepEqual([group.accepted, group.completed, group.failed, group.processing, group.cancelled, group.unknown], [5, 1, 1, 1, 1, 1]);
  assert.equal(group.accepted, group.completed + group.failed + group.processing + group.cancelled + group.unknown);
});

test("same upstream ID under different signed recovery tokens is one acceptance", () => {
  const first = task(signed("task-1", { oldRoute: true }), { status: "processing", updatedAtMs: 100 });
  const next = task(signed("task-1", { statusPath: "/v1/videos/task-1" }), { status: "completed", updatedAtMs: 200 });
  const [group] = modelSubmissionStats([first, next, { ...first, updatedAtMs: 50 }]);
  assert.equal(group.accepted, 1);
  assert.equal(group.completed, 1);
  assert.equal(group.records[0].taskId, "task-1");
  assert.equal(group.records[0].createdAtMs, first.createdAtMs);
});

test("an unverified manually recovered ID is excluded until the upstream confirms it", () => {
  assert.deepEqual(modelSubmissionStats([task("pasted-id", { submissionVerified: false })]), []);
  const [group] = modelSubmissionStats([task("pasted-id", { submissionVerified: true })]);
  assert.equal(group.accepted, 1);
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const recovery = server.slice(server.indexOf('app.post("/api/tasks/recover",'), server.indexOf('app.post("/api/tasks/recover-submissions",'));
  assert.match(recovery, /submissionVerified: false/);
  assert.match(server.slice(server.indexOf('app.get("/api/tasks/:id",')), /submissionVerified: true/);
});

test("a different relay with the same raw ID remains a separate acceptance", () => {
  const groups = modelSubmissionStats([task("task-1"), task("task-1", { profileId: "other", providerName: "别家" })]);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.accepted === 1));
  const decoded = modelSubmissionStats([task(signed("same")), task(signed("same", { baseUrl: "https://other.example" }), { profileId: "other" })]);
  assert.equal(decoded.reduce((count, group) => count + group.accepted, 0), 2);
});

test("recovery aliases retain their earliest submission date regardless of input order and cost uses one real task", () => {
  const original = task(signed("one", { route: "old" }), { createdAtMs: at(22), status: "completed", updatedAtMs: at(22), completedAt: new Date(at(23)).toISOString() });
  const recovered = task(signed("one", { route: "new" }), { createdAtMs: at(23), status: "completed", updatedAtMs: at(23), completedAt: original.completedAt });
  for (const rows of [[original, recovered], [recovered, original]]) {
    const [yesterday] = modelSubmissionStats(rows, { from: "2026-10-22", to: "2026-10-22" });
    assert.equal(yesterday.accepted, 1);
    assert.equal(yesterday.records[0].createdAtMs, at(22));
    const unique = modelSubmissionStats(rows).flatMap((group) => group.records);
    const [cost] = costSeries(unique, { [modelPriceKey("relay", original.model)]: { unitPrice: 3 } }, "day", 1, at(23));
    assert.deepEqual([cost.submitted, cost.generated, cost.cost], [1, 1, 3]);
  }
});

test("a new task ID counts as another acceptance and same-section additional generation, including cross-day retries", () => {
  const records = [
    task("first", { createdAtMs: at(22), batchTitle: "第01集.txt", batchSection: 1, status: "failed" }),
    task("retry", { createdAtMs: at(23), batchTitle: "第01集", batchSection: 1 }),
    task("other-section", { batchTitle: "第01集", batchSection: 2 }),
    task("manual-retry", { retryOfTaskId: "original" }),
  ];
  const [all] = modelSubmissionStats(records);
  assert.equal(all.accepted, 4);
  assert.equal(all.additional, 2);
  const [today] = modelSubmissionStats(records, { from: "2026-10-23", to: "2026-10-23" });
  assert.equal(today.accepted, 3);
  assert.equal(today.additional, 2, "filtering the earlier failure does not hide the later additional attempt");
});

test("submission-date and project filters do not move an acceptance to its completion date", () => {
  const rows = [task("yesterday", { createdAtMs: at(22), completedAt: new Date(at(23)).toISOString(), status: "completed" }),
    task("today", { createdAtMs: at(23, 0) }), task("other-project", { projectName: "项目B" }),
    task("tomorrow", { createdAtMs: at(24, 0) }), task("unknown-time", { createdAtMs: 0 })];
  const [group] = modelSubmissionStats(rows, { projectName: "项目A", from: "2026-10-23", to: "2026-10-23" });
  assert.equal(group.accepted, 1);
  assert.equal(group.records[0].taskId, "today");
  assert.equal(modelSubmissionStats(rows, { from: "2026-10-24", to: "2026-10-23" }).length, 0);
});

test("archived and deleted lightweight receipts remain counted and explicitly cancelled tasks do not imply refunds", () => {
  const [group] = modelSubmissionStats([task("archive", { archivedAtMs: 100, status: "failed" }),
    task("cancel", { cancelledByUser: true, status: "failed" })]);
  assert.equal(group.accepted, 2);
  assert.equal(group.failed, 1);
  assert.equal(group.cancelled, 1);
  assert.ok(submissionRecordsCsv(group.records).includes("未核实"));
});

test("CSV exports safe upstream IDs and escapes spreadsheet formulas without prompts, signatures or credentials", () => {
  const id = signed("task-public-id", { apiKey: "SECRET-KEY", credentialFingerprint: "PRIVATE-FINGERPRINT" });
  const [group] = modelSubmissionStats([task(id, { providerName: "=CMD()", batchTitle: '含有"引号",换行\n', prompt: "PRIVATE-PROMPT", error: 'Bearer sk_SENSITIVE_ERROR' })]);
  const csv = submissionRecordsCsv(group.records);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("task-public-id"));
  assert.ok(csv.includes("'=CMD()"));
  for (const secret of [id, "SECRET-KEY", "PRIVATE-FINGERPRINT", "PRIVATE-PROMPT", "sk_SENSITIVE_ERROR"]) assert.ok(!csv.includes(secret));
  assert.ok(csv.includes('""引号""'));
});

test("dashboard uses persistent lightweight receipts, exposes per-model counts and labels unverified refunds honestly", () => {
  const source = readFileSync(new URL("../src/CostDashboard.jsx", import.meta.url), "utf8");
  assert.match(source, /getSubmissionRecords\(\)/);
  assert.doesNotMatch(source, /allTasks\(\)/);
  for (const label of ["模型提交台账", "已受理", "生成失败", "同节追加", "task ID 明细", "退款均待账单核实", "过去已彻底删除"]) assert.ok(source.includes(label), label);
  assert.match(source, /detailRecords\.slice\(/, "long histories render one bounded page");
});
