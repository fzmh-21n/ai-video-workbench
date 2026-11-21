import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { completedImagePromptIds } from "../src/imageJsonImport.js";

// Exercise the real handlers and persistence effect without a DOM or provider requests.
// Normalize source line endings so these regressions also run on Windows checkouts.
const source = readFileSync(new URL("../src/ImageWorkbench.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const JSON_KEY = "image-workbench-json-prompts-v1";
const TASKS_KEY = "image-workbench-tasks-v1";
const FIXED_KEY = "image-workbench-fixed-content-v1";
const rows = Array.from({ length: 81 }, (_, index) => ({ id: `row-${index}`, name: `角色${index + 1}`, prompt: "白衣人物", sourceFile: "示例.json" }));
const imageTask = { id: "generated", status: "completed", sourcePromptId: "row-0", title: "角色1", prompt: "统一风格\n\n白衣人物", imageUrl: "/generated-images/keep.png" };
const persistence = source.match(/useEffect\(\(\) => \{ (localStorage\.setItem\(JSON_PROMPTS_KEY, JSON\.stringify\(jsonPrompts\)\)); \}, \[jsonPrompts\]\);/)[1];

function harness({ confirm = true, tasks = [imageTask], submitting = false, importingJson = false, items = rows } = {}) {
  const stored = new Map([[JSON_KEY, JSON.stringify(items)], [TASKS_KEY, JSON.stringify(tasks)], [FIXED_KEY, "统一风格"], ["video-api-key:sample", "not-a-real-key"]]);
  const writes = [];
  let confirmations = 0;
  let changes = 0;
  const context = vm.createContext({
    jsonPrompts: structuredClone(items), tasks: structuredClone(tasks), submitting, importingJson,
    JSON_PROMPTS_KEY: JSON_KEY,
    localStorage: { setItem: (key, value) => { stored.set(key, value); writes.push(key); } },
    window: { confirm: (message) => { confirmations++; assert.match(message, /不删除已生成图片/); return confirm; } },
    setNotice: () => {},
    setJsonPrompts: (update) => { changes++; context.jsonPrompts = typeof update === "function" ? update(context.jsonPrompts) : update; },
    fetch: () => { throw new Error("Clearing must not call an API"); },
    setTasks: () => { throw new Error("Clearing must not mutate generated tasks"); },
    setFixedContent: () => { throw new Error("Clearing must not change fixed content"); },
  });
  context.jsonClearBlocked = vm.runInContext(source.match(/const jsonClearBlocked = (.*);/)[1], context);
  context.completedJsonIds = completedImagePromptIds(items, tasks, "统一风格");
  context.completedJsonCount = context.completedJsonIds.size;
  return {
    context, stored, writes,
    confirmations: () => confirmations,
    run(name = "clearAllJsonPrompts") {
      const definition = source.match(new RegExp(`  function ${name}\\(\\) \\{[\\s\\S]*?\\n  \\}`))[0];
      vm.runInContext(`${definition}\n${name}()`, context);
      if (changes) vm.runInContext(persistence, context);
    },
  };
}

test("81 unprocessed JSON imports have a distinct enabled clear-all button", async () => {
  const previousLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  let stored = new Map([["image-workbench-mode-v1", "json"], [JSON_KEY, JSON.stringify(rows)]]);
  const storage = { getItem: (key) => stored.get(key) ?? null };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: { getItem: () => null }, configurable: true });
  const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  try {
    const { default: ImageWorkbench } = await server.ssrLoadModule("/src/ImageWorkbench.jsx");
    const button = (html) => html.match(/<button[^>]*>清空全部（81）<\/button>/)[0];
    const render = () => renderToStaticMarkup(React.createElement(ImageWorkbench));
    let html = render();
    assert.doesNotMatch(button(html), /disabled/);
    assert.match(html, /<button[^>]*disabled[^>]*>清空已处理（0）/);
    for (const status of ["queued", "processing"]) {
      stored.set(TASKS_KEY, JSON.stringify([{ ...imageTask, status }]));
      assert.match(button(render()), /disabled/);
    }
    stored.set(TASKS_KEY, "[]");
    stored.set(JSON_KEY, "[]");
    assert.match(render(), /<button[^>]*disabled[^>]*>清空全部（0）/);
  } finally {
    await server.close();
    for (const [key, descriptor] of [["localStorage", previousLocal], ["sessionStorage", previousSession]]) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("confirmed clear-all removes only imported prompts and persists the empty list for refresh", () => {
  const h = harness();
  const original = new Map(h.stored);
  h.run();
  assert.equal(h.confirmations(), 1);
  assert.equal(h.context.jsonPrompts.length, 0);
  assert.deepEqual(JSON.parse(h.stored.get(JSON_KEY)), []);
  assert.deepEqual(h.writes, [JSON_KEY]);
  for (const [key, value] of original) if (key !== JSON_KEY) assert.equal(h.stored.get(key), value);
  assert.equal(h.context.tasks[0].imageUrl, "/generated-images/keep.png");
});

test("cancelling confirmation preserves every imported row and all persisted data", () => {
  const h = harness({ confirm: false });
  const original = [...h.stored];
  h.run();
  assert.equal(h.confirmations(), 1);
  assert.equal(h.context.jsonPrompts.length, 81);
  assert.deepEqual([...h.stored], original);
  assert.deepEqual(h.writes, []);
});

test("clear-all cannot cancel or remove queued/running work, imports, or submissions", () => {
  for (const options of [{ tasks: [{ ...imageTask, status: "queued" }] }, { tasks: [{ ...imageTask, status: "processing" }] }, { importingJson: true }, { submitting: true }]) {
    const h = harness(options);
    h.run();
    assert.equal(h.context.jsonPrompts.length, 81);
    assert.equal(h.confirmations(), 0);
    assert.deepEqual(h.writes, []);
  }
});

test("empty imports do not prompt or write storage", () => {
  const h = harness({ items: [] });
  h.run();
  assert.equal(h.confirmations(), 0);
  assert.deepEqual(h.writes, []);
});

test("existing processed-only clear still keeps unprocessed rows and generated assets", () => {
  const h = harness();
  h.run("clearCompletedJsonPrompts");
  assert.equal(h.confirmations(), 0);
  assert.equal(h.context.jsonPrompts.length, 80);
  assert.equal(h.context.jsonPrompts.some((row) => row.id === "row-0"), false);
  assert.equal(JSON.parse(h.stored.get(JSON_KEY)).length, 80);
  assert.equal(JSON.parse(h.stored.get(TASKS_KEY))[0].imageUrl, "/generated-images/keep.png");
  assert.deepEqual(h.writes, [JSON_KEY]);
});
