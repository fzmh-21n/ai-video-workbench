import assert from "node:assert/strict";
import test from "node:test";

import {
  batchSubmissionPlan,
  batchItemChapterLabel,
  batchSourceNames,
  batchItemsForSource,
  batchStatusGroup,
  beginBatchSubmission,
  canBatchMatch,
  canBatchResubmit,
  canBatchSubmit,
  clearBatchReferences,
  deterministicBatchStopReason,
  failBatchSubmission,
  filterBatchItems,
  clearManualBatchCompletion,
  clearManualBatchDownload,
  manuallyCompleteBatchItem,
  overnightBatchReport,
  parseRecoveredTaskIds,
  providerBatchSubmissionPlan,
  reconciledBatchTerminalState,
  removeBatchReferenceKind,
  recoverInterruptedBatchItems,
  runOrderedStaggered,
  runWithConcurrency,
  splitBatchPrompts,
} from "../src/batchPrompts.js";

test("manually marks one batch section generated and downloaded without inventing a task", () => {
  const original = { id: "section-1", status: "generation_failed", progress: 100, error: "上游失败", taskIds: ["task-1"] };
  const generated = manuallyCompleteBatchItem(original);
  assert.equal(generated.status, "generated");
  assert.equal(generated.manuallyMarkedGenerated, true);
  assert.equal(generated.downloaded, false);
  assert.deepEqual(generated.taskIds, ["task-1"]);
  assert.equal(reconciledBatchTerminalState(generated, [{ id: "task-1", status: "failed" }]).status, "generated");

  const downloaded = manuallyCompleteBatchItem(generated, true);
  assert.equal(downloaded.downloaded, true);
  assert.equal(downloaded.downloadedCount, 1);
  assert.equal(clearManualBatchDownload(downloaded).downloaded, false);

  const restored = clearManualBatchCompletion(downloaded);
  assert.equal(restored.status, "generation_failed");
  assert.equal(restored.error, "上游失败");
  assert.equal(restored.manuallyMarkedGenerated, false);
});

test("removes every audio reference marker while preserving voice instructions and other media", () => {
  const item = {
    prompt: "【角色声线】【配音指令】\n（@声音2=声音2）王丽华尖刻说话，节奏参考 @Audio2。\n【出场人物】@王丽华=王丽华",
    references: [
      { kind: "image", tag: "@Image1", alias: "王丽华", name: "王丽华.png" },
      { kind: "audio", tag: "@Audio1", alias: "声音1", name: "声音1.wav" },
      { kind: "audio", tag: "@Audio2", alias: "声音2", name: "声音2.wav" },
    ],
  };

  const result = removeBatchReferenceKind(item, "audio");

  assert.deepEqual(result.references, [item.references[0]]);
  assert.match(result.prompt, /（声音2）王丽华尖刻说话，节奏参考 声音2/);
  assert.match(result.prompt, /@王丽华=王丽华/);
  assert.doesNotMatch(result.prompt, /@Audio|@声音\d+=/i);
});

test("clears every reference from one batch item without clearing its prompt", () => {
  const item = {
    prompt: "【出场人物】@苏晏=苏晏\n【出场场景】@帐篷=帐篷\n动作参考 @Video1，声音参考 @Audio1。",
    references: [
      { kind: "image", tag: "@Image1", alias: "苏晏", name: "苏晏.png" },
      { kind: "image", tag: "@Image2", alias: "帐篷", name: "帐篷.png" },
      { kind: "video", tag: "@Video1", name: "动作.mp4" },
      { kind: "audio", tag: "@Audio1", name: "声音1.wav" },
    ],
  };

  const result = clearBatchReferences(item);

  assert.deepEqual(result.references, []);
  assert.match(result.prompt, /【出场人物】苏晏/);
  assert.match(result.prompt, /【出场场景】帐篷/);
  assert.match(result.prompt, /动作参考 动作，声音参考 声音1/);
});

test("requires a newly received task ID before declaring an overnight batch safe", () => {
  const plan = {
    itemIds: ["new", "retry"],
    baselineTaskIds: { new: [], retry: ["old-task"] },
  };
  const waiting = overnightBatchReport([
    { id: "new", status: "generating", taskIds: ["new-task"] },
    { id: "retry", status: "failed", taskIds: ["old-task"] },
  ], plan);
  assert.equal(waiting.acceptedTaskCount, 1);
  assert.equal(waiting.awaitingReceipt, 1);
  assert.equal(waiting.safeToShutdown, false);

  const ready = overnightBatchReport([
    { id: "new", status: "generating", taskIds: ["new-task"] },
    { id: "retry", status: "generated", taskIds: ["retry-task"] },
  ], plan);
  assert.equal(ready.acceptedTaskCount, 2);
  assert.equal(ready.awaitingReceipt, 0);
  assert.equal(ready.safeToShutdown, true);
});

test("shows the source chapter beside repeated section numbers", () => {
  assert.equal(batchItemChapterLabel("第02章《标题》_15秒视频提示词.txt"), "第2章");
  assert.equal(batchItemChapterLabel("07_第七章_提示词.txt"), "第7章");
  assert.equal(batchItemChapterLabel("第十二章《标题》.txt"), "第十二章");
});

test("recovers batch rows interrupted while submitting", () => {
  const items = recoverInterruptedBatchItems([
    { id: "no-id", status: "submitting", progress: 20, taskIds: [] },
    { id: "has-id", status: "submitting", taskIds: ["task-1"] },
    { id: "failed", status: "generation_failed", taskIds: ["task-2"] },
  ]);
  assert.equal(items[0].status, "not_submitted");
  assert.equal(items[0].progress, 0);
  assert.match(items[0].error, /尚未创建任务/);
  assert.equal(canBatchSubmit(items[0]), true);
  assert.equal(items[1].status, "generating");
  assert.equal(items[2].status, "generation_failed");
});

test("a new relay attempt cannot be overwritten by the previous failed task", () => {
  const previous = {
    id: "section-1",
    status: "generation_failed",
    error: "上一轮人像审核失败",
    taskIds: ["old-task"],
  };
  const profile = { id: "pidoi", name: "QIQI", model: "jiuyue111" };
  const submitting = beginBatchSubmission(previous, profile, 1000);
  assert.equal(submitting.status, "submitting");
  assert.equal(submitting.error, "");
  assert.deepEqual(submitting.taskIds, []);
  const storedTasks = [{ id: "old-task", status: "failed", error: "上一轮人像审核失败" }];
  const relatedTasks = submitting.taskIds.map((taskId) => storedTasks.find((task) => task.id === taskId)).filter(Boolean);
  assert.equal(reconciledBatchTerminalState(submitting, relatedTasks), null);

  const upstreamError = Object.assign(new Error("Upstream service temporarily unavailable"), { status: 502 });
  const failed = failBatchSubmission(submitting, upstreamError, profile, 2000);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "Upstream service temporarily unavailable");
  assert.deepEqual(failed.taskIds, []);
  assert.equal(failed.lastSubmission.providerName, "QIQI");
  assert.equal(failed.lastSubmission.model, "jiuyue111");
  assert.equal(failed.lastSubmission.statusCode, 502);
  assert.equal(failed.lastSubmission.taskCreated, false);
});

test("does not leave a batch row generating forever after its task record disappears", () => {
  const result = reconciledBatchTerminalState({
    status: "generating",
    taskIds: ["task-missing"],
  }, []);
  assert.equal(result.status, "generation_failed");
  assert.equal(result.progress, 100);
  assert.match(result.error, /任务记录已不存在/);
});

test("uses the stored terminal task state when a batch task finishes", () => {
  const completed = reconciledBatchTerminalState(
    { status: "generating", taskIds: ["task-1"] },
    [{ id: "task-1", status: "completed" }],
    true,
  );
  const failed = reconciledBatchTerminalState(
    { status: "generating", taskIds: ["task-2"] },
    [{ id: "task-2", status: "failed", error: "上游生成失败" }],
  );
  assert.equal(completed.status, "generated");
  assert.equal(failed.status, "generation_failed");
  assert.equal(failed.error, "上游生成失败");
});

test("treats a completed but rejected batch video as waiting to be regenerated", () => {
  const result = reconciledBatchTerminalState(
    { status: "generated", taskIds: ["task-1"] },
    [{ id: "task-1", status: "completed", reviewStatus: "dissatisfied" }],
    false,
  );
  assert.equal(result.status, "generation_failed");
  assert.match(result.error, /标记为不可用/);
});

test("selects only the chapters imported from one TXT source", () => {
  const items = [
    { id: "a", sourceName: "第01章.txt" },
    { id: "b", sourceName: "第02章.txt" },
    { id: "c", sourceName: "第01章.txt" },
  ];
  assert.deepEqual(batchItemsForSource(items, "第01章.txt").map((item) => item.id), ["a", "c"]);
  assert.deepEqual(batchItemsForSource(items, "第02章.txt").map((item) => item.id), ["b"]);
});

test("filters batch chapters by the user-facing status groups", () => {
  const items = [
    { id: "a", status: "pending" },
    { id: "b", status: "matched" },
    { id: "c", status: "submitting" },
    { id: "d", status: "generating" },
    { id: "e", status: "generated" },
    { id: "f", status: "generation_failed" },
  ];
  assert.equal(batchStatusGroup("submitted"), "generating");
  assert.equal(batchStatusGroup("submission_unknown"), "failed");
  assert.deepEqual(filterBatchItems(items, "generating").map((item) => item.id), ["c", "d"]);
  assert.deepEqual(filterBatchItems(items, "failed").map((item) => item.id), ["f"]);
  assert.equal(filterBatchItems(items, "all").length, items.length);
});

test("forces FMGO SS batches into the provider-safe serial plan", () => {
  assert.deepEqual(
    providerBatchSubmissionPlan({ adapter: "fmgo", model: "ss-v2-fast" }, "limited_rush", 20),
    {
      concurrency: 1,
      staggerMs: 5000,
      groupSize: 30,
      cooldownMs: 300000,
      providerLimited: true,
    },
  );
  assert.deepEqual(
    providerBatchSubmissionPlan({ adapter: "fmgo", model: "feimiao-v2-fast-720p-15s" }, "ordered_rush", 3),
    { concurrency: 3, staggerMs: 350 },
  );
});

test("pauses between weighted provider submission groups", async () => {
  const events = [];
  const waits = [];
  await runOrderedStaggered(
    [{ section: 1, quantity: 2 }, { section: 2, quantity: 1 }, { section: 3, quantity: 2 }],
    1,
    0,
    async (item) => events.push(`submit-${item.section}`),
    {
      groupSize: 3,
      cooldownMs: 25,
      weightOf: (item) => item.quantity,
      sleep: async (milliseconds) => waits.push(milliseconds),
      onGroupCooldown: ({ completedGroups, submitted }) => events.push(`cooldown-${completedGroups}-${submitted}`),
    },
  );
  assert.deepEqual(events, ["submit-1", "submit-2", "cooldown-1-2", "submit-3"]);
  assert.deepEqual(waits, [25]);
});

test("splits numbered Chinese prompt sections without splitting SC markers", () => {
  const items = splitBatchPrompts(`3.（第三节，总时长15秒 / 共3镜）\n【本节出场的所有人物】\n001_甲\n镜头1 / SC1\n内容\n\n4.（第四节，总时长15秒 / 共4镜）\n镜头1 / SC1\n内容`);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.section), [3, 4]);
  assert.match(items[0].prompt, /镜头1 \/ SC1/);
  assert.match(items[1].prompt, /^4\.（第四节/);
});

test("starts ordered-rush submissions by numeric section while keeping concurrency", async () => {
  const started = [];
  let active = 0;
  let maximum = 0;
  await runOrderedStaggered([{ section: 31 }, { section: 29 }, { section: 30 }], 3, 2, async (item) => {
    started.push(item.section);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, item.section === 29 ? 20 : 12));
    active -= 1;
  });
  assert.deepEqual(started, [29, 30, 31]);
  assert.equal(maximum, 3);
});

test("strict ordered submission never has more than one request in flight", async () => {
  const started = [];
  let active = 0;
  let maximum = 0;
  await runOrderedStaggered([{ section: 3 }, { section: 1 }, { section: 2 }], 1, 0, async (item) => {
    started.push(item.section);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
  });
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(maximum, 1);
});

test("keeps one global stagger even when several overdue workers become available together", async () => {
  const startedAt = [];
  await runOrderedStaggered(
    Array.from({ length: 12 }, (_, index) => ({ section: index + 1 })),
    3,
    8,
    async () => {
      startedAt.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  );
  const gaps = startedAt.slice(1).map((value, index) => value - startedAt[index]);
  assert.equal(gaps.every((gap) => gap >= 6), true, `unexpected start gaps: ${gaps.join(",")}`);
});

test("keeps numeric start order and avoids burst dispatch across 120 items", async () => {
  const sections = Array.from({ length: 120 }, (_, index) => 120 - index);
  const started = [];
  let active = 0;
  let maximum = 0;
  await runOrderedStaggered(sections.map((section) => ({ section })), 5, 1, async (item) => {
    started.push(item.section);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 4 + (item.section % 3)));
    active -= 1;
  });
  assert.deepEqual(started, Array.from({ length: 120 }, (_, index) => index + 1));
  assert.equal(maximum <= 5, true);
});

test("stops dispatching unsent work after a deterministic batch error", async () => {
  let stopped = false;
  const started = [];
  const result = await runOrderedStaggered(
    Array.from({ length: 20 }, (_, index) => ({ section: index + 1 })),
    5,
    5,
    async (item) => {
      started.push(item.section);
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (item.section === 3) stopped = true;
    },
    { shouldStop: () => stopped },
  );
  assert.equal(started.length < 20, true);
  assert.equal(result.skipped, 20 - started.length);
});

test("uses fixed plans for limited rush and strict order", () => {
  assert.deepEqual(batchSubmissionPlan("limited_rush", 20), { concurrency: 5, staggerMs: 50 });
  assert.deepEqual(batchSubmissionPlan("strict_order", 20), { concurrency: 1, staggerMs: 0 });
  assert.deepEqual(batchSubmissionPlan("ordered_rush", 3), { concurrency: 3, staggerMs: 350 });
});

test("only stops a batch for deterministic account and authentication failures", () => {
  assert.equal(deterministicBatchStopReason({ status: 402, message: "积分不足，剩余可用：193" }), "积分不足，剩余可用：193");
  assert.match(deterministicBatchStopReason({ status: 401, message: "Unauthorized" }), /Unauthorized/);
  assert.match(deterministicBatchStopReason({ status: 400, message: "API Key 已失效" }), /API Key/);
  assert.match(deterministicBatchStopReason({ status: 403, message: "Forbidden" }), /Forbidden/);
  assert.equal(deterministicBatchStopReason({ status: 429, message: "线路繁忙，请稍后重试" }), "");
  assert.equal(deterministicBatchStopReason({ status: 400, message: "本条提示词不合规" }), "");
});

test("parses MEAICC UUID and wr task IDs with optional chapter mapping", () => {
  assert.deepEqual(parseRecoveredTaskIds([
    "29=wr_a1b2-c3",
    "第30节：92f875ee-f97b-4941-b4ef-dc5f7fa60022",
  ].join("\n")), [
    { section: 29, taskId: "wr_a1b2-c3" },
    { section: 30, taskId: "92f875ee-f97b-4941-b4ef-dc5f7fa60022" },
  ]);
});

test("supports an arbitrary starting section and western parentheses", () => {
  const items = splitBatchPrompts("21.(标题一)\nA\n22.（标题二）\nB");
  assert.deepEqual(items.map((item) => item.section), [21, 22]);
});

test("splits wrapped plot bracket sections and removes generator wrappers", () => {
  const items = splitBatchPrompts(`_::~OUTPUT_START::~_
_::~FIELD::~_

剧情[3]：

【本组目标时长】：约14.7秒
【出场人物】：
角色图_002_张桂芳油污版

_::~OUTPUT_END::~_

_::~OUTPUT_START::~_
_::~FIELD::~_

剧情[4]：

【本组目标时长】：约14.6秒
【出场场景】：
场景图_002_垃圾油污小区大厅四视角

_::~OUTPUT_END::~_`);

  assert.deepEqual(items.map((item) => item.section), [3, 4]);
  assert.deepEqual(items.map((item) => item.title), ["剧情[3]", "剧情[4]"]);
  assert.match(items[0].prompt, /^剧情\[3\]：/);
  assert.match(items[1].prompt, /^剧情\[4\]：/);
  assert.doesNotMatch(items.map((item) => item.prompt).join("\n"), /_::~/);
});

test("splits wrapped plot sections whose title follows the bracket number", () => {
  const items = splitBatchPrompts(`_::~OUTPUT_START::~_
_::~FIELD::~_

剧情[1]：踹门质问三万元

【本组目标时长】：14-16秒（默认15.0秒）
【本组剧情任务】：第一节完整内容

_::~OUTPUT_END::~_

_::~OUTPUT_START::~_
_::~FIELD::~_

剧情[2]：病房劝阻被当场拒绝

【本组目标时长】：14-16秒（默认15.0秒）
【本组剧情任务】：第二节完整内容

_::~OUTPUT_END::~_`);

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.section), [1, 2]);
  assert.deepEqual(items.map((item) => item.title), ["踹门质问三万元", "病房劝阻被当场拒绝"]);
  assert.match(items[0].prompt, /^剧情\[1\]：踹门质问三万元/);
  assert.match(items[1].prompt, /第二节完整内容/);
  assert.doesNotMatch(items.map((item) => item.prompt).join("\n"), /_::~/);
});

test("ignores decorative plot banners in Seedance prompt collections", () => {
  const items = splitBatchPrompts(`Seedance 2.0 分节提示词合集
收录范围：剧情[6]—剧情[7]

========================================
剧情[6]
========================================

_::~OUTPUT_START::~_
_::~FIELD::~_
剧情[6]：
【本组目标时长】：约14.9秒
_::~OUTPUT_END::~_

========================================
剧情[7]
========================================

_::~OUTPUT_START::~_
_::~FIELD::~_
剧情[7]：
【本组目标时长】：约14.8秒
_::~OUTPUT_END::~_`);

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.section), [6, 7]);
  assert.deepEqual(items.map((item) => item.title), ["剧情[6]", "剧情[7]"]);
  assert.doesNotMatch(items.map((item) => item.prompt).join("\n"), /={5,}|_::~/);
});

test("ignores full-width decorative banners without duplicating every section", () => {
  const items = splitBatchPrompts(`═══════════════════════════════════════
剧情[167]
═══════════════════════════════════════
_::~OUTPUT_START::~_
_::~FIELD::~_
剧情[167]：
【本组剧情任务】：第一段完整提示词
_::~OUTPUT_END::~_
═══════════════════════════════════════
剧情[168]
═══════════════════════════════════════
_::~OUTPUT_START::~_
_::~FIELD::~_
剧情[168]：
【本组剧情任务】：第二段完整提示词
_::~OUTPUT_END::~_
═══════════════════════════════════════`);

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.section), [167, 168]);
  assert.match(items[0].prompt, /第一段完整提示词/);
  assert.match(items[1].prompt, /第二段完整提示词/);
});

test("keeps the fuller entry when an unknown banner duplicates a section number", () => {
  const items = splitBatchPrompts(`剧情[21]
-----
剧情[21]：
【本组目标时长】：15秒
【本组剧情任务】：这才是真正的完整提示词

剧情[22]：
【本组剧情任务】：下一节`);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.section), [21, 22]);
  assert.match(items[0].prompt, /真正的完整提示词/);
});

test("runs every batch item while respecting the selected concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const completed = [];
  await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    completed.push(value);
    active -= 1;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5]);
});

test("skips active and completed chapters during ordinary later batch operations", () => {
  for (const status of ["submitting", "submitted", "generating", "generated"]) {
    assert.equal(canBatchMatch({ status }), false);
    assert.equal(canBatchSubmit({ status }), false);
  }
  assert.equal(canBatchMatch({ status: "unmatched" }), true);
  assert.equal(canBatchMatch({ status: "failed" }), true);
  assert.equal(canBatchSubmit({ status: "unmatched" }), false);
  assert.equal(canBatchSubmit({ status: "matched" }), true);
  assert.equal(canBatchSubmit({ status: "failed" }), true);
  assert.equal(canBatchSubmit({ status: "not_submitted" }), true);
  assert.equal(canBatchResubmit({ status: "generated" }), true);
  assert.equal(canBatchResubmit({ status: "generating" }), false);
  assert.equal(canBatchResubmit({ status: "failed" }), false);
});

test("lists every imported TXT source once in import order", () => {
  assert.deepEqual(batchSourceNames([
    { sourceName: "第07章_15秒视频提示词.txt" },
    { sourceName: "第07章_15秒视频提示词.txt" },
    { sourceName: "第08章_15秒视频提示词.txt" },
  ], "第08章_15秒视频提示词.txt"), [
    "第07章_15秒视频提示词.txt",
    "第08章_15秒视频提示词.txt",
  ]);
});
