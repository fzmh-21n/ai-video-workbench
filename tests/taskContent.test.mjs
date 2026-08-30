import test from "node:test";
import assert from "node:assert/strict";
import { directTaskContentPaths, requiresOriginalTaskKey, taskContentRequestUrl } from "../src/taskContent.js";

test("uses FMGO task file route before the generic video content route", () => {
  assert.deepEqual(directTaskContentPaths("fmgo", "task_abc/123"), [
    "/v1/tasks/task_abc%2F123/file",
    "/v1/videos/task_abc%2F123/content",
  ]);
});

test("keeps the generic content route for compatible adapters", () => {
  assert.deepEqual(directTaskContentPaths("lwaigc", "task_abc"), [
    "/v1/videos/task_abc/content",
  ]);
});

test("does not invent content routes for adapters that do not expose one", () => {
  assert.deepEqual(directTaskContentPaths("pidoi", "task_abc"), []);
});

test("allows an FMGO task to be queried with another current FMGO key", () => {
  assert.equal(requiresOriginalTaskKey("fmgo"), false);
  assert.equal(requiresOriginalTaskKey("lwaigc"), true);
});

test("persists a provider result URL through the local content proxy", () => {
  assert.equal(
    taskContentRequestUrl({ id: "task_abc/123", sourceVideoUrl: "https://pic7.fmgo.top/generated/a b.mp4" }),
    "/api/tasks/task_abc%2F123/content?source=https%3A%2F%2Fpic7.fmgo.top%2Fgenerated%2Fa%20b.mp4",
  );
  assert.equal(taskContentRequestUrl({ id: "task_plain" }), "/api/tasks/task_plain/content");
});
