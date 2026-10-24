import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_PROFILES, FALLBACK_MODELS, capabilityFor, inferAdapter, migrateSavedProfile, modelForSdVersion } from "../src/providerCatalog.js";
import { baojuModels, baojuTaskResult } from "../src/baojuCatalog.js";
import { beginBatchSubmission, overnightRetryableItems, reconciledBatchTerminalState } from "../src/batchPrompts.js";
import { mediaUploadMode, requiresProviderAssetUpload } from "../src/uploadPolicy.js";

test("Baoju is selectable without inventing a default model or upload endpoint", () => {
  const profile = DEFAULT_PROFILES.find((row) => row.id === "baoju");
  assert.deepEqual(profile, { id: "baoju", name: "Baoju / aimjbbb", baseUrl: "https://aimjbbb.cn", adapter: "baoju", model: "", mediaUploadUrl: "" });
  assert.equal(inferAdapter("https://aimjbbb.cn/api/v1"), "baoju");
  assert.deepEqual(migrateSavedProfile({ ...profile, adapter: "newapi" }), profile);
  assert.deepEqual(FALLBACK_MODELS.baoju, []);
  assert.equal(mediaUploadMode(profile, "image/png"), "temporary");
  assert.equal(requiresProviderAssetUpload("baoju"), false);
  assert.match(readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8"), /<option value="baoju">Baoju \/ aimjbbb<\/option>/);
});

test("live limits and model generation survive public model IDs with provider prefixes", () => {
  const catalog = baojuModels({ data: [{ id: "provider/seedance-2.5", capabilities: {
    duration_seconds: { allowed: [4, 15, 30] },
    references: { image: { maximum: 3 }, video: { maximum: 0 }, audio: { maximum: 2 } },
  } }] });
  const profile = { adapter: "baoju", model: "provider/seedance-2.5", routeCapabilities: catalog.capabilities };
  assert.equal(capabilityFor(profile).images, 3);
  assert.equal(capabilityFor(profile).videos, 0);
  assert.equal(modelForSdVersion({ ...profile, model: "" }, "sd25", catalog.models), "provider/seedance-2.5");
});

test("expired Baoju results cannot trigger automatic paid regeneration", () => {
  const result = baojuTaskResult({ id: "old-task", status: "succeeded", result_state: "expired", output: [] });
  const item = { id: "section-1", taskIds: ["old-task"], status: "generating" };
  const terminal = reconciledBatchTerminalState(item, [{ ...result, id: "old-task" }]);
  assert.equal(terminal.autoRetryBlocked, true);
  assert.deepEqual(overnightRetryableItems([{ ...item, ...terminal }], { itemIds: [item.id] }), []);
  assert.equal(beginBatchSubmission({ ...item, ...terminal }, { id: "baoju" }).autoRetryBlocked, false);
});
