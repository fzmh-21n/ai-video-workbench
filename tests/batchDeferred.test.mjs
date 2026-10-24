import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { BATCH_PAGE_SIZE } from "../src/batchPerformance.js";
import { importBatchTextFiles } from "../src/batchTextFiles.js";

import {
  batchSerializable,
  canBatchDefer,
  canBatchMatch,
  canBatchResubmit,
  canBatchSubmit,
  filterBatchItems,
  overnightRetryableItems,
  recoverInterruptedBatchItems,
  setBatchItemsDeferred,
} from "../src/batchPrompts.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be extracted from the real batch component`);
  return source.slice(start, end);
}

function handlerContext(items, plan = null, busy = "") {
  const state = { items, plan, selection: ["selected"], filter: "deferred", notices: [], mutations: [], uploads: [] };
  const ctx = vm.createContext({
    items,
    itemsRef: { current: items },
    busy,
    autoRetryRunningRef: { current: false },
    selectedItems: items.filter((item) => item.selected && canBatchDefer(item)),
    deferredItems: filterBatchItems(items, "deferred"),
    setBatchItemsDeferred,
    importBatchTextFiles,
    uid: () => "mock-import",
    BATCH_PAGE_SIZE,
    Date: { now: () => 1000 },
    apiKey: "local-mock-only",
    setItems: (update) => { state.items = typeof update === "function" ? update(state.items) : update; state.mutations.push("items"); },
    setOvernightPlan: (update) => { state.plan = typeof update === "function" ? update(state.plan) : update; state.mutations.push("plan"); },
    setSelectedItemIds: (ids) => { state.selection = ids; state.mutations.push("selection"); },
    setStatusFilter: (filter) => { state.filter = filter; state.mutations.push("filter"); },
    setBatchPage: (page) => { state.page = page; },
    setSourceName: (name) => { state.sourceName = name; },
    setBusy: (value) => { state.busy = value; },
    onNotice: (notice) => state.notices.push(notice),
    preuploadItems: async (values) => { state.uploads.push(values); },
  });
  vm.runInContext(extract("  function deferSelectedItems()", "  async function matchItem("), ctx);
  vm.runInContext(extract("  async function importText(", "  function clearBatch()"), ctx);
  vm.runInContext(extract("  async function preuploadAll()", "  function parametersFor("), ctx);
  return { ctx, state };
}

test("defers only unsubmitted or failed sections and never pauses an active or completed generation", () => {
  for (const status of [undefined, "pending", "unmatched", "matched", "failed", "generation_failed", "not_submitted", "submission_unknown"]) {
    assert.equal(canBatchDefer({ status }), true, `${status} can enter the deferred area`);
    assert.equal(canBatchDefer({ status, deferred: true }), false, `${status} already deferred`);
  }
  for (const status of ["submitting", "submitted", "generating", "generated"]) {
    assert.equal(canBatchDefer({ status }), false, `${status} must not be moved away while active or complete`);
  }
});

test("moves only selected eligible IDs without changing prompts, tasks, media or previous failure evidence", () => {
  const reference = { id: "image-1", kind: "image", name: "角色图_001_陈凡.png", source: "manual" };
  const selected = {
    id: "selected", section: 1, sourceName: "第01集.txt", prompt: "提示词 @Image1",
    status: "generation_failed", error: "人脸审核失败", taskIds: ["old-task"],
    references: [reference], missingImages: [], downloaded: true, downloadedCount: 1,
    manuallyMarkedDownloaded: true, manuallyMarkedUnusable: true,
    lastSubmission: { model: "seedance-2.5", attemptedAt: 1000 },
  };
  const other = { id: "other", status: "matched", prompt: "别的集的提示词" };
  const active = { id: "active", status: "generating", taskIds: ["active-task"] };
  const complete = { id: "complete", status: "generated", downloaded: false };
  const items = [selected, other, active, complete];
  const snapshot = structuredClone(items);

  const moved = setBatchItemsDeferred(items, ["selected", "active", "complete", "does-not-exist"]);

  assert.deepEqual(moved[0], { ...selected, deferred: true });
  assert.equal(moved[1], other);
  assert.equal(moved[2], active);
  assert.equal(moved[3], complete);
  assert.deepEqual(items, snapshot, "the original array and every selected record are immutable");
  assert.equal(moved[0].references, selected.references);
  assert.deepEqual(setBatchItemsDeferred(moved, ["selected"]), moved, "moving the same ID twice does not duplicate it");
});

test("releases selected deferred sections while preserving their real state and uncertain task receipts", () => {
  const failed = { id: "failed", status: "generation_failed", deferred: true, taskIds: ["previous-task"], error: "真实失败" };
  const unknown = { id: "unknown", status: "submission_unknown", deferred: true, taskIds: [], error: "上游是否收单未知" };
  const stillDeferred = { id: "keep", status: "matched", deferred: true };
  const ordinary = { id: "ordinary", status: "matched" };
  const released = setBatchItemsDeferred([failed, unknown, stillDeferred, ordinary], ["failed", "unknown", "ordinary"], false);

  assert.deepEqual(released[0], { ...failed, deferred: false });
  assert.deepEqual(released[1], { ...unknown, deferred: false });
  assert.equal(released[2], stillDeferred);
  assert.equal(released[3], ordinary);
  assert.equal(canBatchSubmit(released[0]), true);
  assert.equal(canBatchMatch(released[1]), false);
  assert.equal(canBatchSubmit(released[1]), false, "releasing an uncertain receipt must not authorize another paid submission");
  assert.equal(canBatchResubmit(released[1]), false);
});

test("separates the deferred area from every normal status and undownloaded filter while all retains the source records", () => {
  const statuses = ["pending", "matched", "submitting", "submitted", "generating", "generated", "failed", "generation_failed", "submission_unknown", "not_submitted"];
  const normal = statuses.map((status) => ({ id: `normal-${status}`, status }));
  const deferred = statuses.map((status) => ({ id: `deferred-${status}`, status, deferred: true }));
  const items = [...normal, ...deferred];

  assert.deepEqual(filterBatchItems(items, "deferred"), deferred);
  assert.deepEqual(filterBatchItems(items, "all"), items);
  assert.deepEqual(filterBatchItems(items), items);
  for (const filter of ["pending", "matched", "submitting", "generating", "generated", "failed", "undownloaded"]) {
    assert.equal(filterBatchItems(items, filter).some((item) => item.deferred), false, `${filter} must exclude the deferred area`);
  }
  assert.deepEqual(filterBatchItems(items, "undownloaded").map((item) => item.id), ["normal-generated"]);
  assert.deepEqual(filterBatchItems([], "deferred"), []);
  assert.deepEqual(filterBatchItems(undefined, "deferred"), []);
});

test("retains deferred flags, reference metadata and original statuses through save and restart recovery", () => {
  const items = [
    {
      id: "deferred-unknown", status: "submission_unknown", deferred: true,
      prompt: "不可确认是否创建的任务", taskIds: [], error: "未知收单结果",
      references: [{ id: "image-1", kind: "image", name: "角色图_001_陈凡.png", url: "https://assets.example/reference.png" }],
      downloaded: false,
    },
    { id: "ordinary", status: "matched", prompt: "普通任务", references: [] },
  ];

  const restored = recoverInterruptedBatchItems(JSON.parse(JSON.stringify(batchSerializable(items))));

  assert.deepEqual(restored, items);
  assert.deepEqual(filterBatchItems(restored, "deferred"), [restored[0]]);
  assert.equal(canBatchSubmit(restored[0]), false);
  assert.equal(canBatchMatch(restored[0]), false);
});

test("interrupted submission recovery never removes an existing deferred flag or invents a formal task ID", () => {
  const restored = recoverInterruptedBatchItems([
    { id: "no-receipt", status: "submitting", taskIds: [], deferred: true },
    { id: "with-receipt", status: "submitting", taskIds: ["formal-task"], deferred: true },
  ]);

  assert.equal(restored[0].status, "not_submitted");
  assert.equal(restored[0].deferred, true);
  assert.deepEqual(restored[0].taskIds, []);
  assert.equal(canBatchSubmit(restored[0]), false);
  assert.equal(restored[1].status, "generating");
  assert.equal(restored[1].deferred, true);
  assert.deepEqual(restored[1].taskIds, ["formal-task"]);
});

test("all ordinary matching, submission and completed-regeneration eligibility reject deferred sections", () => {
  for (const status of [undefined, "pending", "unmatched", "matched", "failed", "generation_failed", "not_submitted", "submission_unknown", "submitting", "submitted", "generating", "generated"]) {
    const item = { id: status || "unset", status, deferred: true };
    assert.equal(canBatchMatch(item), false, `${status} must not get matched or uploaded automatically`);
    assert.equal(canBatchSubmit(item), false, `${status} must not submit another paid task`);
    assert.equal(canBatchResubmit(item), false, `${status} must not regenerate automatically`);
  }
});

test("excludes deferred failures from hosted retry queues even when the stored hosted plan still contains their IDs", () => {
  const plan = { itemIds: ["failed", "generation-failed", "not-submitted", "normal-failed", "unknown", "active"] };
  const items = [
    { id: "failed", status: "failed", deferred: true },
    { id: "generation-failed", status: "generation_failed", deferred: true },
    { id: "not-submitted", status: "not_submitted", deferred: true },
    { id: "normal-failed", status: "failed" },
    { id: "unknown", status: "submission_unknown", deferred: true },
    { id: "active", status: "generating" },
  ];

  assert.deepEqual(overnightRetryableItems(items, plan).map((item) => item.id), ["normal-failed"]);
  const released = setBatchItemsDeferred(items, ["generation-failed", "unknown"], false);
  assert.deepEqual(overnightRetryableItems(released, plan).map((item) => item.id), ["generation-failed", "normal-failed"]);
  assert.equal(canBatchSubmit(released.find((item) => item.id === "unknown")), false);
});

test("the real move handler removes selected sections from the hosted plan and its receipt baselines", () => {
  const items = [
    { id: "selected", status: "generation_failed", selected: true, taskIds: ["old-task"], error: "真实失败" },
    { id: "unknown", status: "submission_unknown", selected: true, taskIds: [], error: "收单结果未知" },
    { id: "keep", status: "generating", taskIds: ["active-task"] },
  ];
  const plan = {
    itemIds: ["selected", "unknown", "keep"],
    baselineTaskIds: { selected: ["old-task"], unknown: [], keep: ["previous-active-task"] },
    providerName: "Panda", model: "seedance-2.5", autoRetryFailures: true,
  };
  const { ctx, state } = handlerContext(items, plan);

  ctx.deferSelectedItems();

  assert.deepEqual(state.items, [
    { ...items[0], deferred: true }, { ...items[1], deferred: true }, items[2],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(state.plan)), {
    ...plan, itemIds: ["keep"], baselineTaskIds: { keep: ["previous-active-task"] },
  });
  assert.deepEqual(Array.from(state.selection), []);
  assert.equal(state.notices.length, 1);
  assert.equal(state.uploads.length, 0);
  assert.deepEqual(overnightRetryableItems(state.items, state.plan), []);
});

test("the real release handler restores original states without restoring hosted retry membership or submitting anything", () => {
  const items = [
    { id: "failed", status: "generation_failed", deferred: true, error: "素材需修改", taskIds: ["old-task"] },
    { id: "unknown", status: "submission_unknown", deferred: true, error: "收单结果未知", taskIds: [] },
    { id: "active", status: "generating", taskIds: ["active-task"] },
  ];
  const plan = { itemIds: ["active"], baselineTaskIds: { active: ["previous-active-task"] }, autoRetryFailures: true };
  const { ctx, state } = handlerContext(items, plan);

  ctx.releaseDeferredItems();

  assert.deepEqual(state.items, [
    { ...items[0], deferred: false }, { ...items[1], deferred: false }, items[2],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(state.plan)), plan, "releasing must not restore paid hosted retry membership");
  assert.equal(state.filter, "all");
  assert.deepEqual(Array.from(state.selection), []);
  assert.deepEqual(overnightRetryableItems(state.items, state.plan), []);
  assert.equal(canBatchSubmit(state.items[1]), false);
  assert.equal(state.uploads.length, 0);
});

test("releasing after inconsistent restart storage removes stale hosted membership before a retry timer can charge again", () => {
  const items = [
    { id: "failed", status: "generation_failed", deferred: true, error: "素材需修改", taskIds: ["old-task"] },
    { id: "unknown", status: "submission_unknown", deferred: true, error: "收单结果未知", taskIds: [] },
    { id: "keep", status: "generating", taskIds: ["active-task"] },
  ];
  const stalePlan = {
    itemIds: ["failed", "unknown", "keep"],
    baselineTaskIds: { failed: ["old-task"], unknown: [], keep: ["old-active-task"] },
    autoRetryFailures: true, retryRound: 3,
  };
  const { ctx, state } = handlerContext(items, stalePlan);

  ctx.releaseDeferredItems();

  assert.equal(state.items[0].deferred, false);
  assert.equal(canBatchSubmit(state.items[0]), true, "release permits a later explicit manual submission");
  assert.deepEqual(JSON.parse(JSON.stringify(state.plan)), {
    ...stalePlan, itemIds: ["keep"], baselineTaskIds: { keep: ["old-active-task"] },
  });
  assert.deepEqual(overnightRetryableItems(state.items, state.plan), [], "the next automatic hosted scan must not create a paid retry");
  assert.deepEqual(state.items[0].taskIds, ["old-task"]);
  assert.equal(canBatchSubmit(state.items[1]), false);
});

test("the real move and release handlers do nothing while another batch operation is busy", () => {
  const items = [
    { id: "selected", status: "matched", selected: true },
    { id: "deferred", status: "generation_failed", deferred: true },
  ];
  const plan = { itemIds: ["selected"], baselineTaskIds: { selected: [] } };
  const { ctx, state } = handlerContext(items, plan, "submitting");

  ctx.deferSelectedItems();
  ctx.releaseDeferredItems();

  assert.equal(state.items, items);
  assert.equal(state.plan, plan);
  assert.deepEqual(state.mutations, []);
  assert.deepEqual(state.notices, []);
});

test("the hosted synchronous lock blocks moving and releasing before the busy state renders", () => {
  const items = [
    { id: "selected", status: "matched", selected: true },
    { id: "deferred", status: "generation_failed", deferred: true },
  ];
  const plan = { itemIds: ["selected"], baselineTaskIds: { selected: [] }, autoRetryFailures: true };
  const { ctx, state } = handlerContext(items, plan);
  ctx.autoRetryRunningRef.current = true;

  ctx.deferSelectedItems();
  ctx.releaseDeferredItems();

  assert.equal(ctx.busy, "");
  assert.equal(state.items, items);
  assert.equal(state.plan, plan);
  assert.deepEqual(state.mutations, []);
  assert.deepEqual(state.notices, []);
});

test("appending another TXT through the real importer preserves deferred sections and active task identities", async () => {
  const items = [
    { id: "old-deferred", sourceName: "第01集.txt", section: 1, status: "failed", deferred: true, taskIds: ["old-task"], prompt: "原文" },
    { id: "old-active", sourceName: "第02集.txt", section: 1, status: "generating", taskIds: ["active-task"], prompt: "正在生成" },
  ];
  const { ctx, state } = handlerContext(items, null, "submitting");
  await ctx.importText({ name: "第03集.txt", text: async () => "剧情[1]：新集的第一节\n提示词一\n\n剧情[2]：新集的第二节\n提示词二" });

  assert.equal(state.items.length, 4);
  assert.equal(state.items[0], items[0]);
  assert.equal(state.items[1], items[1]);
  assert.deepEqual(Array.from(state.items.slice(2), (item) => [item.sourceName, item.section, item.status]), [
    ["第03集.txt", 1, "unmatched"], ["第03集.txt", 2, "unmatched"],
  ]);
  assert.equal(new Set(state.items.map((item) => item.id)).size, 4);
  assert.equal(state.sourceName, "第03集.txt");
  assert.equal(state.plan, null);
});

test("the real preupload-all handler skips references belonging to deferred sections", async () => {
  const items = [
    { id: "deferred", status: "matched", deferred: true, references: [{ name: "暂不上传.png" }] },
    { id: "normal", status: "matched", references: [{ name: "继续上传.png" }] },
  ];
  const { ctx, state } = handlerContext(items);

  await ctx.preuploadAll();

  assert.equal(state.uploads.length, 1);
  assert.deepEqual(Array.from(state.uploads[0]), [items[1]]);
  assert.equal(state.busy, "");
});

test("the real batch UI exposes eligible-only selection, deferred filtering and busy-safe move and release controls", () => {
  assert.match(source, /\["deferred",\s*"暂不生成区",\s*deferredItems\.length\]/);
  assert.match(source, /className="batch-item-select"[\s\S]*?type="checkbox"[\s\S]*?disabled=\{\!\!busy \|\| \!canBatchDefer\(item\)\}/);
  assert.match(source, /disabled=\{\!\!busy \|\| \!selectedItems\.length\} onClick=\{deferSelectedItems\}>移入暂不生成区/);
  assert.match(source, /disabled=\{\!\!busy \|\| \!deferredItems\.length\} onClick=\{releaseDeferredItems\}>一键释放暂不生成区/);
  assert.match(source, /disabled=\{\!\!busy \|\| \!canBatchMatch\(item\)\} onClick=\{\(\) => matchOne\(item\.id\)\}/);
  assert.match(source, /disabled=\{\!\!busy \|\| \!\!issue \|\| item\.deferred\} onClick=\{\(\) => submitSelected/);
});
