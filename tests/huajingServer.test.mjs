import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { huajingCapability, huajingInputIssue, huajingTaskForm, huajingTaskResult, huajingCreateWithRecovery } from "../src/huajingCatalog.js";

const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
const capabilities = { enabled: true, inputs: { image: true, audio: true, video: true }, limits: { images: { maxCount: 30 }, audio: { maxCount: 10 }, videos: { maxCount: 10 } }, durationSeconds: [30], resolutions: ["720p"], ratios: ["16:9"], creditCost: 20, pricingRevision: "r1" };

test("server native flow uploads images to library, reuses ID, submits files, unwraps polling and keeps authenticated download path", async () => {
  const calls = [];
  const journal = [];
  const context = vm.createContext({
    FormData, Blob, Buffer, URL, Number, String, Date, Promise, Map,
    huajingCapability, huajingInputIssue, huajingTaskForm, huajingTaskResult, huajingCreateWithRecovery,
    crypto: { randomUUID: () => "test-unique" }, path: { join: (...parts) => parts.join("/") }, dataDir: "mock-data",
    appendFileSync: (_path, record) => journal.push(JSON.parse(record)),
    apiKeyFingerprint: () => "key-fingerprint", authHeaders: (config, extra) => ({ Authorization: `Bearer ${config.apiKey}`, ...extra }),
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    fileBytes: (file) => file.buffer, readJson: async (response) => response,
    upstream: async (url, options = {}) => {
      calls.push([url, options]);
      assert.equal(options.headers.Authorization, "Bearer mock-secret");
      if (url.includes("/v1/library?")) return { ok: true, folders: [] };
      if (url.endsWith("/v1/library/folders")) return { ok: true, id: "folder1" };
      if (url.endsWith("/v1/library/assets")) return { ok: true, asset: { id: "image-asset" } };
      if (url.includes("/v1/capabilities?")) return { ok: true, capabilities };
      if (url.endsWith("/v1/tasks")) {
        assert.equal(journal.length, 1); // persisted BEFORE creation
        return { ok: true, task: { id: "task-123", status: "queued" } };
      }
      if (url.endsWith("/v1/tasks/task-123")) return { ok: true, task: { id: "task-123", status: "completed", result: { downloadUrl: "/v1/tasks/task-123/video" } } };
      throw new Error(`Unexpected request: ${url}`);
    },
    normalizeStatus: (value) => value, normalizedTaskProgress: (status, progress) => status === "completed" ? 100 : progress,
    completedVideoUrls: new Map(),
  });
  vm.runInContext(section("const huajingFolderPromises", "async function uploadMedia") +
    section("async function createHuajingVideo", "async function createVideo") +
    section("async function pollJob", "function streamResponse"), context);
  const config = { adapter: "huajing", baseUrl: "https://video.huajings.online", apiKey: "mock-secret", model: "zhssseedance2.5-720p" };
  const image = await context.uploadHuajingMaterial(config, { buffer: Buffer.from("image"), originalname: "image.png", mimetype: "image/png" }, { kind: "image" });
  assert.equal(image.assetId, "image-asset");
  assert.equal(image.url, "");
  const assetRequest = calls.find(([url]) => url.endsWith("/v1/library/assets"))[1];
  assert.equal(assetRequest.body.get("folderId"), "folder1");
  assert.ok(assetRequest.body.get("image"));
  const audio = await context.uploadHuajingMaterial(config, { buffer: Buffer.from("voice"), originalname: "voice.mp3", mimetype: "audio/mpeg" }, { kind: "audio" });
  assert.equal(calls.length, 3); // audio never sent to a temporary host or library
  const job = await context.createHuajingVideo(config, { prompt: "@Image1说话 @Audio1", duration: 30, resolution: "720p", aspectRatio: "16:9", materials: [{ kind: "image", ...image }, { kind: "audio", ...audio }] });
  assert.equal(job.taskId, "task-123");
  assert.equal(job.statusPath, "/v1/tasks/task-123");
  assert.equal(job.contentPath, "/v1/tasks/task-123/video");
  assert.equal(journal[1].taskId, "task-123");
  assert.ok(journal.every((record) => !JSON.stringify(record).includes("mock-secret")));
  const submission = calls.find(([url]) => url.endsWith("/v1/tasks"))[1];
  assert.equal(submission.headers["Idempotency-Key"], "huajing_test-unique");
  assert.ok(submission.body.get("audio"));
  assert.equal(JSON.parse(submission.body.get("imageReferences"))[0].assetId, "image-asset");
  const result = await context.pollJob(config, job);
  assert.equal(result.status, "completed");
  assert.equal(result.progress, 100);
  assert.equal(result.videoUrl, "https://video.huajings.online/v1/tasks/task-123/video");
});
