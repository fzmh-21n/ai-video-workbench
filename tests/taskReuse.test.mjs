import assert from "node:assert/strict";
import test from "node:test";

import { reusableAssetFor, taskReuseSnapshot } from "../src/taskReuse.js";

test("stores reusable task metadata without copying local files", () => {
  const file = { name: "001_人物.png", size: 123 };
  const snapshot = taskReuseSnapshot({
    prompt: "人物走路",
    references: [{ kind: "image", name: file.name, file, projectAssetKey: "image/001" }],
    duration: 15, resolution: "720p", ratio: "9:16", seed: "7", quantity: 1,
    syncAudio: true, autoReference: true,
  });
  assert.equal(snapshot.references[0].name, "001_人物.png");
  assert.equal(snapshot.references[0].projectAssetKey, "image/001");
  assert.equal("file" in snapshot.references[0], false);
  assert.equal(snapshot.prompt, "人物走路");
});

test("restores a reusable reference by project key or unique exact filename", () => {
  const keyed = { key: "image/001", kind: "image", file: { name: "新名字.png" } };
  const named = { key: "image/002", kind: "image", file: { name: "场景.png" } };
  assert.equal(reusableAssetFor({ projectAssetKey: "image/001", name: "旧名字.png" }, [keyed, named]), keyed);
  assert.equal(reusableAssetFor({ kind: "image", name: "场景.png" }, [keyed, named]), named);
});
