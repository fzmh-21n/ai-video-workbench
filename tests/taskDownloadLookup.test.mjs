import test from "node:test";
import assert from "node:assert/strict";
import { batchItemTasks, createBatchTaskLookup, preferredBatchDownloadTasks } from "../src/taskDownload.js";

test("bulk download builds shared task metadata once rather than rebuilding it for every section", () => {
  let titleReads = 0;
  const tasks = Array.from({ length: 1200 }, (_, index) => ({
    id: `task-${index}`, status: "completed", batchId: "batch", batchSection: index + 1,
    get batchTitle() { titleReads += 1; return "第1集"; },
    prompt: `第${index + 1}节提示词`,
  }));
  const items = tasks.map((task, index) => ({ taskIds: [task.id], section: index + 1, sourceName: "第1集.txt", prompt: task.prompt }));
  const downloads = preferredBatchDownloadTasks(items, tasks);
  assert.equal(downloads.length, 1200);
  assert.ok(titleReads <= tasks.length * 3, `metadata was reread ${titleReads} times`);
  assert.deepEqual(downloads.map((task) => task.id), tasks.map((task) => task.id));
});

test("indexed lookup preserves exact prompt, references, source and missing-ID safeguards", () => {
  const tasks = [
    { id: "a", status: "completed", batchTitle: "第1集", batchSection: 1, prompt: "原提示词", reuseSnapshot: { prompt: "原提示词", references: [{ kind: "image", name: "角色A.png" }] } },
    { id: "b", status: "completed", batchTitle: "第2集", batchSection: 1, prompt: "另一集" },
    { id: "failed", status: "failed", batchTitle: "第1集", batchSection: 1, prompt: "原提示词" },
  ];
  const lookup = createBatchTaskLookup(tasks);
  const cases = [
    { taskIds: ["a"], section: 1, sourceName: "第1集.txt", prompt: "原提示词", references: [{ kind: "image", name: "角色A.png" }] },
    { taskIds: ["missing"], section: 1, sourceName: "第1集.txt", prompt: "原提示词" },
    { taskIds: ["a"], section: 1, sourceName: "第2集.txt", prompt: "另一集" },
    { taskIds: ["failed"], section: 1, sourceName: "第1集.txt", prompt: "原提示词" },
  ];
  for (const item of cases) assert.deepEqual(batchItemTasks(item, lookup), batchItemTasks(item, tasks));
});
