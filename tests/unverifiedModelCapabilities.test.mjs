import test from "node:test";
import assert from "node:assert/strict";
import { capabilityFor, capabilityLimitIssue, preferredDurationForVersion } from "../src/providerCatalog.js";
import { MAXFORAI_FT_933_MODEL } from "../src/maxforaiCatalog.js";
import { FMGO_K20_FAST_MODEL, FMGO_V25_MODEL, fmgoV25Capability } from "../src/fmgoCatalog.js";

const references = (kind, count) => Array.from({ length: count }, (_, index) => ({ kind, name: `${kind}-${index}` }));
const adapters = ["fmgo", "pidoi", "globalaiopc", "maxforai"];

for (const adapter of adapters) {
  const profile = { adapter, model: "vendor/brand-new-opaque-route" };

  test(`${adapter} does not turn guessed legacy limits into hard gates for a new model`, () => {
    const cap = capabilityFor(profile);
    assert.equal(cap._capabilityUnverified, true);
    assert.equal(cap._preserveLimits, true);
    assert.deepEqual([cap.images, cap.videos, cap.audios], [50, 50, 50]);
    assert.deepEqual(cap.durations, Array.from({ length: 30 }, (_, index) => index + 1));
    assert.equal(capabilityLimitIssue(profile, references("image", 30), 30), "");
  });

  test(`${adapter} still enforces workbench-wide material and duration boundaries for unknown models`, () => {
    const mixed = ["image", "video", "audio"].flatMap((kind) => references(kind, 17));
    assert.ok(capabilityLimitIssue(profile, mixed, 30), "51 mixed references must not bypass a total-50 boundary");
    assert.equal(capabilityLimitIssue(profile, references("image", 50), 30), "");
    for (const duration of [0, 31, 60, 61, 1.5]) assert.ok(capabilityLimitIssue(profile, [], duration), `reject duration ${duration}`);
  });

  test(`${adapter} unknown model defaults cannot inflate the public duration to 60 seconds`, () => {
    const sd25 = capabilityFor({ adapter, model: "vendor/future-sd2.5-route" });
    const preferred25 = preferredDurationForVersion(sd25, "sd25");
    assert.ok(preferred25 <= 30, `unverified SD2.5 default must not exceed 30 seconds; received ${preferred25}`);
    assert.ok(sd25.durations.includes(preferred25));
    const sd20 = capabilityFor({ adapter, model: "vendor/future-sd2.0-route" });
    assert.equal(preferredDurationForVersion(sd20, "sd20"), 15);
  });

  test(`${adapter} respects explicit live capabilities instead of generic unknown-model defaults`, () => {
    const live = { images: 2, videos: 0, audios: 0, durations: [7], resolutions: ["480p"], ratios: ["1:1"], seed: false,
      syncAudio: false, syncAudioFixed: true, _preserveLimits: true };
    const actual = { ...profile, routeCapabilities: { [profile.model]: live } };
    const cap = capabilityFor(actual);
    assert.deepEqual([cap.images, cap.videos, cap.audios], [2, 0, 0]);
    assert.deepEqual(cap.durations, [7]);
    assert.deepEqual(cap.resolutions, ["480p"]);
    assert.deepEqual(cap.ratios, ["1:1"]);
    assert.notEqual(cap._capabilityUnverified, true);
    assert.equal(capabilityLimitIssue(actual, references("image", 2), 7), "");
    assert.ok(capabilityLimitIssue(actual, references("image", 3), 7));
    assert.ok(capabilityLimitIssue(actual, references("video", 1), 7));
    assert.ok(capabilityLimitIssue(actual, [], 30));
  });

  test(`${adapter} explicitly published durations above 30 seconds are not mistaken for an unverified default`, () => {
    const actual = { ...profile, routeCapabilities: { [profile.model]: { images: 2, videos: 0, audios: 0,
      durations: [15, 30, 60], resolutions: ["720p"], ratios: ["16:9"], _preserveLimits: true } } };
    const cap = capabilityFor(actual);
    assert.deepEqual(cap.durations, [15, 30, 60]);
    assert.notEqual(cap._capabilityUnverified, true);
    assert.equal(preferredDurationForVersion(cap, "sd25"), 60);
    assert.equal(capabilityLimitIssue(actual, references("image", 2), 60), "");
  });
}

test("known Pidoi 900 image-only rules are not relaxed along with unfamiliar model names", () => {
  const profile = { adapter: "pidoi", model: "sd2.5-900" };
  const cap = capabilityFor(profile);
  assert.deepEqual([cap.images, cap.videos, cap.audios], [9, 0, 0]);
  assert.deepEqual(cap.durations, [30]);
  assert.equal(capabilityLimitIssue(profile, references("image", 9), 30), "");
  assert.ok(capabilityLimitIssue(profile, references("image", 10), 30));
  assert.ok(capabilityLimitIssue(profile, references("audio", 1), 30));
  assert.ok(capabilityLimitIssue(profile, [], 15));
});

test("Bailing's generic controls keep its five-second default without offering an unverified 60-second duration", () => {
  const profile = { adapter: "bailing", model: "new-bailing-route" };
  const cap = capabilityFor(profile);
  assert.deepEqual(cap.durations, Array.from({ length: 30 }, (_, index) => index + 1));
  assert.equal(preferredDurationForVersion(cap, "sd25"), 5);
  assert.ok(capabilityLimitIssue(profile, [], 31));
  assert.ok(capabilityLimitIssue(profile, [], 60));
});

test("known MaxForAI FT933 duration and reference limits remain enforced", () => {
  const profile = { adapter: "maxforai", model: MAXFORAI_FT_933_MODEL };
  const cap = capabilityFor(profile);
  assert.deepEqual([cap.images, cap.videos, cap.audios], [9, 3, 3]);
  assert.deepEqual(cap.durations, Array.from({ length: 12 }, (_, index) => index + 4));
  assert.equal(capabilityLimitIssue(profile, references("image", 9), 15), "");
  assert.ok(capabilityLimitIssue(profile, references("image", 10), 15));
  assert.ok(capabilityLimitIssue(profile, [], 30));
});

test("recognized FMGO encoded variants keep encoded duration rather than generic duration options", () => {
  for (const model of ["feimiao-v2-431-720p-10s", "new-route-720p-10s"]) {
    const profile = { adapter: "fmgo", model };
    assert.deepEqual(capabilityFor(profile).durations, [10]);
    assert.equal(capabilityLimitIssue(profile, [], 10), "");
    assert.ok(capabilityLimitIssue(profile, [], 30));
  }
});

test("recognized FMGO K2.0 and V2.5 model families retain their dedicated capabilities", () => {
  const k2 = { adapter: "fmgo", model: FMGO_K20_FAST_MODEL };
  assert.deepEqual(capabilityFor(k2).durations, [10, 15]);
  assert.ok(capabilityLimitIssue(k2, [], 30));
  for (const model of [FMGO_V25_MODEL, "feimiao-v2.5-720p-10s"]) {
    const profile = { adapter: "fmgo", model };
    assert.deepEqual(capabilityFor(profile).durations, fmgoV25Capability(model).durations);
    assert.deepEqual(capabilityFor(profile).resolutions, fmgoV25Capability(model).resolutions);
    assert.ok(capabilityLimitIssue(profile, [], 60));
  }
});
