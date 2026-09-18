import crypto from "node:crypto";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import sharp from "sharp";

export const UNMAU_IMAGE_SAFE_BYTES = 9 * 1024 * 1024;
export const UNMAU_IMAGE_CACHE_VERSION = "unmau-image-v1";

function jpegName(value) {
  const parsed = path.parse(String(value || "reference-image"));
  return `${parsed.name || "reference-image"}.jpg`;
}

export async function prepareUnmauImage({ bytes, fileName, mimeType, cacheDir, maxBytes = UNMAU_IMAGE_SAFE_BYTES }) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("图片内容必须是 Buffer");
  if (bytes.length <= maxBytes) {
    return { bytes, fileName, mimeType, compressed: false, cached: false };
  }

  const digest = crypto.createHash("sha256").update(UNMAU_IMAGE_CACHE_VERSION).update(bytes).digest("hex");
  const cachePath = cacheDir ? path.join(cacheDir, `${digest}.jpg`) : "";
  if (cachePath && existsSync(cachePath) && statSync(cachePath).size <= maxBytes) {
    return {
      bytes: readFileSync(cachePath),
      fileName: jpegName(fileName),
      mimeType: "image/jpeg",
      compressed: true,
      cached: true,
    };
  }

  let output;
  for (const quality of [96, 94, 92, 90, 88, 85, 82, 78, 74, 70, 65, 60, 55, 50, 45, 40]) {
    output = await sharp(bytes, { limitInputPixels: false })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toBuffer();
    if (output.length <= maxBytes) break;
  }
  if (!output || output.length > maxBytes) {
    throw new Error(`自动压缩后仍超过 ${(maxBytes / 1024 / 1024).toFixed(1)}MB：${fileName}`);
  }
  if (cachePath) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, output);
  }
  return {
    bytes: output,
    fileName: jpegName(fileName),
    mimeType: "image/jpeg",
    compressed: true,
    cached: false,
  };
}
