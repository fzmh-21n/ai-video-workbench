import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROFILES,
  FALLBACK_MODELS,
  migrateSavedProfile,
  modelForSdVersion,
  preferredModelForSdVersion,
  profilesWithBuiltIns,
} from "../src/providerCatalog.js";

for (const adapter of ["lwaigc", "pidoi", "aiyrx", "globalaiopc"]) {
  test(`${adapter} preserves a newly selected model through save/restart migration`, () => {
    const builtIn = DEFAULT_PROFILES.find((profile) => profile.adapter === adapter);
    const newModel = "supplier/new-sd2.5-future";
    assert.ok(!FALLBACK_MODELS[adapter].includes(newModel));
    const saved = { ...builtIn, model: newModel, routeLabels: { [newModel]: "实时返回的新模型" } };
    const expectedEndpoints = migrateSavedProfile(builtIn);
    const migrated = migrateSavedProfile(JSON.parse(JSON.stringify(saved)));
    assert.equal(migrated.model, newModel);
    assert.equal(migrated.baseUrl, expectedEndpoints.baseUrl);
    assert.equal(migrated.mediaUploadUrl, expectedEndpoints.mediaUploadUrl);
    assert.deepEqual(migrated.routeLabels, saved.routeLabels);
    const restarted = profilesWithBuiltIns(JSON.parse(JSON.stringify([saved]))).find((profile) => profile.id === saved.id);
    assert.equal(restarted.model, newModel);
    assert.equal(migrateSavedProfile({ ...builtIn, model: "   " }).model, migrateSavedProfile({ ...builtIn, model: "" }).model);
    assert.ok(migrateSavedProfile({ ...builtIn, model: "" }).model);
  });
}

test("every adapter treats an explicit empty live catalog as no authorized model", () => {
  for (const profile of DEFAULT_PROFILES) {
    assert.equal(modelForSdVersion(profile, "sd20", []), "", profile.adapter);
    assert.equal(modelForSdVersion(profile, "sd25", []), "", profile.adapter);
  }
});

test("live catalogs select newly returned models even for formerly static adapters", () => {
  for (const adapter of ["lwaigc", "pidoi", "aiyrx", "globalaiopc", "paipu", "fmgo", "meaicc", "newapi"]) {
    const profile = { adapter, model: "old-sd2.0" };
    const models = ["supplier/new-sd2.0", "supplier/new-sd2.5"];
    assert.equal(modelForSdVersion(profile, "sd20", models), models[0], adapter);
    assert.equal(modelForSdVersion(profile, "sd25", models), models[1], adapter);
    assert.equal(modelForSdVersion({ ...profile, model: models[1] }, "sd25", models), models[1], adapter);
    assert.equal(modelForSdVersion({ ...profile, model: "removed-sd2.5" }, "sd25", models), models[1], adapter);
  }
});

test("a live catalog without the fixed preferred model never restores that preferred model", () => {
  for (const adapter of ["lwaigc", "paipu", "fmgo", "meaicc"]) {
    const preferred = preferredModelForSdVersion(adapter, "sd20");
    assert.ok(preferred);
    const profile = { adapter, model: "" };
    assert.equal(modelForSdVersion(profile, "sd20", ["new-sd2.0"]), "new-sd2.0", adapter);
    assert.equal(modelForSdVersion(profile, "sd25", ["new-sd2.0"]), "", adapter);
    assert.equal(modelForSdVersion(profile, "sd20"), preferred, adapter);
  }
});

test("live capabilities still determine the model version before a preferred model is selected", () => {
  const profile = { adapter: "canseedream", model: "", routeCapabilities: {
    kele_pool: { images: 30, videos: 10, audios: 10, durations: [30] },
    another_sd20: { images: 9, videos: 3, audios: 3, durations: [15] },
  } };
  assert.equal(modelForSdVersion(profile, "sd20", ["kele_pool", "another_sd20"]), "another_sd20");
  assert.equal(modelForSdVersion(profile, "sd25", ["kele_pool", "another_sd20"]), "kele_pool");
});
