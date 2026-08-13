import test from "node:test";
import assert from "node:assert/strict";

import {
  syncAudioForProfile,
  withSyncAudioPreference,
} from "../src/syncAudioPreference.js";

test("every provider defaults to synchronized audio enabled", () => {
  assert.equal(syncAudioForProfile({}, "meaicc"), true);
  assert.equal(syncAudioForProfile({}, "canseedream"), true);
  assert.equal(syncAudioForProfile(undefined, "ziyuai"), true);
});

test("only the selected provider changes when the user toggles synchronized audio", () => {
  const preferences = withSyncAudioPreference({}, "ziyuai", false);
  assert.equal(syncAudioForProfile(preferences, "ziyuai"), false);
  assert.equal(syncAudioForProfile(preferences, "meaicc"), true);

  const restored = withSyncAudioPreference(preferences, "ziyuai", true);
  assert.equal(syncAudioForProfile(restored, "ziyuai"), true);
});
