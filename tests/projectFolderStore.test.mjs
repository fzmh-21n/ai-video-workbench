import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { filesFromProjectDirectory, projectDirectoryPermission } from "../src/projectFolderStore.js";

function directory(entries) {
  return { async *entries() { yield* entries; } };
}

function permissionClock() {
  const timers = new Map();
  let now = 0;
  let nextId = 0;
  const context = vm.createContext({
    setTimeout: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    DOMException,
  });
  vm.runInContext(readFileSync(new URL("../src/projectFolderStore.js", import.meta.url), "utf8").replace(/export /g, ""), context);
  return {
    permission: context.projectDirectoryPermission,
    timers,
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("recursively restores files from a remembered project directory", async () => {
  const image = { name: "person.png" };
  const audio = { name: "voice.wav" };
  const handle = directory([
    ["person.png", { kind: "file", getFile: async () => image }],
    ["audio", { kind: "directory", ...directory([
      ["voice.wav", { kind: "file", getFile: async () => audio }],
    ]) }],
  ]);
  assert.deepEqual(await filesFromProjectDirectory(handle), [
    { file: image, relativePath: "person.png" },
    { file: audio, relativePath: "audio/voice.wav" },
  ]);
});

test("permission diagnostics observe querying without requesting new permissions", async () => {
  const events = [];
  let requested = 0;
  const handle = { name: "SECRET_DIRECTORY", queryPermission: async () => "prompt", requestPermission: async () => { requested += 1; return "granted"; } };
  assert.equal(await projectDirectoryPermission(handle, false, (event) => events.push(event)), "prompt");
  assert.equal(requested, 0);
  assert.deepEqual(events.map((event) => event.stage), ["project_folder_permission_query_started", "project_folder_permission_query_completed"]);
  assert.equal(events.at(-1).permission, "prompt");
  assert.doesNotMatch(JSON.stringify(events), /SECRET_DIRECTORY|queryPermission|requestPermission/);
});

test("manual permission requests do not query first and survive diagnostic observer errors", async () => {
  const calls = [];
  const handle = { queryPermission: async () => { calls.push("query"); return "prompt"; }, requestPermission: async () => { calls.push("request"); return "granted"; } };
  const events = [];
  assert.equal(await projectDirectoryPermission(handle, true, (event) => { events.push(event.stage); throw new Error("observer failure"); }), "granted");
  assert.deepEqual(calls, ["request"]);
  assert.deepEqual(events, ["project_folder_permission_request_started", "project_folder_permission_request_completed"]);
});

test("a pending permission query only reports its start and remains pending", async () => {
  const events = [];
  let complete;
  let requested = 0;
  const handle = { queryPermission: () => new Promise((resolve) => { complete = resolve; }), requestPermission: async () => { requested += 1; return "granted"; } };
  let settled = false;
  const permission = projectDirectoryPermission(handle, false, (event) => events.push(event));
  permission.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.at(-1)?.stage, "project_folder_permission_query_started");
  assert.equal(settled, false);
  assert.equal(requested, 0);
  complete("granted");
  assert.equal(await permission, "granted");
});

test("scan diagnostics are bounded in progress and never include file names paths handles or content", async () => {
  const events = [];
  const entries = Array.from({ length: 51 }, (_, index) => [`SECRET_FILE_${index}.png`, { kind: "file", getFile: async () => ({ name: `SECRET_FILE_${index}.png`, content: "SECRET_CONTENT" }) }]);
  const handle = directory([["SECRET_DIRECTORY", { kind: "directory", ...directory(entries) }]]);
  const files = await filesFromProjectDirectory(handle, (event) => events.push(event));
  assert.equal(files.length, 51);
  assert.equal(events[0]?.stage, "project_folder_scan_started");
  assert.equal(events.filter((event) => event.stage === "project_folder_scan_file_started").length, 51);
  assert.equal(events.filter((event) => event.stage === "project_folder_scan_progress").length, 2);
  assert.equal(events.at(-1)?.stage, "project_folder_scan_completed");
  assert.equal(events.at(-1).fileCount, 51);
  assert.equal(events.at(-1).directoryCount >= 1, true);
  assert.doesNotMatch(JSON.stringify(events), /SECRET|relativePath|getFile|entries/);
});

test("a hanging getFile is diagnosed without cancelling skipping or reading file contents", async () => {
  const events = [];
  let complete;
  const file = { name: "SECRET_FILE.png" };
  const handle = directory([[file.name, { kind: "file", getFile: () => new Promise((resolve) => { complete = resolve; }) }]]);
  let settled = false;
  const scan = filesFromProjectDirectory(handle, (event) => events.push(event));
  scan.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.at(-1)?.stage, "project_folder_scan_file_started");
  assert.equal(settled, false);
  complete(file);
  assert.deepEqual(await scan, [{ file, relativePath: file.name }]);
});

test("folder enumeration remains unchanged when its diagnostic observer throws", async () => {
  const file = { name: "safe.png" };
  const handle = directory([[file.name, { kind: "file", getFile: async () => file }]]);
  assert.deepEqual(await filesFromProjectDirectory(handle, () => { throw new Error("observer failure"); }), [{ file, relativePath: file.name }]);
});

test("a hung automatic permission query times out at ten seconds without requesting permission", async () => {
  const clock = permissionClock();
  const events = [];
  let requested = 0;
  let result;
  const handle = { queryPermission: () => new Promise(() => {}), requestPermission: async () => { requested += 1; return "granted"; } };
  clock.permission(handle, false, (entry) => events.push(entry)).then(
    (permission) => { result = { permission }; },
    (error) => { result = { error }; },
  );
  clock.advance(9999);
  await settle();
  assert.equal(result, undefined);
  clock.advance(1);
  await settle();
  assert.equal(result?.error?.name, "TimeoutError");
  assert.equal(result.error.code, "PROJECT_FOLDER_PERMISSION_TIMEOUT");
  assert.equal(events.at(-1)?.stage, "project_folder_permission_query_timeout");
  assert.equal(requested, 0);
  assert.equal(clock.timers.size, 0);
});

test("permission results arriving after timeout cannot publish completion or restart recovery", async () => {
  for (const rejectLate of [false, true]) {
    const clock = permissionClock();
    const events = [];
    let resolveQuery;
    let rejectQuery;
    let failure;
    const handle = { queryPermission: () => new Promise((resolve, reject) => { resolveQuery = resolve; rejectQuery = reject; }) };
    clock.permission(handle, false, (entry) => events.push(entry)).catch((error) => { failure = error; });
    clock.advance(10_000);
    await settle();
    assert.equal(failure?.name, "TimeoutError");
    const eventCount = events.length;
    if (rejectLate) rejectQuery(new Error("late query error"));
    else resolveQuery("granted");
    await settle();
    assert.equal(events.length, eventCount);
    assert.equal(events.some((entry) => entry.stage === "project_folder_permission_query_completed"), false);
    assert.equal(clock.timers.size, 0);
  }
});

test("a prompt permission result clears its timeout before later ticks", async () => {
  const clock = permissionClock();
  const events = [];
  assert.equal(await clock.permission({ queryPermission: async () => "prompt" }, false, (entry) => events.push(entry)), "prompt");
  assert.equal(clock.timers.size, 0);
  clock.advance(20_000);
  assert.equal(events.some((entry) => entry.stage === "project_folder_permission_query_timeout"), false);
});

test("manual permission restoration calls request immediately and does not time out the user's prompt", async () => {
  const clock = permissionClock();
  const calls = [];
  const events = [];
  let grant;
  let result;
  const handle = {
    queryPermission: () => { calls.push("query"); return new Promise(() => {}); },
    requestPermission: () => { calls.push("request"); return new Promise((resolve) => { grant = resolve; }); },
  };
  const permission = clock.permission(handle, true, (entry) => events.push(entry));
  permission.then((value) => { result = value; });
  assert.deepEqual(calls, ["request"]);
  clock.advance(60_000);
  await settle();
  assert.equal(result, undefined);
  assert.equal(clock.timers.size, 0);
  grant("granted");
  assert.equal(await permission, "granted");
  assert.deepEqual(events.map((entry) => entry.stage), ["project_folder_permission_request_started", "project_folder_permission_request_completed"]);
});

test("a rejected permission query preserves its error and clears the timeout", async () => {
  for (const synchronousFailure of [false, true]) {
    const clock = permissionClock();
    const events = [];
    const failure = Object.assign(new Error("permission query unavailable"), { name: "NotAllowedError" });
    const handle = { queryPermission: () => { if (synchronousFailure) throw failure; return Promise.reject(failure); } };
    await assert.rejects(clock.permission(handle, false, (entry) => events.push(entry)), (error) => error === failure);
    assert.equal(clock.timers.size, 0);
    clock.advance(20_000);
    assert.equal(events.some((entry) => entry.stage === "project_folder_permission_query_timeout"), false);
  }
});
