import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { batchSerializable } from "../src/batchPrompts.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
const marker = source.indexOf("localStorage.setItem(STORAGE_KEY");
const start = source.lastIndexOf("  useEffect(", marker);
const effect = source.slice(start, source.indexOf("  useEffect(", marker));

function save(setItem) {
  const notices = [];
  const items = [{ id: "row", prompt: "原提示词", status: "generating", taskIds: ["original-id"], references: [] }];
  const context = vm.createContext({ JSON, STORAGE_KEY: "batch", items, batchSerializable,
    sourceName: "第1集.txt", concurrency: 3, submissionMode: "ordered", uploaded: {}, uploadedProfileId: "relay",
    useEffect: (callback) => callback(), localStorage: { setItem }, onNotice: (value) => notices.push(value) });
  vm.runInContext(effect, context);
  return { items, notices };
}

test("full browser storage does not crash the batch page or erase active task IDs", () => {
  const result = save(() => { throw Object.assign(new Error("storage is full"), { name: "QuotaExceededError" }); });
  assert.deepEqual(result.items[0].taskIds, ["original-id"]);
  assert.equal(result.items[0].status, "generating");
  assert.match(result.notices[0], /无法保存.*暂勿刷新/);
});

test("successful persistence retains the original format and every row", () => {
  let saved;
  const result = save((key, value) => { assert.equal(key, "batch"); saved = JSON.parse(value); });
  assert.equal(saved.items[0].prompt, "原提示词");
  assert.deepEqual(saved.items[0].taskIds, ["original-id"]);
  assert.equal(result.notices.length, 0);
});
