import assert from "node:assert/strict";
import test from "node:test";

import { friendlyUpstreamError } from "../src/upstreamError.js";

test("translates unsupported LEC reference audio into actionable Chinese", () => {
  assert.equal(
    friendlyUpstreamError("referenceAudios is not supported"),
    "当前模型不支持参考音频，请删除音频素材或切换到支持音频参考的模型（原始错误：referenceAudios is not supported）",
  );
});

test("translates related media and sync-audio errors", () => {
  assert.match(friendlyUpstreamError("referenceVideos is not supported"), /不支持参考视频/);
  assert.match(friendlyUpstreamError("referenceImages is not supported"), /不支持参考图片/);
  assert.match(friendlyUpstreamError("generateAudio is not supported"), /不支持生成同步音频/);
});

test("keeps unknown upstream errors unchanged", () => {
  assert.equal(friendlyUpstreamError("insufficient credits"), "insufficient credits");
});
