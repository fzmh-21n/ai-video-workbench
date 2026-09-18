import assert from "node:assert/strict";
import test from "node:test";

import { loadDeletedIds, rememberDeletedIds, withoutDeletedIds } from "../src/deletionStore.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("persists deleted IDs across a simulated restart", () => {
  const storage = memoryStorage();
  rememberDeletedIds("deleted", ["task-1", "task-2"], storage);
  rememberDeletedIds("deleted", ["task-2", "task-3"], storage);
  assert.deepEqual(loadDeletedIds("deleted", storage), ["task-1", "task-2", "task-3"]);
});

test("does not recover a task explicitly deleted by the user", () => {
  assert.deepEqual(withoutDeletedIds([{ id: "keep" }, { id: "deleted" }], ["deleted"]), [{ id: "keep" }]);
});
