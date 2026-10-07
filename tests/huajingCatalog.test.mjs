import assert from "node:assert/strict";
import test from "node:test";
import { HUAJING_BASE_URL, huajingCapability, huajingInputIssue, huajingPrompt, huajingTaskForm, huajingTaskResult, huajingCreateWithRecovery } from "../src/huajingCatalog.js";
import { DEFAULT_PROFILES, capabilityFor, inferAdapter, sdVersionForProfile, modelForSdVersion, pollDelayForAdapter } from "../src/providerCatalog.js";
import { configuredUploadBatchSize, requiresProviderAssetUpload } from "../src/uploadPolicy.js";
import { directTaskContentPaths } from "../src/taskContent.js";

const cap = {
  enabled: true, creditCost: 20, pricingRevision: "revision-1",
  inputs: { text: true, image: true, audio: true, video: true },
  durationSeconds: [5, 10, 15, 20, 25, 30], resolutions: ["720p"], ratios: ["16:9", "9:16"],
  limits: { images: { maxCount: 30, maxBytes: 100 }, audio: { maxCount: 10, totalDurationSeconds: 15 }, videos: { maxCount: 10 }, maxUploadBytes: 200, maxPromptBytes: 1000 },
};
const input = { prompt: "@Image1 小青在 @图片2 公园说话 @Audio1，镜头参考 @Video1", duration: 30, resolution: "720p", aspectRatio: "16:9",
  materials: [{ kind: "image", assetId: "a", bytes: 10 }, { kind: "image", assetId: "b", bytes: 10 },
    { kind: "audio", name: "voice.mp3", durationSeconds: 5, file: { buffer: Buffer.from("audio"), originalname: "voice.mp3", mimetype: "audio/mpeg" } },
    { kind: "video", name: "motion.mp4", file: { buffer: Buffer.from("video"), originalname: "motion.mp4", mimetype: "video/mp4" } }],
};

test("Huajing is a built-in SD2.5 provider with native uploads and live limits", () => {
  const profile = DEFAULT_PROFILES.find((item) => item.id === "huajing");
  assert.equal(profile.baseUrl, HUAJING_BASE_URL);
  assert.equal(inferAdapter(HUAJING_BASE_URL), "huajing");
  assert.equal(sdVersionForProfile(profile), "sd25");
  assert.equal(modelForSdVersion(profile, "sd25"), "dlseedance2.5");
  assert.equal(pollDelayForAdapter("huajing"), 5000);
  assert.equal(configuredUploadBatchSize("huajing"), 1);
  assert.equal(requiresProviderAssetUpload("huajing"), true);
  assert.deepEqual(directTaskContentPaths("huajing", "task1"), ["/v1/tasks/task1/video"]);
  assert.equal(capabilityFor({ ...profile, routeCapabilities: { [profile.model]: huajingCapability(cap) } }).images, 30);
  assert.equal(capabilityFor(profile).images, 0); // unknown capabilities must not invent a limit
});

test("native multipart uses library IDs, structured references, pricing guard and text before files", async () => {
  const form = huajingTaskForm("zhssseedance2.5-720p", input, cap, (file) => file.buffer);
  const entries = [...form.entries()];
  assert.equal(entries[0][0], "model");
  assert.deepEqual(entries.filter(([, value]) => typeof value !== "string").map(([key]) => key), ["audio", "videos"]);
  const firstFile = entries.findIndex(([, value]) => typeof value !== "string");
  assert.ok(entries.slice(firstFile).every(([, value]) => typeof value !== "string"));
  assert.equal(form.get("expectedPricingRevision"), "revision-1");
  assert.equal(form.get("expectedCreditCost"), "20");
  assert.deepEqual(JSON.parse(form.get("imageReferences")), [
    { id: "image1", assetId: "a", name: "Image-1" }, { id: "image2", assetId: "b", name: "Image-2" },
  ]);
  assert.deepEqual(JSON.parse(form.get("promptSegments")).filter((item) => item.type === "reference").map((item) => item.id), ["image1", "image2"]);
  assert.match(form.get("prompt"), /@Audio-1/);
  assert.equal(form.has("images"), false);
  assert.equal(form.has("image_urls"), false);
  assert.equal(await form.get("audio").text(), "audio");
});

test("Dola text-only form sends matching compatibility text and fixed duration", () => {
  const simpleCap = { ...cap, durationSeconds: [30], inputs: { text: true, image: true, audio: false, video: false } };
  const form = huajingTaskForm("dlseedance2.5", { ...input, prompt: "散步", materials: [] }, simpleCap);
  assert.equal(form.get("dola25TextImageContent"), "散步");
  assert.equal(form.get("durationSeconds"), "30");
  assert.match(huajingInputIssue(simpleCap, input), /audio/);
  assert.match(huajingInputIssue(simpleCap, { ...input, materials: [], duration: 15 }), /durationSeconds/);
});

test("native reference normalization preserves numbering and rejects missing inputs", () => {
  assert.equal(huajingPrompt("@image2 @Audio-1 @视频3"), "@Image-2 @Audio-1 @Video-3");
  assert.match(huajingInputIssue(cap, { ...input, prompt: "@Image3" }), /没有对应素材/);
  assert.throws(() => huajingTaskForm("model", { ...input, materials: input.materials.map((item) => item.kind === "image" ? { ...item, assetId: "a" } : item) }, cap, (file) => file.buffer), /不同/);
});

test("valid combinations, UTF-8 prompt size, total audio duration and material size are validated", () => {
  assert.match(huajingInputIssue({ ...cap, enabled: false }, input), /停用/);
  assert.match(huajingInputIssue({ ...cap, validCombinations: [{ durationSeconds: 5, resolution: "720p", ratio: "16:9" }] }, input), /组合/);
  assert.match(huajingInputIssue({ ...cap, limits: { ...cap.limits, maxPromptBytes: 5 } }, { ...input, prompt: "你好" }), /字节/);
  assert.match(huajingInputIssue(cap, { ...input, materials: [{ kind: "audio", durationSeconds: 16 }] }), /总时长/);
  assert.match(huajingInputIssue(cap, { ...input, materials: [{ kind: "image", sizeBytes: 101 }] }), /单文件/);
  assert.match(huajingInputIssue({ ...cap, limits: { ...cap.limits, audio: { maxCount: 10, formats: ["mp3"] } } }, { ...input, materials: [{ kind: "audio", name: "file", file: { mimetype: "audio/ogg" } }] }), /格式不支持/);
  assert.match(huajingInputIssue({ ...cap, limits: { ...cap.limits, maxUploadBytes: 10 } }, input), /总大小/);
});

test("completed downloads retain native authenticated path; interrupted is a terminal failure", () => {
  const result = huajingTaskResult({ ok: true, task: { id: "task1", status: "completed", result: { downloadUrl: "/v1/tasks/task1/video" } } }, HUAJING_BASE_URL);
  assert.equal(result.videoUrl, `${HUAJING_BASE_URL}/v1/tasks/task1/video`);
  assert.equal(huajingTaskResult({ ok: true, task: { id: "task1", status: "interrupted", error: "stopped" } }, HUAJING_BASE_URL).status, "failed");
  assert.equal(huajingTaskResult({ ok: true, task: { id: "task1", status: "generating", result: { downloadUrl: "/premature" } } }, HUAJING_BASE_URL).videoUrl, "");
});

test("lost creation response queries the same idempotency key without another POST", async () => {
  const requests = [];
  const task = await huajingCreateWithRecovery(async (route, options) => {
    requests.push([route, options]);
    if (options.method === "POST") throw new Error("timeout");
    return { ok: true, task: { id: "original-task", status: "queued" } };
  }, "stable-key", new FormData(), HUAJING_BASE_URL);
  assert.equal(task.id, "original-task");
  assert.deepEqual(requests.map(([route, options]) => [route, options.method]), [["/v1/tasks", "POST"], ["/v1/tasks/by-idempotency/stable-key", "GET"]]);
  assert.equal(requests[0][1].headers["Idempotency-Key"], "stable-key");
});

test("uncertain submissions are blocked from auto retry; definite rejection is not retried", async () => {
  await assert.rejects(huajingCreateWithRecovery(async () => { throw new Error("offline"); }, "saved-key", new FormData(), HUAJING_BASE_URL), (error) => error.submissionUnknown && error.message.includes("saved-key"));
  let calls = 0;
  await assert.rejects(huajingCreateWithRecovery(async () => { calls++; return { ok: false, error: "invalid_input" }; }, "key", new FormData(), HUAJING_BASE_URL), /invalid_input/);
  assert.equal(calls, 1);
});
