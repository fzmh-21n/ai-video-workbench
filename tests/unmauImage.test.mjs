import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import { prepareUnmauImage } from "../src/unmauImage.js";

test("keeps Unmau images below the safe limit unchanged", async () => {
  const bytes = Buffer.from("small image placeholder");
  const result = await prepareUnmauImage({ bytes, fileName: "small.png", mimeType: "image/png", maxBytes: 1024 });
  assert.equal(result.bytes, bytes);
  assert.equal(result.compressed, false);
});

test("compresses oversized Unmau images without changing dimensions", async () => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "unmau-image-test-"));
  const width = 900;
  const height = 900;
  const source = await sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  try {
    const input = { bytes: source, fileName: "large.png", mimeType: "image/png", cacheDir, maxBytes: 500 * 1024 };
    const result = await prepareUnmauImage(input);
    const cached = await prepareUnmauImage(input);
    const metadata = await sharp(result.bytes).metadata();
    assert.equal(result.compressed, true);
    assert.equal(result.mimeType, "image/jpeg");
    assert.ok(result.bytes.length <= 500 * 1024);
    assert.equal(metadata.width, width);
    assert.equal(metadata.height, height);
    assert.equal(cached.cached, true);
    assert.deepEqual(cached.bytes, result.bytes);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
