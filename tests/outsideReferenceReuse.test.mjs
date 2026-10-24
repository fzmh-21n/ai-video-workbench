import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { fileStem, imageReferenceIssues, internalizeProjectAliases, planProjectReferences } from "../src/projectReferences.js";
import { reusableAssetFor, taskReuseSnapshot } from "../src/taskReuse.js";

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const names = ["角色图_001_许小禾日常.png", "场景图_003_望春前厅.png", "角色图_002_许小禾样衣_v2.png"];
const prompt = `【出场人物】${names[0]}\n【出场场景】${names[1]}\n【场景环境】${names[2]}仅提取样衣，不增加图中人物。`;
const assets = names.map((name) => ({ key: `image:${name}`, kind: "image", name, stem: fileStem(name), file: new File([`fixture:${name}`], name, { type: "image/png" }) }));
const capability = { images: 9, audios: 3, videos: 3, resolutions: ["720p"], ratios: ["16:9"], durations: [15] };
const profile = { id: "local-mock", adapter: "lwaigc", name: "本地测试", model: "dbb-sd2.0-v2" };
const mockMessage = "Local mock stops before task creation";

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must come from the actual component`);
  return source.slice(start, end);
}

function context(projectAssets = assets) {
  const requests = [];
  const notices = [];
  let sequence = 0;
  const ctx = vm.createContext({
    projectAssets, prompt, references: [], referenceCounts: { image: 0, audio: 0, video: 0 },
    activeProfile: profile, profiles: [profile], capability, capabilityFor: () => capability,
    duration: 15, resolution: "720p", ratio: "16:9", seed: "", quantity: 1, syncAudio: true,
    autoReference: true, fixedContent: "", fileStem, imageReferenceIssues, internalizeProjectAliases,
    planProjectReferences, reusableAssetFor, taskReuseSnapshot, FormData, performance,
    MAX_TOTAL_BYTES: 200 * 1024 * 1024, REFERENCE_LIMITS: { image: 30, audio: 10, video: 10 },
    KIND_LABELS: { image: "图片", audio: "音频", video: "视频" },
    uid: (prefix) => `${prefix}-${++sequence}`, readMediaDuration: async () => null,
    keyFor: () => "local-mock-only", headersFor: () => ({}), diagnosticHeaders: () => ({}), recordDiagnostic: () => {},
    sdVersionForProfile: () => "sd20", fixedContentForProjectVersion: () => "", preferredDurationForVersion: () => 15,
    kindFromUrl: () => "image", withSyncAudioPreference: (current) => current,
    URL: { createObjectURL: () => "blob:local-fixture", revokeObjectURL: () => {} },
    window: { scrollTo: () => {}, confirm: () => true },
    setSubmitting: () => {}, setRegeneratingTaskId: () => {}, setActiveId: () => {}, setWorkMode: () => {},
    setDuration: () => {}, setResolution: () => {}, setRatio: () => {}, setSeed: () => {}, setQuantity: () => {},
    setSyncAudioPreferences: () => {}, setAutoReference: () => {},
    setNotice: (notice) => notices.push(notice),
    fetch: async (url, options) => {
      assert.equal(url, "/api/tasks", "only the in-memory task endpoint mock may be called");
      requests.push({ url, options });
      return { ok: false, status: 400, json: async () => ({ message: mockMessage }) };
    },
  });
  ctx.setReferences = (update) => {
    ctx.references = typeof update === "function" ? update(ctx.references) : update;
    ctx.referenceCounts = Object.fromEntries(["image", "audio", "video"].map((kind) => [kind, ctx.references.filter((item) => item.kind === kind).length]));
  };
  ctx.clearReferences = () => ctx.setReferences([]);
  ctx.setPrompt = (value) => { ctx.prompt = value; };
  ctx.setProfiles = (update) => { ctx.profiles = update(ctx.profiles); };
  for (const [start, end] of [
    ["function reindexReferences(", "function visibleReferenceTag("],
    ["  async function applyProjectReferencePlan(", "  async function runOneClickAudioReference("],
    ["  async function submitTask(", "  async function loadVideo("],
    ["  async function reuseFailedTask(", "  async function setTaskDissatisfied("],
    ["  async function regenerateTask(", "  async function downloadTaskCollection("],
  ]) vm.runInContext(extract(start, end), ctx);
  return { ctx, requests, notices };
}

function snapshot() {
  return taskReuseSnapshot({ prompt, references: assets.map((asset, index) => ({
    kind: asset.kind, name: asset.name, alias: asset.stem, projectAssetKey: asset.key,
    file: asset.file, url: `https://assets.example/${index}.png`, ...(index === 2 ? { noAutoMention: true } : {}),
  })), duration: 15, resolution: "720p", ratio: "16:9", seed: "", quantity: 1, syncAudio: true, autoReference: true });
}

function assertOutsideReferences(references) {
  assert.deepEqual(Array.from(references, (reference) => reference.name), names);
  assert.equal(references[2].noAutoMention, true);
  assert.ok(!references[0].noAutoMention && !references[1].noAutoMention);
  assert.deepEqual(Array.from(references, (reference) => reference.tag), ["@Image1", "@Image2", "@Image3"]);
}

function assertSubmission(requests, localFiles) {
  assert.equal(requests.length, 1);
  const form = requests[0].options.body;
  const metadata = JSON.parse(form.get("referenceMeta"));
  assertOutsideReferences(metadata);
  assert.equal(form.getAll("references").length, localFiles);
  assert.ok(form.get("prompt").includes(`${names[2]}仅提取样衣`));
  assert.ok(!form.get("prompt").includes(`@${fileStem(names[2])}`));
  return metadata;
}

test("real single matching reports and attaches outside images without adding their aliases to the prompt", async () => {
  const { ctx } = context();
  const plan = planProjectReferences(prompt, assets);
  const counts = await ctx.applyProjectReferencePlan(plan);
  assert.deepEqual({ ...counts }, { people: 1, background: 1, voice: 0, outside: 1 });
  assertOutsideReferences(ctx.references);
  assert.ok(ctx.prompt.includes(`${names[2]}仅提取样衣`));
  assert.ok(!ctx.prompt.includes(`@${fileStem(names[2])}`));
  await ctx.runOneClickReference();
  assertOutsideReferences(ctx.references);
});

test("real single matching clears the outside marker when the image becomes an explicit cast reference", async () => {
  const { ctx } = context();
  await ctx.applyProjectReferencePlan(planProjectReferences(prompt, assets));
  const explicit = `【出场人物】${names[0]}、${names[2]}\n【出场场景】${names[1]}`;
  await ctx.applyProjectReferencePlan(planProjectReferences(explicit, assets));
  assert.equal(ctx.references.length, 3);
  assert.equal(ctx.references.find((reference) => reference.name === names[2]).noAutoMention, false);
  assert.ok(ctx.prompt.includes(`@${fileStem(names[2])}=${names[2]}`));
});

test("reuse snapshots omit file bytes and preserve the marker through local and URL-only restore paths", async () => {
  const saved = snapshot();
  assert.equal(saved.references[2].noAutoMention, true);
  assert.ok(saved.references.every((reference) => !("file" in reference)));
  for (const projectAssets of [assets, []]) {
    const { ctx, requests } = context(projectAssets);
    await ctx.reuseFailedTask({ id: "failed-original", profileId: profile.id, model: profile.model, status: "failed", reuseSnapshot: saved });
    assertOutsideReferences(ctx.references);
    assert.equal(Boolean(ctx.references[2].file), projectAssets.length > 0);
    assert.equal(ctx.prompt, prompt);
    assert.equal(requests.length, 0, "restoring a task does not create or resend it");
    await ctx.submitTask();
    assertSubmission(requests, projectAssets.length ? 3 : 0);
  }
});

test("legacy failed-task restore without a snapshot also attaches and labels outside images", async () => {
  const { ctx, requests } = context();
  await ctx.reuseFailedTask({ id: "legacy-failed", profileId: profile.id, model: profile.model, status: "failed", prompt });
  assertOutsideReferences(ctx.references);
  assert.equal(requests.length, 0);
  assert.ok(ctx.prompt.includes(`${names[2]}仅提取样衣`));
});

test("real regeneration preserves the marker in metadata for snapshot-local, snapshot-URL and legacy restore paths", async () => {
  for (const mode of ["local", "url", "legacy"]) {
    const { ctx, requests, notices } = context(mode === "url" ? [] : assets);
    await ctx.regenerateTask({ id: `original-${mode}`, profileId: profile.id, model: profile.model,
      status: "completed", reviewStatus: "dissatisfied", prompt,
      ...(mode !== "legacy" ? { reuseSnapshot: snapshot() } : {}),
    });
    assertSubmission(requests, mode === "url" ? 0 : 3);
    assert.ok(notices.some((notice) => notice.includes(mockMessage)), "the local 400 stops before task creation");
  }
});

test("real single submit transmits the outside marker and all files while stopping at the local 400 response", async () => {
  const { ctx, requests, notices } = context();
  await ctx.applyProjectReferencePlan(planProjectReferences(prompt, assets));
  await ctx.submitTask();
  assertSubmission(requests, 3);
  assert.ok(notices.includes(mockMessage));
});
