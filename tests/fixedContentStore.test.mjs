import assert from "node:assert/strict";
import test from "node:test";

import {
  addFixedContentTemplate,
  loadFixedContentByVersion,
  loadFixedContentTemplates,
  loadTaskProjectFixedContent,
  removeFixedContentTemplate,
  updateFixedContentTemplate,
  withFixedContentForVersion,
  withTaskProjectFixedContent,
} from "../src/fixedContentStore.js";

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

test("migrates the old version contents into one persistent default template", () => {
  assert.deepEqual(loadFixedContentTemplates(null, { sd20: "二点零", sd25: "二点五" }), [{
    id: "default-fixed-content",
    name: "默认固定内容",
    sd20: "二点零",
    sd25: "二点五",
    createdAtMs: 1,
  }]);
});

test("creates edits searches by stored data and removes fixed content templates", () => {
  const initial = loadFixedContentTemplates([], {});
  const created = addFixedContentTemplate(initial, "古装横屏", "template-2", 2);
  const updated = updateFixedContentTemplate(created, "template-2", {
    name: "古装横屏电影感",
    sd20: "SD2.0 内容",
    sd25: "SD2.5 内容",
  });
  assert.deepEqual(updated[1], {
    id: "template-2",
    name: "古装横屏电影感",
    sd20: "SD2.0 内容",
    sd25: "SD2.5 内容",
    createdAtMs: 2,
  });
  assert.deepEqual(removeFixedContentTemplate(updated, "template-2"), initial);
  assert.throws(() => removeFixedContentTemplate(initial, initial[0].id), /至少保留一条/);
});

test("persists one fixed content selection per task project", () => {
  const assignments = withTaskProjectFixedContent({}, "项目甲", "template-a");
  const storage = {
    value: "",
    getItem() { return this.value; },
  };
  storage.value = JSON.stringify(assignments);
  assert.deepEqual(loadTaskProjectFixedContent(storage), { 项目甲: "template-a" });
  assert.deepEqual(withTaskProjectFixedContent(assignments, "项目乙", "template-b"), {
    项目甲: "template-a",
    项目乙: "template-b",
  });
});
