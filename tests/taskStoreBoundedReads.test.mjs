import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function harness(tasks) {
  const counts = { all: 0, keys: 0, ids: [] };
  const request = (value) => {
    const result = {};
    setImmediate(() => { result.result = value; result.onsuccess?.(); });
    return result;
  };
  const cursor = (rows, keys = false) => {
    const result = {};
    let index = 0;
    const advance = () => setImmediate(() => {
      const row = rows[index++];
      result.result = row === undefined ? null : { ...(keys ? { key: row } : { value: row }), continue: advance };
      result.onsuccess?.();
    });
    advance();
    return result;
  };
  const store = {
    get: (id) => { counts.ids.push(id); return request(tasks.find((task) => task.id === id)); },
    getAll: () => { counts.all += 1; return request(tasks); },
    index: (name) => ({
      getAll: (value) => { counts.all += 1; return request(tasks.filter((task) => task[name] === value)); },
      openCursor: (value) => cursor(tasks.filter((task) => task[name] === value)),
      openKeyCursor: (_value, direction) => {
        assert.equal(name, "projectName");
        assert.equal(direction, "nextunique");
        counts.keys += 1;
        return cursor([...new Set(tasks.map((task) => task.projectName))], true);
      },
    }),
  };
  const database = { transaction: () => ({ objectStore: () => store }) };
  const ctx = vm.createContext({ Promise, Date, String, Number, Map, Set, IDBKeyRange: { only: (value) => value } });
  const source = readFileSync(new URL("../src/taskStore.js", import.meta.url), "utf8").replace(/^import [^\n]+\n/gm, "").replace(/export /g, "");
  vm.runInContext(source, ctx);
  ctx.databaseFixture = database;
  vm.runInContext("databasePromise = Promise.resolve(databaseFixture)", ctx);
  return { ctx, counts };
}

test("project names use unique index keys instead of cloning all task prompts", async () => {
  const { ctx, counts } = harness([{ id: "a", projectName: "项目B" }, { id: "b", projectName: "项目A" }, { id: "c", projectName: "项目A" }]);
  assert.deepEqual(Array.from(await ctx.projectNames()), ["项目A", "项目B"]);
  assert.equal(counts.all, 0);
  assert.equal(counts.keys, 1);
});

test("batch status reads only its unique tracked task IDs", async () => {
  const { ctx, counts } = harness([{ id: "a" }, { id: "b" }, { id: "history" }]);
  const result = await ctx.getTasksByIds(["b", "a", "b", "missing", ""]);
  assert.deepEqual(Array.from(result, (task) => task.id), ["b", "a"]);
  assert.deepEqual(counts.ids, ["b", "a", "missing"]);
  assert.equal(counts.all, 0);
});

test("batch recovery can read the current project without loading unrelated projects", async () => {
  const { ctx } = harness([{ id: "a", projectName: "当前" }, { id: "b", projectName: "其他" }]);
  assert.deepEqual(Array.from(await ctx.getProjectTasks("当前"), (task) => task.id), ["a"]);
});

test("pending and failed reads keep bounded candidates and preserve fair polling order", async () => {
  const tasks = Array.from({ length: 200 }, (_, index) => ({ id: `task-${index}`, status: index % 3 === 0 ? "failed" : index % 3 === 1 ? "queued" : "processing", nextPollAt: 200 - index, createdAtMs: index }));
  const { ctx, counts } = harness(tasks);
  const pending = await ctx.getPendingTasks(10);
  const expected = tasks.filter((task) => task.status !== "failed").sort((a, b) => a.nextPollAt - b.nextPollAt).slice(0, 10);
  assert.deepEqual(Array.from(pending, (task) => task.id), expected.map((task) => task.id));
  const failed = await ctx.getFailedTasks(5);
  assert.deepEqual(Array.from(failed, (task) => task.id), tasks.filter((task) => task.status === "failed").sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 5).map((task) => task.id));
  assert.equal(counts.all, 0, "polling must not retain every queued, processing and failed record");
});
