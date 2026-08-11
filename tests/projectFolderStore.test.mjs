import test from "node:test";
import assert from "node:assert/strict";
import { filesFromProjectDirectory } from "../src/projectFolderStore.js";

function directory(entries) {
  return { async *entries() { yield* entries; } };
}

test("recursively restores files from a remembered project directory", async () => {
  const image = { name: "person.png" };
  const audio = { name: "voice.wav" };
  const handle = directory([
    ["person.png", { kind: "file", getFile: async () => image }],
    ["audio", { kind: "directory", ...directory([
      ["voice.wav", { kind: "file", getFile: async () => audio }],
    ]) }],
  ]);
  assert.deepEqual(await filesFromProjectDirectory(handle), [
    { file: image, relativePath: "person.png" },
    { file: audio, relativePath: "audio/voice.wav" },
  ]);
});
