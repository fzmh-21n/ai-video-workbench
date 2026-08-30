import assert from "node:assert/strict";
import test from "node:test";

import {
  batchSubmissionPlan,
  batchSourceNames,
  batchItemsForSource,
  batchStatusGroup,
  canBatchMatch,
  canBatchResubmit,
  canBatchSubmit,
  deterministicBatchStopReason,
  filterBatchItems,
  parseRecoveredTaskIds,
  providerBatchSubmissionPlan,
  runOrderedStaggered,
  runWithConcurrency,
  splitBatchPrompts,
} from "../src/batchPrompts.js";

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
