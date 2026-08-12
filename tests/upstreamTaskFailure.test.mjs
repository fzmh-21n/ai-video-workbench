import assert from "node:assert/strict";
import test from "node:test";

import { taskFailureDetails } from "../src/upstreamTaskFailure.js";

test("extracts nested provider failure reasons and codes", () => {
  assert.deepEqual(taskFailureDetails({
    data: { error: { code: "POOL_EMPTY", message: "限量资源已用完" } },
  }), { reason: "限量资源已用完", code: "POOL_EMPTY" });
});

test("marks a provider failure as unexplained when no reason is returned", () => {
  assert.deepEqual(taskFailureDetails({ status: "failed" }), {
    reason: "视频生成失败（中转未返回具体原因）",
    code: "",
  });
});
