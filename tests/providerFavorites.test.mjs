import test from "node:test";
import assert from "node:assert/strict";
import {
  loadUncommonProviderIds,
  partitionProviders,
  saveUncommonProviderIds,
  withProviderCommonState,
} from "../src/providerFavorites.js";

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    getItem(key) { return values[key] ?? null; },
    setItem(key, value) { values[key] = String(value); },
  };
}

test("keeps every existing provider common until the user moves it", () => {
  const profiles = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(partitionProviders(profiles, []), { common: profiles, other: [] });
});

test("moves providers between common and other without changing their order", () => {
  const profiles = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const uncommon = withProviderCommonState([], "b", false);
  assert.deepEqual(partitionProviders(profiles, uncommon), {
    common: [{ id: "a" }, { id: "c" }],
    other: [{ id: "b" }],
  });
  assert.deepEqual(withProviderCommonState(uncommon, "b", true), []);
});

test("persists uncommon providers across restarts", () => {
  const storage = memoryStorage();
  saveUncommonProviderIds(["b", "b", "c"], storage);
  assert.deepEqual(loadUncommonProviderIds(storage), ["b", "c"]);
});
