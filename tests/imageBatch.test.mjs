import assert from "node:assert/strict";
import test from "node:test";

import { completedImageReferenceIds, imageDownloadFilename, imagePromptWithFixedContent, imageTaskEntries } from "../src/imageBatch.js";

test("prepends image fixed content without changing either text", () => {
  assert.equal(imagePromptWithFixedContent("统一人物画风", "把背景改成雪夜"), "统一人物画风\n\n把背景改成雪夜");
});

test("keeps the uploaded filename for a batch image result", () => {
  assert.equal(imageDownloadFilename({ sourceName: "角色图_王丽华.png", title: "unused" }, "image/webp"), "角色图_王丽华.png");
  assert.equal(imageDownloadFilename({ title: "单条图片" }, "image/webp"), "单条图片.webp");
});

test("clears only completed batch source images", () => {
  const references = [
    { id: "ref-1", name: "第一张.png" },
    { id: "ref-2", name: "第二张.png" },
    { id: "ref-3", name: "第三张.png" },
  ];
  const tasks = [
    { sourceReferenceId: "ref-1", sourceName: "第一张.png", status: "completed" },
    { sourceReferenceId: "ref-2", sourceName: "第二张.png", status: "processing" },
    { sourceReferenceId: "ref-3", sourceName: "第三张.png", status: "failed" },
  ];
  assert.deepEqual([...completedImageReferenceIds(references, tasks)], ["ref-1"]);
});

test("groups each image batch once while keeping single tasks separate", () => {
  const tasks = [
    { id: "batch-a-1", batchId: "batch-a" },
    { id: "batch-a-2", batchId: "batch-a" },
    { id: "single-1" },
    { id: "batch-b-1", batchId: "batch-b" },
  ];
  assert.deepEqual(imageTaskEntries(tasks), [
    { type: "batch", id: "batch-a", tasks: [tasks[0], tasks[1]] },
    { type: "task", task: tasks[2] },
    { type: "batch", id: "batch-b", tasks: [tasks[3]] },
  ]);
});
