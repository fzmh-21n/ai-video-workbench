import assert from "node:assert/strict";
import test from "node:test";

import {
  TEXT_ATTACHMENT_ACCEPT,
  TEXT_ATTACHMENT_MAX_BYTES,
  TEXT_IMAGE_MAX_BYTES,
  TEXT_REQUEST_MAX_BYTES,
  attachmentKind,
  readTextAttachment,
} from "../src/textAttachments.js";

const encode = (text) => new TextEncoder().encode(text);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function file(name, bytes, options = {}) {
  let reads = 0;
  return {
    name,
    size: bytes.byteLength,
    ...options,
    async arrayBuffer() {
      reads++;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    get reads() { return reads; },
  };
}

test("publishes the exact supported attachment extensions and byte limits", () => {
  assert.equal(TEXT_ATTACHMENT_ACCEPT, ".txt,.md,.json,.csv,.tsv,.log,.docx,.pdf,.png,.jpg,.jpeg,.webp");
  assert.equal(TEXT_ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(TEXT_IMAGE_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(TEXT_REQUEST_MAX_BYTES, 20 * 1024 * 1024);
});

test("classifies allowlisted extensions case-insensitively without accepting hidden suffixes", () => {
  for (const extension of ["txt", "md", "json", "csv", "tsv", "log"]) {
    assert.equal(attachmentKind(`source.${extension}`), "text");
    assert.equal(attachmentKind(`SOURCE.${extension.toUpperCase()}`), "text");
  }
  for (const extension of ["docx", "pdf"]) assert.equal(attachmentKind(`source.${extension.toUpperCase()}`), "document");
  for (const extension of ["png", "jpg", "jpeg", "webp"]) assert.equal(attachmentKind(`source.${extension.toUpperCase()}`), "image");
  for (const name of ["source", "source.doc", "source.gif", "source.svg", "source.txt.exe", "source.png.exe"]) {
    assert.equal(attachmentKind(name), null, name);
  }
});

test("preserves UTF-8 text, whitespace, line endings, filename, and byte size", async () => {
  const original = "  原始台词：你好。\r\n\r\n# 标题\n😀\t末尾空格  \n";
  const input = file("原始剧本.TXT", encode(original));
  const result = await readTextAttachment(input);
  assert.equal(result.name, input.name);
  assert.equal(result.kind, "text");
  assert.equal(result.text, original);
  assert.equal(result.size, input.size);
  assert.equal(typeof result.id, "string");
  assert.ok(result.id.length > 0);
  assert.equal(input.reads, 1);
  assert.equal(Object.hasOwn(result, "dataUrl"), false);
});

test("does not silently truncate long text or its final lines", async () => {
  const original = `${"长文本，完整保留。\n".repeat(20_000)}最后一行也必须存在。\r\n`;
  const result = await readTextAttachment(file("long.md", encode(original)));
  assert.equal(result.text, original);
});

test("generates a unique nonempty ID for each import even with identical filenames", async () => {
  const first = await readTextAttachment(file("same.txt", encode("内容")));
  const second = await readTextAttachment(file("same.txt", encode("内容")));
  assert.equal(typeof first.id, "string");
  assert.equal(typeof second.id, "string");
  assert.ok(first.id.length > 0 && second.id.length > 0);
  assert.notEqual(first.id, second.id);
});

test("decodes UTF-16 LE and BE with BOM without dropping content or adding NULs", async () => {
  const original = "  中文😀\r\n结尾  \n";
  const littleEndian = Buffer.from(original, "utf16le");
  const bigEndian = Buffer.from(littleEndian).swap16();
  for (const bytes of [
    Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]),
  ]) {
    const result = await readTextAttachment(file("utf16.txt", bytes));
    assert.equal(result.text, original);
  }
});

test("falls back to GB18030 for Chinese and four-byte characters after fatal UTF-8 decoding", async () => {
  const bytes = Uint8Array.from([0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x90, 0x30, 0x81, 0x30, 0x0d, 0x0a]);
  const result = await readTextAttachment(file("legacy.csv", bytes));
  assert.equal(result.text, " 中文\u{10000}\r\n");
});

test("rejects decoded NUL binary content in UTF-8 and UTF-16 text", async () => {
  for (const bytes of [
    encode("before\0after"),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("before\0after", "utf16le")]),
  ]) await assert.rejects(readTextAttachment(file("binary.txt", bytes)));
});

test("rejects unsupported extensions before reading their bytes", async () => {
  for (const name of ["source.exe", "source.gif", "source.txt.exe"]) {
    const input = file(name, encode("text"));
    await assert.rejects(readTextAttachment(input));
    assert.equal(input.reads, 0);
  }
});

test("rejects nonpositive, nonfinite, and oversized attachments before reading", async () => {
  for (const [name, size] of [
    ["source.txt", 0],
    ["source.txt", -1],
    ["source.txt", NaN],
    ["source.txt", Infinity],
    ["source.txt", TEXT_ATTACHMENT_MAX_BYTES + 1],
    ["source.pdf", TEXT_ATTACHMENT_MAX_BYTES + 1],
    ["source.docx", TEXT_ATTACHMENT_MAX_BYTES + 1],
    ["source.png", TEXT_IMAGE_MAX_BYTES + 1],
  ]) {
    const input = file(name, encode("not read"), { size });
    await assert.rejects(readTextAttachment(input));
    assert.equal(input.reads, 0, `${name}: ${size}`);
  }
});

test("accepts text at the inclusive 10 MiB limit without truncating", async () => {
  const bytes = new Uint8Array(TEXT_ATTACHMENT_MAX_BYTES).fill(0x61);
  const result = await readTextAttachment(file("limit.txt", bytes));
  assert.equal(result.size, TEXT_ATTACHMENT_MAX_BYTES);
  assert.equal(result.text.length, TEXT_ATTACHMENT_MAX_BYTES);
  assert.equal(result.text, "a".repeat(TEXT_ATTACHMENT_MAX_BYTES));
});

test("documents require local extraction and are never decoded as raw text", async () => {
  for (const name of ["source.DOCX", "source.PDF"]) {
    const input = file(name, encode("not extracted locally"));
    await assert.rejects(readTextAttachment(input), /提取|extract/i);
    assert.equal(input.reads, 0);
  }
});

test("derives PNG, JPEG, and WebP MIME types from magic bytes rather than extension or file type", async () => {
  for (const [name, bytes, mime] of [
    ["reference.JPEG", png, "image/png"],
    ["reference.webp", jpeg, "image/jpeg"],
    ["reference.png", webp, "image/webp"],
  ]) {
    const input = file(name, bytes, { type: "text/plain" });
    const result = await readTextAttachment(input);
    assert.equal(result.kind, "image");
    assert.equal(result.name, name);
    assert.equal(result.size, bytes.byteLength);
    assert.equal(result.dataUrl, `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`);
    assert.equal(typeof result.id, "string");
    assert.ok(result.id.length > 0);
    assert.equal(Object.hasOwn(result, "text"), false);
    assert.equal(input.reads, 1);
  }
});

test("rejects unsupported and truncated image signatures instead of decoding them as text", async () => {
  for (const [name, bytes] of [
    ["fake.png", encode("ordinary text")],
    ["truncated.png", png.slice(0, 7)],
    ["truncated.jpg", jpeg.slice(0, 2)],
    ["other.webp", encode("RIFF1234WAVE")],
    ["fake.jpeg", encode("GIF89a")],
  ]) await assert.rejects(readTextAttachment(file(name, bytes, { type: "image/png" })));
});

test("accepts an image at the inclusive 5 MiB limit", async () => {
  const bytes = new Uint8Array(TEXT_IMAGE_MAX_BYTES);
  bytes.set(png);
  const result = await readTextAttachment(file("limit.png", bytes));
  assert.equal(result.size, TEXT_IMAGE_MAX_BYTES);
  assert.equal(result.kind, "image");
  assert.ok(result.dataUrl.startsWith("data:image/png;base64,"));
  assert.equal(Buffer.from(result.dataUrl.split(",")[1], "base64").byteLength, TEXT_IMAGE_MAX_BYTES);
});
