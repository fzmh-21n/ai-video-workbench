import assert from "node:assert/strict";
import test from "node:test";

import { loadFixedContentByVersion, withFixedContentForVersion } from "../src/fixedContentStore.js";

test("keeps SD2.0 and SD2.5 fixed content independent", () => {
  let contents = loadFixedContentByVersion({ sd20: "二点零", sd25: "二点五" });
  contents = withFixedContentForVersion(contents, "sd25", "新版二点五");
  assert.deepEqual(contents, { sd20: "二点零", sd25: "新版二点五" });
});

test("migrates legacy fixed content only into the active model version", () => {
  assert.deepEqual(loadFixedContentByVersion(null, "旧固定内容", "sd20"), {
    sd20: "旧固定内容", sd25: "",
  });
  assert.deepEqual(loadFixedContentByVersion(null, "旧固定内容", "sd25"), {
    sd20: "", sd25: "旧固定内容",
  });
});
