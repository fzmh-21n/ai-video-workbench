export const TEXT_ATTACHMENT_ACCEPT = ".txt,.md,.json,.csv,.tsv,.log,.docx,.pdf,.png,.jpg,.jpeg,.webp";
export const TEXT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const TEXT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const TEXT_REQUEST_MAX_BYTES = 20 * 1024 * 1024;

export function attachmentKind(name) {
  const extension = String(name || "").trim().toLowerCase().split(".").pop();
  if (["txt", "md", "json", "csv", "tsv", "log"].includes(extension) && String(name).includes(".")) return "text";
  if (["docx", "pdf"].includes(extension) && String(name).includes(".")) return "document";
  if (["png", "jpg", "jpeg", "webp"].includes(extension) && String(name).includes(".")) return "image";
  return null;
}

function imageMime(bytes) {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && [82, 73, 70, 70].every((value, index) => bytes[index] === value)
    && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)) return "image/webp";
  throw new Error("图片内容不是有效的 PNG、JPEG 或 WEBP 文件");
}

function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decodeText(bytes) {
  let text;
  if (bytes[0] === 255 && bytes[1] === 254) text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
  else if (bytes[0] === 254 && bytes[1] === 255) text = new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
  else {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
  }
  if (text.includes("\0")) throw new Error("附件包含二进制内容，不能作为文字读取");
  return text;
}

export async function readTextAttachment(file) {
  const kind = attachmentKind(file?.name);
  if (!kind) throw new Error("不支持此附件类型");
  const limit = kind === "image" ? TEXT_IMAGE_MAX_BYTES : TEXT_ATTACHMENT_MAX_BYTES;
  if (!Number.isInteger(file.size) || file.size <= 0) throw new Error("附件不能为空且大小必须有效");
  if (file.size > limit) throw new Error(`${kind === "image" ? "图片" : "文字或文档"}附件不能超过 ${limit / 1024 / 1024} MiB`);
  if (kind === "document") throw new Error("Word/PDF 文档需要通过本地文档提取读取");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > limit) throw new Error("附件实际内容超过大小上限");
  const shared = { id: crypto.randomUUID(), name: file.name, kind, size: file.size };
  return kind === "text" ? { ...shared, text: decodeText(bytes) }
    : { ...shared, dataUrl: `data:${imageMime(bytes)};base64,${base64(bytes)}` };
}
