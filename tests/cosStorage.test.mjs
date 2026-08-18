import test from "node:test";
import assert from "node:assert/strict";
import { cosAuthorization, cosFingerprintKey, cosObjectPath, cosPublicUrl, normalizeCosConfig } from "../src/cosStorage.js";

test("COS configuration requires all credential fields", () => {
  assert.equal(normalizeCosConfig({ bucket: "bucket-1", region: "ap-hongkong" }), null);
  assert.deepEqual(normalizeCosConfig({ bucket: "bucket-1", region: "ap-hongkong", secretId: "id", secretKey: "key" }), {
    bucket: "bucket-1", region: "ap-hongkong", secretId: "id", secretKey: "key",
  });
});

test("COS object URLs encode names without flattening folders", () => {
  assert.equal(cosObjectPath("workbench/image/a b.png"), "/workbench/image/a%20b.png");
  assert.equal(cosPublicUrl({ bucket: "bucket-1", region: "ap-hongkong" }, "a/b.png"), "https://bucket-1.cos.ap-hongkong.myqcloud.com/a/b.png");
});

test("COS authorization is deterministic and contains no secret", () => {
  const value = cosAuthorization({ secretId: "id", secretKey: "super-secret", host: "bucket.cos.ap-hongkong.myqcloud.com", pathname: "/a.png", now: 1_700_000_000_000 });
  assert.match(value, /q-ak=id/);
  assert.match(value, /q-signature=[0-9a-f]{40}/);
  assert.doesNotMatch(value, /super-secret/);
});

test("COS fingerprint keys are stable across dates and preserve media types", () => {
  const digest = "a".repeat(64);
  assert.equal(cosFingerprintKey({ kind: "image", digest, extension: ".PNG" }), `workbench/image/${digest}.png`);
  assert.equal(cosFingerprintKey({ kind: "audio", digest, extension: ".wav" }), `workbench/audio/${digest}.wav`);
  assert.throws(() => cosFingerprintKey({ kind: "image", digest: "bad" }), /无效的素材文件指纹/);
});
