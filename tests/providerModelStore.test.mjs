import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_MODEL_CATALOGS_KEY,
  modelCatalogMatches,
  modelKeyFingerprint,
  normalizeModelNames,
  readModelCatalogs,
  removeModelCatalog,
  restoreModelCatalogs,
  saveModelCatalog,
} from "../src/providerModelStore.js";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

const profile = { id: "lwaigc", baseUrl: "https://ai.lwaigc.cn/v1/", adapter: "lwaigc" };

test("live model names preserve unknown IDs and explicit empty lists never add static models", () => {
  const fallback = ["old-model"];
  assert.deepEqual(normalizeModelNames({ models: [" new/SD2.5-v99 ", { id: "OtherNewModel" }, { name: "模型 名称" }, "new/SD2.5-v99", null, 12] }, fallback), ["new/SD2.5-v99", "OtherNewModel", "模型 名称"]);
  assert.deepEqual(normalizeModelNames({ data: [{ id: "MixedCase" }, "another"] }), ["MixedCase", "another"]);
  assert.deepEqual(normalizeModelNames(["direct-model"]), ["direct-model"]);
  assert.deepEqual(normalizeModelNames({ models: [] }, fallback), []);
  assert.deepEqual(normalizeModelNames({ data: [] }, fallback), []);
  assert.deepEqual(normalizeModelNames([], fallback), []);
  assert.deepEqual(normalizeModelNames({}, fallback), fallback);
});

test("Key fingerprint uses SHA-256 and normalizes pasted API credentials", async () => {
  assert.equal(await modelKeyFingerprint("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await modelKeyFingerprint(' Bearer "abc" '), await modelKeyFingerprint("abc"));
  assert.notEqual(await modelKeyFingerprint("abc"), await modelKeyFingerprint("another-key"));
});

test("saved catalog reloads only for the same provider and current Key without storing the Key", async () => {
  const storage = new MemoryStorage();
  const key = "private_mock_key_12345";
  const fingerprint = await modelKeyFingerprint(key);
  const payload = { models: ["brand-new-model"], capabilities: { "brand-new-model": { images: 30 } }, labels: { "brand-new-model": "新模型" } };
  const entry = saveModelCatalog(profile, fingerprint, payload, storage);
  assert.equal(entry.baseUrl, "https://ai.lwaigc.cn");
  assert.equal(entry.source, "live");
  assert.ok(entry.fetchedAt > 0);
  const reloadedStorage = new MemoryStorage();
  reloadedStorage.setItem(PROVIDER_MODEL_CATALOGS_KEY, storage.getItem(PROVIDER_MODEL_CATALOGS_KEY));
  const restored = await restoreModelCatalogs([profile], () => key, reloadedStorage);
  assert.deepEqual(restored[profile.id], entry);
  assert.deepEqual(restored[profile.id].capabilities, payload.capabilities);
  assert.ok(!storage.getItem(PROVIDER_MODEL_CATALOGS_KEY).includes(key));
  assert.equal(modelCatalogMatches(entry, profile, fingerprint), true);
  assert.equal(modelCatalogMatches(entry, { ...profile, baseUrl: "https://another.example" }, fingerprint), false);
  assert.equal(modelCatalogMatches(entry, { ...profile, adapter: "newapi" }, fingerprint), false);
  assert.equal(modelCatalogMatches(entry, profile, "different-fingerprint"), false);
  assert.deepEqual(await restoreModelCatalogs([profile], () => "different-key", storage), {});
  assert.deepEqual(await restoreModelCatalogs([profile], () => "", storage), {});
});

test("a cached empty authorized list survives reload as empty instead of reverting to static models", async () => {
  const storage = new MemoryStorage();
  const key = "empty-account-key";
  const fingerprint = await modelKeyFingerprint(key);
  saveModelCatalog(profile, fingerprint, { models: [] }, storage);
  const restored = await restoreModelCatalogs([profile], () => key, storage);
  assert.ok(Object.hasOwn(restored, profile.id));
  assert.deepEqual(restored[profile.id].models, []);
});

test("fallback is explicitly marked and one provider cannot overwrite another provider's cache", async () => {
  const storage = new MemoryStorage();
  const other = { id: "other", adapter: "newapi", baseUrl: "https://another.example" };
  const fingerprint = await modelKeyFingerprint("same-key");
  saveModelCatalog(profile, fingerprint, { models: ["new-model"] }, storage);
  const fallback = saveModelCatalog(other, fingerprint, { models: ["documented-model"], warning: "目录接口不可用" }, storage);
  assert.equal(fallback.source, "fallback");
  assert.deepEqual(Object.keys(readModelCatalogs(storage)).sort(), ["lwaigc", "other"]);
  assert.deepEqual(readModelCatalogs(storage).lwaigc.models, ["new-model"]);
  const explicitlyCached = saveModelCatalog(other, fingerprint, { models: [], source: "cache" }, storage);
  assert.equal(explicitlyCached.source, "cache");
});

test("deleting one provider removes only its cached catalog and cannot restore it on restart", async () => {
  const storage = new MemoryStorage();
  const other = { ...profile, id: "another-profile" };
  const key = "retained-key";
  const fingerprint = await modelKeyFingerprint(key);
  saveModelCatalog(profile, fingerprint, { models: ["deleted-model"] }, storage);
  saveModelCatalog(other, fingerprint, { models: ["retained-model"] }, storage);
  removeModelCatalog(profile.id, storage);
  assert.deepEqual(Object.keys(readModelCatalogs(storage)), [other.id]);
  const restored = await restoreModelCatalogs([profile, other], () => key, storage);
  assert.equal(restored[profile.id], undefined);
  assert.deepEqual(restored[other.id].models, ["retained-model"]);
});

test("reusing a confirmed catalog preserves the original read time", async () => {
  const storage = new MemoryStorage();
  const fingerprint = await modelKeyFingerprint("same-key");
  const entry = saveModelCatalog(profile, fingerprint, {
    models: ["confirmed-model"], source: "cached", fetchedAt: 123456,
  }, storage);
  assert.equal(entry.fetchedAt, 123456);
  assert.equal(readModelCatalogs(storage)[profile.id].fetchedAt, 123456);
});

test("malformed or unavailable storage does not break model reads or connection testing", async () => {
  const storage = new MemoryStorage();
  for (const value of ["{broken", "null", "[]", "true", '"text"']) {
    storage.setItem(PROVIDER_MODEL_CATALOGS_KEY, value);
    assert.deepEqual(readModelCatalogs(storage), {});
  }
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(readModelCatalogs(blocked), {});
  const fingerprint = await modelKeyFingerprint("key");
  assert.doesNotThrow(() => saveModelCatalog(profile, fingerprint, { models: ["new-model"] }, blocked));
  assert.doesNotThrow(() => removeModelCatalog(profile.id, blocked));
  assert.equal(modelCatalogMatches(null, profile, fingerprint), false);
  assert.equal(modelCatalogMatches({ models: "not-array" }, profile, fingerprint), false);
  assert.equal(modelCatalogMatches({ models: [] }, { ...profile, baseUrl: "invalid" }, fingerprint), false);
});
