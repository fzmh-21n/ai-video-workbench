import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

import { imageDownloadFilename, imageTaskEntries } from "../src/imageBatch.js";

const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
const config = { adapter: "fmgo", baseUrl: "https://mock.invalid", apiKey: "mock-key", model: "mock-image" };
const fingerprint = (apiKey) => `mock-fingerprint:${apiKey}`;

function mockImageServer() {
  const records = [];
  const inputs = [];
  let handler;
  let sequence = 0;
  const context = vm.createContext({
    app: { post: (_url, _middleware, callback) => { handler = callback; } },
    upload: { array: () => () => {} },
    providerConfig: () => config,
    fileBytes: (file) => file.buffer,
    createImage: async (_config, input, files) => {
      inputs.push({ input, files });
      return { adapter: config.adapter, baseUrl: config.baseUrl, status: "queued" };
    },
    encodeJob: () => `mock-${++sequence}`,
    apiKeyFingerprint: fingerprint,
    safeNumber: (value, fallback, min, max) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
    },
    saveImageTaskRecord: (record) => records.push(record),
    cleanupFiles: () => {},
    httpError: (status, message) => Object.assign(new Error(message), { status }),
  });
  vm.runInContext(section('app.post("/api/image-tasks"', 'app.get("/api/image-tasks/:id"'), context);
  async function submit(body, files = []) {
    let result;
    await handler({ body, files }, {
      status: (status) => {
        assert.equal(status, 202);
        return { json: (body) => { result = body; } };
      },
    }, (error) => { throw error; });
    return result.tasks[0];
  }
  return { records, inputs, submit };
}

function recoverAfterRestart(records, recoveredConfig = config) {
  const context = vm.createContext({ apiKeyFingerprint: fingerprint, imageTaskJournalEntries: () => records });
  vm.runInContext(section("function recentImageTaskRecords", "function diagnosticEntries"), context);
  return JSON.parse(JSON.stringify(context.recentImageTaskRecords(recoveredConfig)));
}

test("recovers JSON image metadata after restart with independent prompts, ordered grouping and named downloads", async () => {
  const { records, inputs, submit } = mockImageServer();
  const first = await submit({ prompt: "固定内容\n\n白衣人物甲", title: "角色甲/成年", batchId: "json-batch", batchIndex: "1", sourcePromptId: "json-row-1" });
  const second = await submit({ prompt: "固定内容\n\n夜间庭院乙", title: "场景乙", batchId: "json-batch", batchIndex: "2", sourcePromptId: "json-row-2" });
  assert.equal(inputs[0].input.prompt, "固定内容\n\n白衣人物甲");
  assert.equal(inputs[1].input.prompt, "固定内容\n\n夜间庭院乙");
  assert.ok(inputs.every(({ files }) => files.length === 0));
  const recovered = recoverAfterRestart(records);
  for (const task of [first, second]) {
    const restored = recovered.find((entry) => entry.id === task.id);
    for (const key of ["title", "batchId", "batchIndex", "sourcePromptId", "sourceName", "sourceReferenceId", "prompt"]) {
      assert.equal(restored[key], task[key]);
    }
    assert.equal(restored.sourceName, null);
    assert.equal(restored.sourceReferenceId, null);
  }
  const entries = imageTaskEntries(recovered);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "json-batch");
  assert.deepEqual(entries[0].tasks.map((task) => task.id), [first.id, second.id]);
  assert.equal(imageDownloadFilename(entries[0].tasks[0], "image/webp"), "角色甲_成年.webp");
  assert.equal(imageDownloadFilename(entries[0].tasks[1], "image/png"), "场景乙.png");
});

test("keeps the legacy original-image reference and exact filename after journal recovery", async () => {
  const { records, inputs, submit } = mockImageServer();
  const file = { buffer: Buffer.from("mock image"), mimetype: "image/png", originalname: "原图甲.png" };
  const task = await submit({ prompt: "原图处理词", title: "原图甲.png", batchId: "original-batch", batchIndex: "1", sourceName: "原图甲.png", sourceReferenceId: "image-ref-1" }, [file]);
  assert.equal(inputs[0].files.length, 1);
  assert.equal(inputs[0].files[0], file);
  const [restored] = recoverAfterRestart(records);
  assert.equal(restored.id, task.id);
  assert.equal(restored.sourceName, "原图甲.png");
  assert.equal(restored.sourceReferenceId, "image-ref-1");
  assert.equal(restored.sourcePromptId, null);
  assert.equal(restored.batchId, "original-batch");
  assert.equal(imageDownloadFilename(restored, "image/webp"), "原图甲.png");
});

test("does not recover image journal records for another adapter, base URL or API key", async () => {
  const { records, submit } = mockImageServer();
  await submit({ prompt: "独立描述", title: "角色甲", sourcePromptId: "json-row-1" });
  assert.deepEqual(recoverAfterRestart(records, { ...config, adapter: "canseedream" }), []);
  assert.deepEqual(recoverAfterRestart(records, { ...config, baseUrl: "https://another-mock.invalid" }), []);
  assert.deepEqual(recoverAfterRestart(records, { ...config, apiKey: "another-mock-key" }), []);
  const [restored] = recoverAfterRestart(records);
  assert.equal(restored.title, "角色甲");
  assert.equal(restored.apiKeyFingerprint, undefined);
  assert.equal(restored.baseUrl, undefined);
  assert.equal(restored.adapter, undefined);
});
