import assert from "node:assert/strict";
import test from "node:test";

import { mergePolledTaskUpdate, selectPendingTasks } from "../src/taskStore.js";

test("polls the oldest due tasks instead of repeatedly selecting the same ten", () => {
  const tasks = Array.from({ length: 20 }, (_, index) => ({
    id: `task-${index + 1}`,
    nextPollAt: index < 10 ? 20_000 : 10_000,
    createdAtMs: index,
  }));

  assert.deepEqual(
    selectPendingTasks(tasks, 10).map((task) => task.id),
    Array.from({ length: 10 }, (_, index) => `task-${index + 11}`),
  );
});

test("polling status updates preserve a task project moved by the user", () => {
  const stored = {
    id: "task-1",
    title: "用户命名",
    profileId: "profile-1",
    projectName: "新项目",
    status: "processing",
  };
  const stalePollingUpdate = {
    id: "task-1",
    title: "旧标题",
    profileId: "old-profile",
    projectName: "旧项目",
    status: "completed",
    progress: 100,
  };
  const result = mergePolledTaskUpdate(stored, stalePollingUpdate);
  assert.equal(result.projectName, "新项目");
  assert.equal(result.title, "用户命名");
  assert.equal(result.profileId, "profile-1");
  assert.equal(result.status, "completed");
  assert.equal(result.progress, 100);
});
