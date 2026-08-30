import assert from "node:assert/strict";
import test from "node:test";

import {
  costSeries,
  currentCostSummary,
  knownProviderModels,
  modelPriceKey,
  projectSuccessfulModels,
  taskEstimatedCost,
} from "../src/costAnalytics.js";

test("calculates completed-task cost from the exact provider and model price", () => {
  const settings = {
    [modelPriceKey("fmgo", "ss-v2-fast")]: { unitPrice: "1.25" },
  };
  assert.equal(taskEstimatedCost({ status: "completed", profileId: "fmgo", model: "ss-v2-fast" }, settings), 1.25);
  assert.equal(taskEstimatedCost({ status: "failed", profileId: "fmgo", model: "ss-v2-fast" }, settings), 0);
  assert.equal(taskEstimatedCost({ status: "completed", profileId: "fmgo", model: "other" }, settings), 0);
});

test("builds daily summary with submitted, generated, failed and estimated cost", () => {
  const now = new Date(2026, 7, 28, 18, 0, 0).getTime();
  const settings = { [modelPriceKey("p1", "m1")]: { unitPrice: 2 } };
  const tasks = [
    { status: "completed", profileId: "p1", model: "m1", createdAtMs: new Date(2026, 7, 28, 9).getTime() },
    { status: "failed", profileId: "p1", model: "m1", createdAtMs: new Date(2026, 7, 28, 10).getTime() },
    { status: "processing", profileId: "p1", model: "m1", createdAtMs: new Date(2026, 7, 28, 11).getTime() },
  ];
  const summary = currentCostSummary(tasks, settings, "day", now);
  assert.deepEqual({ submitted: summary.submitted, generated: summary.generated, failed: summary.failed, cost: summary.cost }, {
    submitted: 3,
    generated: 1,
    failed: 1,
    cost: 2,
  });
  assert.equal(costSeries(tasks, settings, "day", 14, now).length, 14);
});

test("combines live profile models with historical task models", () => {
  const models = knownProviderModels(
    [{ id: "p1", name: "飞猫", model: "current" }],
    { p1: ["current", "another"] },
    [{ profileId: "old", providerName: "旧中转", model: "history" }],
  );
  assert.deepEqual(models.map((item) => item.model).sort(), ["another", "current", "history"]);
});

test("lists successful provider models for one project and calculates subtotals", () => {
  const settings = { [modelPriceKey("p1", "m1")]: { unitPrice: 2.5 } };
  const tasks = [
    { status: "completed", projectName: "项目A", profileId: "p1", providerName: "中转A", model: "m1" },
    { status: "completed", projectName: "项目A", profileId: "p1", providerName: "中转A", model: "m1" },
    { status: "failed", projectName: "项目A", profileId: "p1", providerName: "中转A", model: "m1" },
    { status: "completed", projectName: "项目B", profileId: "p1", providerName: "中转A", model: "m1" },
  ];
  assert.deepEqual(projectSuccessfulModels(tasks, settings, "项目A").map(({ providerName, model, count, unitPrice, subtotal }) => ({
    providerName, model, count, unitPrice, subtotal,
  })), [{ providerName: "中转A", model: "m1", count: 2, unitPrice: 2.5, subtotal: 5 }]);
});
