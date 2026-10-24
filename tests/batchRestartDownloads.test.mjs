import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

import { batchSerializable, reconciledBatchTerminalState, removeBatchReferenceKind } from "../src/batchPrompts.js";
import { batchItemDownloadCandidates, createBatchTaskLookup, recoverBatchItemTaskIds } from "../src/taskDownload.js";
import { taskReuseSnapshot } from "../src/taskReuse.js";
import { reindexBatchReferences as reindex, reconcileBatchReferenceTags } from "../src/batchReferences.js";
import { internalizeProjectAliases, normalizeImageReferenceBindings } from "../src/projectReferences.js";

const source = readFileSync(new URL("../src/BatchPanel.jsx", import.meta.url), "utf8");
function extract(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `extract ${from} from the real batch component`);
  return source.slice(start, end);
}

function fixture() {
  return {
    id: "first", section: 1, sourceName: "第01集.txt", prompt: "本节原提示词", status: "generated",
    downloaded: true, downloadedCount: 1, taskIds: ["downloaded-task"],
    references: [
      { id: "project-image", kind: "image", source: "automatic", name: "角色.png", projectAssetKey: "image:角色.png", tag: "@Image1" },
      { id: "manual-audio", kind: "audio", source: "manual", name: "声音.mp3", tag: "@Audio1",
        file: new File(["do-not-copy-file-bytes"], "声音.mp3", { type: "audio/mpeg" }), preview: "data:audio/mpeg;base64,do-not-copy-preview" },
    ],
  };
}

function synchronize(items, stored) {
  const context = vm.createContext({ createBatchTaskLookup, recoverBatchItemTaskIds, batchItemDownloadCandidates, reconciledBatchTerminalState });
  vm.runInContext(extract("function withDownloadedFlags(", "function persistedState("), context);
  return context.withDownloadedFlags(items, stored);
}

test("batch persistence retains manual reference identity without copying File bytes or base64 previews", () => {
  const original = fixture();
  const serialized = JSON.stringify(batchSerializable([original]));
  const [restored] = JSON.parse(serialized);
  assert.deepEqual(restored.references.map((reference) => reference.name), ["角色.png", "声音.mp3"]);
  assert.equal(restored.references[1].source, "manual");
  assert.equal(restored.references[1].tag, "@Audio1");
  assert.ok(!serialized.includes("do-not-copy"));
  assert.ok(!serialized.includes("base64"));
  assert.ok(restored.references.every((reference) => !("file" in reference) && !("preview" in reference)));
  assert.ok(original.references[1].file instanceof File);
});

test("real serialize and restart synchronization preserve a mixed-reference section's downloaded state", () => {
  const original = fixture();
  const unrelated = { id: "second", section: 2, sourceName: "第01集.txt", prompt: "另一节", references: [], taskIds: [], status: "matched", downloaded: false, downloadedCount: 0, recoveryNote: "" };
  const stored = [{ id: "downloaded-task", status: "completed", downloadedAtMs: 123, batchId: "original-batch",
    batchTitle: "第01集", batchSection: 1, reuseSnapshot: taskReuseSnapshot(original) }];
  const restarted = JSON.parse(JSON.stringify(batchSerializable([original, unrelated])));
  const [first, second] = synchronize(restarted, stored);
  assert.equal(first.downloaded, true);
  assert.equal(first.downloadedCount, 1);
  assert.deepEqual([...first.taskIds], ["downloaded-task"]);
  assert.equal(stored[0].downloadedAtMs, 123);
  assert.equal(second, restarted[1], "an unrelated section remains untouched");
});

test("legacy lost-reference caches recover historical display from their exact downloaded task, not generation candidates", () => {
  const original = fixture();
  const legacy = { ...original, downloaded: false, downloadedCount: 0, references: original.references.slice(0, 1) };
  const stored = [{ id: "downloaded-task", status: "completed", downloadedAtMs: 123, batchId: "original-batch",
    batchTitle: "第01集", batchSection: 1, reuseSnapshot: taskReuseSnapshot(original) }];
  assert.equal(batchItemDownloadCandidates(legacy, stored).length, 0);
  const [restored] = synchronize([legacy], stored);
  assert.equal(restored.downloaded, true);
  assert.equal(restored.references, legacy.references, "history compatibility never invents missing assets");
  assert.equal(batchItemDownloadCandidates(restored, stored).length, 0, "generation identity guards remain strict");
  assert.equal(stored[0].downloadedAtMs, 123);
});

test("removing audio references after downloading preserves the exact task's historical download receipt on restart", () => {
  const original = { ...fixture(), prompt: "@Image1 看向门口，@Audio1 说话。" };
  const snapshot = taskReuseSnapshot(original);
  const item = removeBatchReferenceKind({
    ...original,
    references: snapshot.references.map((reference, index) => ({ ...reference, tag: original.references[index].tag })),
  }, "audio");
  const stored = [{ id: "downloaded-task", status: "completed", downloadedAtMs: 123, batchId: "original-batch",
    batchTitle: "第01集", batchSection: 1, reuseSnapshot: snapshot }];
  assert.equal(original.prompt.length - item.prompt.length, 5, "the real audio-removal action changes the saved prompt");
  assert.equal(item.references.some((reference) => reference.kind === "audio"), false);
  assert.equal(batchItemDownloadCandidates(item, stored).length, 0, "edited references and prompt remain ineligible as generation candidates");
  for (const downloaded of [true, false]) {
    const [restarted] = JSON.parse(JSON.stringify(batchSerializable([{ ...item, downloaded, downloadedCount: downloaded ? 1 : 0 }])));
    const [restored] = synchronize([restarted], stored);
    assert.equal(restored.status, "generated");
    assert.equal(restored.downloaded, true);
    assert.equal(restored.downloadedCount, 1);
    assert.deepEqual([...restored.taskIds], ["downloaded-task"]);
    assert.equal(restored.prompt, item.prompt);
    assert.equal(batchItemDownloadCandidates(restored, stored).length, 0, "download history never weakens regeneration identity guards");
  }
  assert.equal(stored[0].reuseSnapshot.prompt, original.prompt);
  assert.equal(stored[0].downloadedAtMs, 123);
});

test("same-task prompt draft edits retain the original task's download receipt", () => {
  const original = fixture();
  const task = { id: "downloaded-task", status: "completed", downloadedAtMs: 123, batchId: "original-batch",
    batchTitle: "第01集", batchSection: 1, reuseSnapshot: taskReuseSnapshot(original) };
  for (const prompt of ["新的完整提示词", " \n新的草稿🙂\n ", ""]) {
    const edited = { ...original, prompt, downloaded: false, downloadedCount: 0, references: original.references.slice(0, 1) };
    assert.equal(batchItemDownloadCandidates(edited, [task]).length, 0);
    const [restored] = synchronize([edited], [task]);
    assert.equal(restored.downloaded, true, `a draft edit does not erase task ${task.id}'s receipt`);
    assert.equal(restored.downloadedCount, 1);
    assert.equal(restored.prompt, prompt);
  }
  const editedWithoutSnapshot = { ...original, prompt: "后续草稿", downloaded: false, downloadedCount: 0 };
  const taskWithoutSnapshot = { ...task, reuseSnapshot: undefined, prompt: "历史已提交的原提示词" };
  assert.equal(batchItemDownloadCandidates(editedWithoutSnapshot, [taskWithoutSnapshot]).length, 0);
  const [withoutSnapshot] = synchronize([editedWithoutSnapshot], [taskWithoutSnapshot]);
  assert.equal(withoutSnapshot.downloaded, true, "an exact completed task's real receipt does not depend on a prompt snapshot");
});

test("historical display never inherits a download from another ID, source, section, status or unusable task", () => {
  const original = fixture();
  const legacy = { ...original, downloaded: false, downloadedCount: 0, references: original.references.slice(0, 1) };
  const task = { id: "downloaded-task", status: "completed", downloadedAtMs: 123, batchId: "original-batch",
    batchTitle: "第01集", batchSection: 1, reuseSnapshot: taskReuseSnapshot(original) };
  for (const [label, itemPatch, taskPatch] of [
    ["new ID", { taskIds: ["new-task"] }, {}],
    ["no explicit ID", { taskIds: [] }, {}],
    ["new source", { sourceName: "第02集.txt" }, {}],
    ["new section", { section: 2 }, {}],
    ["active row", { status: "generating" }, {}],
    ["failed task", {}, { status: "failed" }],
    ["unusable task", {}, { reviewStatus: "dissatisfied" }],
    ["no actual mark", {}, { downloadedAtMs: undefined }],
  ]) {
    assert.equal(synchronize([{ ...legacy, ...itemPatch }], [{ ...task, ...taskPatch }])[0].downloaded, false, label);
  }
  assert.equal(synchronize([legacy], [])[0].downloaded, false, "no original task record");
  const newTask = { ...task, id: "new-task", downloadedAtMs: undefined };
  assert.equal(synchronize([{ ...legacy, taskIds: [newTask.id] }], [task, newTask])[0].downloaded, false, "an unmarked new task cannot inherit the old task's receipt");
});

function submissionContext(adapter = "mock") {
  const requests = [];
  const notices = [];
  const context = vm.createContext({
    projectAssets: [], activeProfile: { id: "mock", adapter, name: "本地测试", model: "mock" },
    uploadedProfileId: "mock", uploaded: {}, reindex, reconcileBatchReferenceTags,
    internalizeProjectAliases, normalizeImageReferenceBindings, FormData, performance,
    parametersFor: () => ({ duration: 15, resolution: "720p", ratio: "16:9", quantity: 1 }),
    fixedContent: "", autoReference: false, headers: {}, submissionMode: "ordered_rush",
    uid: () => "local-mock", recordDiagnostic: () => {}, diagnosticHeaders: () => ({}),
    onNotice: (notice) => notices.push(notice), configuredUploadBatchSize: () => 1, retryableMaterialUploadStatus: () => false,
    setUploaded: () => {}, setUploadedProfileId: () => {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: false, status: 400, json: async () => ({ message: "Local mock stops before task creation" }) };
    },
  });
  vm.runInContext(extract("  function resolveFile(", "  function clearItemReferences("), context);
  vm.runInContext(extract("  async function preuploadItems(", "  async function preuploadAll("), context);
  vm.runInContext(extract("  async function submitOne(", "  async function submitSelected("), context);
  return { context, requests, notices };
}

test("a missing manual file blocks all preuploads, including a Huajing audio reference after a valid image", async () => {
  const { context, requests } = submissionContext("huajing");
  const item = { ...fixture(), references: [
    { kind: "image", source: "manual", name: "可用.png", file: new File(["image"], "可用.png") },
    { kind: "audio", source: "manual", name: "声音.mp3", id: "lost-audio" },
  ] };
  await assert.rejects(context.preuploadItems([item]), /声音\.mp3.*重新选择/);
  assert.equal(requests.length, 0, "no upload or generation request is sent");
});

test("direct regeneration refuses a missing manual file before creating any task", async () => {
  const { context, requests } = submissionContext();
  const [restored] = JSON.parse(JSON.stringify(batchSerializable([fixture()])));
  await assert.rejects(context.submitOne(restored, "batch", {}, 0, 0), /声音\.mp3.*重新选择/);
  assert.equal(requests.length, 0, "the task-creation callback is never reached");
  assert.equal(restored.downloaded, true);
  assert.deepEqual(restored.taskIds, ["downloaded-task"]);
});

test("an expired cached manual upload cannot bypass the missing-file check", async () => {
  const { context, requests } = submissionContext();
  const reference = { kind: "audio", source: "manual", name: "声音.mp3", id: "lost-audio" };
  const item = { ...fixture(), references: [reference] };
  const cache = { [context.uploadKey(item, reference)]: { url: "https://example.test/expired.mp3", expiresAt: Date.now() - 1 } };
  await assert.rejects(context.preuploadItems([item], true, cache), /声音\.mp3.*重新选择/);
  await assert.rejects(context.submitOne(item, "batch", cache, 0, 0), /声音\.mp3.*重新选择/);
  assert.equal(requests.length, 0);
});

test("a restored manual reference can use an unexpired cached URL without silently omitting it", async () => {
  const { context, requests } = submissionContext();
  const reference = { kind: "audio", source: "manual", name: "声音.mp3", id: "cached-audio" };
  const item = { ...fixture(), references: [reference] };
  const cache = { [context.uploadKey(item, reference)]: { url: "https://example.test/current.mp3", expiresAt: Date.now() + 60000 } };
  await context.preuploadItems([item], true, cache);
  assert.equal(requests.length, 0);
  await assert.rejects(context.submitOne(item, "batch", cache, 0, 0), /Local mock stops/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/tasks");
  assert.equal(JSON.parse(requests[0].options.body.get("referenceMeta"))[0].url, cache[context.uploadKey(item, reference)].url);
});

test("a restored manual HTTP reference is passed to task metadata instead of an empty file slot", async () => {
  const { context, requests } = submissionContext();
  const reference = { kind: "audio", source: "manual", name: "声音.mp3", id: "remote-audio", url: "https://example.test/audio.mp3" };
  const item = { ...fixture(), references: [reference] };
  await context.preuploadItems([item], true);
  await assert.rejects(context.submitOne(item, "batch", {}, 0, 0), /Local mock stops/);
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].options.body.get("referenceMeta"))[0].url, reference.url);
});

test("a manual reference restored from its exact project asset remains submit-ready", async () => {
  const { context, requests } = submissionContext();
  const file = new File(["restored audio bytes"], "声音.mp3");
  const reference = { kind: "audio", source: "manual", name: file.name, id: "project-audio", projectAssetKey: "audio:声音.mp3" };
  context.projectAssets = [{ key: reference.projectAssetKey, file }];
  await assert.rejects(context.submitOne({ ...fixture(), references: [reference] }, "batch", {}, 0, 0), /Local mock stops/);
  assert.equal(requests.length, 1);
  assert.equal(await requests[0].options.body.getAll("references")[0].text(), "restored audio bytes");
});

test("whole-batch preflight stops before uploading or generating any section when a later manual file is missing", async () => {
  const { context, requests, notices } = submissionContext();
  const first = { ...fixture(), references: [], status: "matched" };
  const second = { ...fixture(), id: "second", section: 2, status: "matched", references: [
    { id: "missing", source: "manual", kind: "audio", name: "第二节声音.mp3" },
  ] };
  let uploads = 0;
  let generations = 0;
  Object.assign(context, { apiKey: "local-mock", canBatchSubmit: () => true, canBatchResubmit: () => false,
    preuploadItems: async () => { uploads += 1; throw new Error("unexpected upload"); },
    submitOne: async () => { generations += 1; throw new Error("unexpected generation"); },
  });
  vm.runInContext(extract("  async function submitSelected(", "\n  useEffect(() => {"), context);
  await context.submitSelected([first, second]);
  assert.equal(uploads, 0);
  assert.equal(generations, 0);
  assert.equal(requests.length, 0);
  assert.match(notices[0], /第二节声音\.mp3.*重新选择/);
  assert.equal(first.status, "matched");
  assert.equal(second.status, "matched");
});
