import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");

test("renders separate submitting and generating filters instead of the combined button", () => {
  assert.match(source, /\["submitting",\s*"提交中",\s*statusGroupCounts\.submitting\s*\|\|\s*0\]/);
  assert.match(source, /\["generating",\s*"生成中",\s*statusGroupCounts\.generating\s*\|\|\s*0\]/);
  assert.doesNotMatch(source, /"提交中\/生成中"/);
});

test("uses the same undownloaded predicate for its filter button, counter and download availability", () => {
  assert.match(source, /const pendingDownloadSections\s*=\s*filterBatchItems\(items,\s*"undownloaded"\)\.length/);
  assert.match(source, /\["undownloaded",\s*"未下载",\s*pendingDownloadSections\]/);
  assert.match(source, /const visibleItems\s*=\s*useMemo\(\(\) => filterBatchItems\(items, statusFilter\)/);
  assert.match(source, /const finalDownloadAvailable\s*=\s*items\.length > 0 && pendingDownloadSections > 0/);
});
