import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const projectKey = (name) => `task-project:${JSON.stringify(name)}`;
const handle = (token) => ({ name: "同名素材文件夹", token, removeEntry() { throw new Error("不能删除真实目录"); } });

function harness(initial = [], { failAt = 0, synchronousFailure = false } = {}) {
  let values = new Map(initial);
  const stats = { operations: [], commits: 0, aborts: 0, closes: 0 };
  const db = {
    close() { stats.closes += 1; },
    transaction(_name, mode) {
      const draft = new Map(values);
      let pending = 0;
      let closed = false;
      const transaction = {
        objectStore: () => store,
        abort() {
          if (closed) return;
          closed = true;
          stats.aborts += 1;
          setImmediate(() => transaction.onabort?.());
        },
      };
      function request(type, key, operation) {
        stats.operations.push([type, key]);
        const error = stats.operations.length === failAt ? new Error("模拟文件夹绑定数据库错误") : null;
        if (error && synchronousFailure) throw error;
        const result = {};
        pending += 1;
        setImmediate(() => {
          if (closed) return;
          if (error) {
            transaction.error = result.error = error;
            result.onerror?.();
            transaction.onerror?.();
            transaction.abort();
            return;
          }
          result.result = operation();
          result.onsuccess?.();
          pending -= 1;
          if (!pending) setImmediate(() => {
            if (closed || pending) return;
            closed = true;
            if (mode === "readwrite") values = draft;
            stats.commits += 1;
            transaction.oncomplete?.();
          });
        });
        return result;
      }
      const store = {
        get: (key) => request("get", key, () => draft.get(key)),
        put: (value, key) => request("put", key, () => { draft.set(key, value); return key; }),
        delete: (key) => request("delete", key, () => draft.delete(key)),
      };
      return transaction;
    },
  };
  const indexedDB = {
    open() {
      const request = {};
      setImmediate(() => { request.result = db; request.onsuccess?.(); });
      return request;
    },
  };
  const context = vm.createContext({ indexedDB, Promise, String, Error, JSON });
  vm.runInContext(readFileSync(new URL("../src/projectFolderStore.js", import.meta.url), "utf8").replace(/export /g, ""), context);
  return { context, stats, snapshot: () => new Map(values) };
}

test("legacy save and load APIs keep their old key but wait for transaction completion", async () => {
  const folder = handle("legacy");
  const { context, stats } = harness();
  await context.saveProjectDirectory(folder);
  assert.equal(stats.commits, 1);
  assert.equal(stats.closes, 1);
  assert.equal(await context.loadProjectDirectory(), folder);
});

test("same-named directory handles remain bound to separate task projects across reloads", async () => {
  const first = handle("first");
  const second = handle("second");
  const { context, snapshot } = harness();
  await context.saveTaskProjectDirectory("项目A", first);
  await context.saveTaskProjectDirectory("项目B", second);
  assert.equal(await context.loadTaskProjectDirectory("项目A"), first);
  assert.equal(await context.loadTaskProjectDirectory("项目B"), second);
  assert.equal(await context.loadTaskProjectDirectory("新项目"), null);
  const reloaded = harness([...snapshot()]);
  assert.equal(await reloaded.context.loadTaskProjectDirectory("项目A"), first);
  assert.equal(await reloaded.context.loadTaskProjectDirectory("项目B"), second);
  assert.equal(await reloaded.context.loadTaskProjectDirectory("新项目"), null);
});

test("legacy directory migrates only when explicitly allowed and cannot be inherited by a later new project", async () => {
  const legacy = handle("legacy");
  const { context, snapshot } = harness([["current-project", legacy]]);
  assert.equal(await context.loadTaskProjectDirectory("项目A"), null);
  assert.equal(snapshot().get("current-project"), legacy);
  assert.equal(await context.loadTaskProjectDirectory("项目A", { migrateLegacy: true }), legacy);
  assert.equal(snapshot().has("current-project"), false);
  assert.equal(snapshot().get(projectKey("项目A")), legacy);
  assert.equal(await context.loadTaskProjectDirectory("项目B", { migrateLegacy: true }), null);
  assert.equal(await context.loadTaskProjectDirectory("项目A"), legacy);
});

test("an existing current-project binding takes priority and consumes any leftover legacy key", async () => {
  const existing = handle("existing");
  const legacy = handle("legacy");
  const { context, snapshot } = harness([[projectKey("项目A"), existing], ["current-project", legacy]]);
  assert.equal(await context.loadTaskProjectDirectory("项目A", { migrateLegacy: true }), existing);
  assert.equal(snapshot().has("current-project"), false);
  assert.equal(await context.loadTaskProjectDirectory("项目B", { migrateLegacy: true }), null);
});

test("project rename atomically moves the same directory handle and leaves all other bindings alone", async () => {
  const folder = handle("renamed");
  const other = handle("other");
  const { context, snapshot } = harness([[projectKey("旧项目"), folder], [projectKey("其他项目"), other]]);
  assert.equal(await context.renameTaskProjectDirectory("旧项目", "新项目"), true);
  assert.equal(snapshot().has(projectKey("旧项目")), false);
  assert.equal(await context.loadTaskProjectDirectory("新项目"), folder);
  assert.equal(await context.loadTaskProjectDirectory("其他项目"), other);
});

test("rename refuses to overwrite an existing target but a missing source and identical names are harmless", async () => {
  const oldFolder = handle("old");
  const targetFolder = handle("target");
  const initial = [[projectKey("旧项目"), oldFolder], [projectKey("目标项目"), targetFolder]];
  const { context, snapshot } = harness(initial);
  await assert.rejects(context.renameTaskProjectDirectory("旧项目", "目标项目"), /已|绑定|覆盖/);
  assert.deepEqual([...snapshot()], initial);
  assert.equal(await context.renameTaskProjectDirectory("不存在的项目", "目标项目"), false);
  assert.equal(await context.renameTaskProjectDirectory("旧项目", "旧项目"), false);
  assert.deepEqual([...snapshot()], initial);
});

test("removing a project binding deletes only that key and never touches real directory contents", async () => {
  const first = handle("first");
  const second = handle("second");
  const { context, snapshot } = harness([[projectKey("项目A"), first], [projectKey("项目B"), second]]);
  await context.removeTaskProjectDirectory("项目A");
  assert.equal(snapshot().has(projectKey("项目A")), false);
  assert.equal(await context.loadTaskProjectDirectory("项目B"), second);
});

test("sync and async save failures reject without leaving a partial binding", async () => {
  for (const synchronousFailure of [false, true]) {
    const { context, snapshot, stats } = harness([], { failAt: 1, synchronousFailure });
    await assert.rejects(context.saveTaskProjectDirectory("项目A", handle("save")), /模拟文件夹绑定数据库错误/);
    assert.equal(snapshot().size, 0);
    assert.equal(stats.commits, 0);
    assert.equal(stats.aborts, 1);
  }
});

test("sync and async migration delete failures roll back both the destination write and legacy deletion", async () => {
  for (const synchronousFailure of [false, true]) {
    const legacy = handle("legacy");
    const initial = [["current-project", legacy]];
    const { context, snapshot, stats } = harness(initial, { failAt: 4, synchronousFailure });
    await assert.rejects(context.loadTaskProjectDirectory("项目A", { migrateLegacy: true }), /模拟文件夹绑定数据库错误/);
    assert.deepEqual([...snapshot()], initial);
    assert.equal(stats.commits, 0);
    assert.equal(stats.aborts, 1);
  }
});

test("sync and async rename delete failures roll back the copied handle and preserve the original binding", async () => {
  for (const synchronousFailure of [false, true]) {
    const initial = [[projectKey("旧项目"), handle("old")]];
    const { context, snapshot, stats } = harness(initial, { failAt: 4, synchronousFailure });
    await assert.rejects(context.renameTaskProjectDirectory("旧项目", "新项目"), /模拟文件夹绑定数据库错误/);
    assert.deepEqual([...snapshot()], initial);
    assert.equal(stats.commits, 0);
    assert.equal(stats.aborts, 1);
  }
});

test("empty project names are rejected instead of silently sharing a global binding", async () => {
  const { context, stats } = harness();
  await assert.rejects(context.saveTaskProjectDirectory("  ", handle("blank")), /名称/);
  await assert.rejects(context.loadTaskProjectDirectory(""), /名称/);
  await assert.rejects(context.renameTaskProjectDirectory("旧项目", ""), /名称/);
  await assert.rejects(context.removeTaskProjectDirectory(""), /名称/);
  assert.equal(stats.operations.length, 0);
});

test("system projects can hold their own binding but cannot participate in project renames", async () => {
  const folder = handle("unclassified");
  const { context } = harness();
  await context.saveTaskProjectDirectory("未归类", folder);
  assert.equal(await context.loadTaskProjectDirectory("未归类"), folder);
  for (const [previous, next] of [["未归类", "新项目"], ["旧项目", "未归类"], ["all", "新项目"], ["旧项目", "all"]]) {
    await assert.rejects(context.renameTaskProjectDirectory(previous, next), /系统项目/);
  }
});

test("failed reads and failed binding removal reject without changing stored handles", async () => {
  for (const synchronousFailure of [false, true]) {
    const initial = [[projectKey("项目A"), handle("unchanged")]];
    for (const operation of ["loadTaskProjectDirectory", "removeTaskProjectDirectory"]) {
      const { context, snapshot, stats } = harness(initial, { failAt: 1, synchronousFailure });
      await assert.rejects(context[operation]("项目A"), /模拟文件夹绑定数据库错误/);
      assert.deepEqual([...snapshot()], initial);
      assert.equal(stats.commits, 0);
      assert.equal(stats.aborts, 1);
    }
  }
});
