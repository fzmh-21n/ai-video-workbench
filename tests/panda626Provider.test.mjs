import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

import { DEFAULT_PROFILES, capabilityFor, inferAdapter, migrateSavedProfile, pollDelayForAdapter, profilesWithBuiltIns, sdVersionForProfile } from "../src/providerCatalog.js";
import { PANDA626_BASE_URL, SEEDANCE_VIDEO_BASE_URL, seedanceVideoModels } from "../src/seedanceVideoCatalog.js";

test("adds an independent Panda626 profile using the existing Seedance video adapter", () => {
  const panda = DEFAULT_PROFILES.find((profile) => profile.id === "panda626");
  assert.deepEqual(panda, {
    id: "panda626", name: "Panda626", baseUrl: PANDA626_BASE_URL, adapter: "seedancevideo", model: "",
    mediaUploadUrl: `${PANDA626_BASE_URL}/v1/uploads/images`,
  });
  assert.equal(PANDA626_BASE_URL, "https://panda626.com");
  assert.equal(inferAdapter(PANDA626_BASE_URL), "seedancevideo");
  assert.equal(inferAdapter("https://www.panda626.com/v1"), "seedancevideo");
  const profiles = profilesWithBuiltIns([DEFAULT_PROFILES.find((profile) => profile.id === "seedancevideo")]);
  assert.ok(profiles.some((profile) => profile.id === "panda626"));
  assert.ok(profiles.some((profile) => profile.id === "seedancevideo"));
});

test("normalizes saved Panda626 profiles without rewriting them to the 772808 host", () => {
  for (const adapter of ["newapi", "seedancevideo"]) {
    const saved = { id: "my-panda", name: "我的 Panda626", baseUrl: "https://www.panda626.com/v1/", adapter, model: "supplier-model", mediaUploadUrl: "old-upload" };
    assert.deepEqual(migrateSavedProfile(saved), {
      ...saved, baseUrl: PANDA626_BASE_URL, adapter: "seedancevideo", mediaUploadUrl: `${PANDA626_BASE_URL}/v1/uploads/images`,
    });
  }
  const panda = DEFAULT_PROFILES.find((profile) => profile.id === "panda626");
  assert.deepEqual(migrateSavedProfile(panda), panda);
});

test("keeps the original 772808 profile and saved-profile migration unchanged", () => {
  const original = DEFAULT_PROFILES.find((profile) => profile.id === "seedancevideo");
  assert.equal(original.baseUrl, SEEDANCE_VIDEO_BASE_URL);
  assert.equal(original.mediaUploadUrl, `${SEEDANCE_VIDEO_BASE_URL}/v1/uploads/images`);
  assert.equal(inferAdapter(SEEDANCE_VIDEO_BASE_URL), "seedancevideo");
  assert.deepEqual(migrateSavedProfile({ ...original, baseUrl: "https://772808.xyz/v1/", adapter: "newapi" }), original);
});

test("reuses profile-local live model labels and generation specifications for Panda626", () => {
  const catalog = seedanceVideoModels({ data: [{
    id: "supplier-sd-2.5", name: "Panda SD2.5", billingMode: "per_second",
    resolutions: [{ value: "1080pp", label: "1080P", price: 0.18 }, { value: "4kpp", label: "4K", price: 0.35 }],
    durations: [5, 15, 30], supports_reference_video: false, supports_reference_audio: true,
  }] });
  const panda = {
    ...DEFAULT_PROFILES.find((profile) => profile.id === "panda626"), model: catalog.models[0],
    routeCapabilities: catalog.capabilities, routeLabels: catalog.labels,
  };
  const migrated = migrateSavedProfile(panda);
  const capability = capabilityFor(migrated);
  assert.equal(migrated.baseUrl, PANDA626_BASE_URL);
  assert.deepEqual(capability.resolutions, ["1080pp", "4kpp"]);
  assert.deepEqual(capability.durations, [5, 15, 30]);
  assert.deepEqual(capability.ratios, ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
  assert.equal(capability.videos, 0);
  assert.equal(capability.audios, 50);
  assert.equal(sdVersionForProfile(migrated), "sd25");
  assert.match(migrated.routeLabels[migrated.model], /1080P 0\.18积分\/秒/);
  assert.match(migrated.routeLabels[migrated.model], /4K 0\.35积分\/秒/);
  assert.match(migrated.routeLabels[migrated.model], /不支持视频参考/);
  const original = DEFAULT_PROFILES.find((profile) => profile.id === "seedancevideo");
  assert.deepEqual(capabilityFor(original).resolutions, []);
  assert.equal(original.routeLabels, undefined);
});

test("uses a 15-second polling interval for the shared Seedance video adapter", () => {
  assert.equal(pollDelayForAdapter("seedancevideo"), 15_000);
  assert.equal(pollDelayForAdapter("clmm"), 3_000);
  assert.equal(pollDelayForAdapter("meaicc"), 21_000);
  assert.equal(pollDelayForAdapter("huajing"), 5_000);
  assert.equal(pollDelayForAdapter("newapi"), 10_000);
});

test("uses server Retry-After for pending and rate-limited Panda626 polls without changing other adapters", async () => {
  const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const start = appSource.indexOf("const update = await (async () => { try {");
  assert.ok(start >= 0);
  const end = appSource.indexOf("})();", start);
  assert.ok(end > start);
  const pollingSource = `(async () => { ${appSource.slice(start, end + 5)} return update; })()`;
  for (const [adapter, status, retryAfterMs, expected] of [
    ["seedancevideo", 200, 40_000, 41_000],
    ["seedancevideo", 200, 1_000, 16_000],
    ["seedancevideo", 429, 45_000, 46_000],
    ["seedancevideo", 429, undefined, 16_000],
    ["newapi", 200, 40_000, 11_000],
    ["newapi", 429, 40_000, 11_000],
  ]) {
    const context = vm.createContext({
      profile: { adapter }, task: { id: "mock-task" }, nextPollAt: 11_000,
      AbortSignal,
      Date: { now: () => 1_000 }, pollDelayForAdapter,
      fetch: async () => ({ ok: status === 200, status, json: async () => ({ status: "pending", retryAfterMs }) }),
      headersFor: () => ({}), diagnosticHeaders: () => ({}), TRANSIENT_NETWORK_STATUSES: new Set([429]),
    });
    const update = await vm.runInContext(pollingSource, context);
    assert.equal(update.nextPollAt, expected, `${adapter} HTTP ${status}`);
    if (status === 429) assert.equal(update.transient, true);
  }
});
