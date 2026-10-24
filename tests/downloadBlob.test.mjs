import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function fixture(clickFails = false) {
  const source = readFileSync(new URL("../src/downloadBlob.js", import.meta.url), "utf8").replace("export async function", "async function");
  const events = [];
  const activeUrls = new Set();
  let sequence = 0, maximumActive = 0;
  const context = vm.createContext({ Promise,
    URL: {
      createObjectURL: () => { const url = `blob:mock-${++sequence}`; activeUrls.add(url); maximumActive = Math.max(maximumActive, activeUrls.size); return url; },
      revokeObjectURL: (url) => { events.push("revoke"); activeUrls.delete(url); },
    },
    document: { body: { appendChild: () => events.push("append") }, createElement: () => ({
      click: () => { events.push("click"); if (clickFails) throw new Error("download blocked"); },
      remove: () => events.push("remove"),
    }) },
    window: { setTimeout: (callback, delay) => { assert.equal(delay, 1000); events.push("handoff"); queueMicrotask(callback); } },
  });
  vm.runInContext(source, context);
  return { context, events, activeUrls, maximum: () => maximumActive };
}

test("serial bulk downloads release each blob before the next file begins", async () => {
  const { context, events, activeUrls, maximum } = fixture();
  for (let index = 0; index < 200; index += 1) await context.downloadBlob({}, `${index}.mp4`);
  assert.equal(maximum(), 1);
  assert.equal(activeUrls.size, 0);
  assert.deepEqual(events.slice(0, 5), ["append", "click", "handoff", "remove", "revoke"]);
});

test("a failed browser download releases the blob and reports failure", async () => {
  const { context, activeUrls } = fixture(true);
  await assert.rejects(context.downloadBlob({}, "failed.mp4"), /download blocked/);
  assert.equal(activeUrls.size, 0);
});

test("bulk download awaits blob handoff instead of retaining all videos for a minute", () => {
  const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("  async function downloadTaskCollection("), source.indexOf("  async function downloadBatch("));
  assert.ok(handler.includes("await downloadBlob("));
  assert.ok(!handler.includes("60_000"));
});
