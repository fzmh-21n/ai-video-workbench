import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { capabilityFor, capabilityLimitIssue, sdVersionForProfile } from "../src/providerCatalog.js";
import { seedanceVideoModels } from "../src/seedanceVideoCatalog.js";

const images = (count) => Array.from({ length: count }, () => ({ kind: "image" }));

test("SD2.0 caps live and fallback 772808 reference images at nine", () => {
  const model = "wanzhou-seedance-2.0";
  const catalog = seedanceVideoModels({ data: [{ id: model, durations: [5, 10, 15], resolutions: [{ value: "720p" }] }] });
  for (const routeCapabilities of [undefined, catalog.capabilities]) {
    const profile = { adapter: "seedancevideo", model, routeCapabilities };
    assert.equal(sdVersionForProfile(profile), "sd20");
    assert.equal(capabilityFor(profile).images, 9);
    assert.equal(capabilityLimitIssue(profile, images(9), 15), "");
    assert.match(capabilityLimitIssue(profile, images(10), 15), /图片参考最多 9 个/);
  }
  assert.equal(catalog.capabilities[model].images, 50, "workbench policy must not mutate the stored live catalog");
});

test("SD2.0 keeps stricter live exclusions and applies the same ceiling across relay adapters", () => {
  for (const adapter of ["fmgo", "pidoi", "globalaiopc", "maxforai", "seedancevideo", "ziyuai", "suanliai", "baoju"]) {
    for (const limit of [0, 2, 9, 30, 50]) {
      const model = "future-sd2.0-route";
      const profile = { adapter, model, routeCapabilities: { [model]: {
        images: limit, videos: 0, audios: 0, durations: [15], resolutions: ["720p"], ratios: ["16:9"],
        _sdVersion: "sd20", _preserveLimits: true,
      } } };
      assert.equal(sdVersionForProfile(profile), "sd20");
      const cap = capabilityFor(profile);
      assert.equal(cap.images, Math.min(limit, 9), `${adapter}: ${limit}`);
      assert.equal(cap.videos, 0);
      assert.equal(cap.audios, 0);
    }
  }
  assert.equal(capabilityFor({ adapter: "bailing", model: "future-sd2.0-route" }).images, 9);
});

test("SD2.5 retains live reference limits even when the model ID does not encode its version", () => {
  const model = "opaque-route";
  const catalog = seedanceVideoModels({ data: [{ id: model, durations: [15, 30] }] });
  const profile = { adapter: "seedancevideo", model, routeCapabilities: catalog.capabilities };
  assert.equal(sdVersionForProfile(profile), "sd25");
  assert.equal(capabilityFor(profile).images, 50);
  assert.equal(capabilityLimitIssue(profile, images(10), 30), "");
  const fallback25 = { adapter: "seedancevideo", model: "seedance-2.5" };
  assert.equal(sdVersionForProfile(fallback25), "sd25");
  assert.equal(capabilityFor(fallback25).images, 50);
  assert.equal(capabilityLimitIssue(fallback25, images(10), 30), "");
});

test("the server does not guess an opaque live SD2.5 route's image limit without its catalog", () => {
  const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function validateProviderLimits(");
  const end = source.indexOf("\nfunction ", start + 1);
  const context = vm.createContext({ capabilityLimitIssue: () => { throw new Error("No live metadata is available here"); } });
  vm.runInContext(source.slice(start, end), context);
  assert.doesNotThrow(() => context.validateProviderLimits({ adapter: "seedancevideo", model: "opaque-route" }, images(10), 30));
});
