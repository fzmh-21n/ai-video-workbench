import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TEXT_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
const DOCX_EXPANDED_MAX_BYTES = 50 * 1024 * 1024;
const DOCUMENT_PARSER_PATH = fileURLToPath(import.meta.url);

function documentError(message, status = 400) {
  return Object.assign(new Error(message), { status, code: "TEXT_DOCUMENT_INVALID" });
}

function validateDocxZip(buffer) {
  // Check actual expanded bytes, not just the attacker-controlled ZIP size fields.
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { end = offset; break; }
  }
  if (end < 0) throw documentError("DOCX 文件损坏，请用 Word 重新另存为 DOCX 后上传");
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directory = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || !count || count > 5000 || directory + directorySize !== end)
    throw documentError("DOCX 压缩结构无效或过于复杂，请重新另存为普通 DOCX");
  let cursor = directory;
  let total = 0;
  const names = new Set();
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw documentError("DOCX 压缩目录损坏，请重新另存文件");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const expanded = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const recordLength = 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42);
    if (cursor + recordLength > end || local + 30 > directory || buffer.readUInt32LE(local) !== 0x04034b50 || flags & 1 || ![0, 8].includes(method))
      throw documentError("DOCX 加密或压缩格式不支持，请解除密码并重新另存为 DOCX");
    if (expanded > DOCX_EXPANDED_MAX_BYTES - total) throw documentError("DOCX 展开内容超过工作台 50 MiB 安全上限，请拆分文件后上传", 413);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > directory) throw documentError("DOCX 内容位置无效，请重新另存文件");
    let actual;
    try {
      actual = method === 0 ? buffer.subarray(start, start + compressed) : inflateRawSync(buffer.subarray(start, start + compressed), { maxOutputLength: DOCX_EXPANDED_MAX_BYTES - total || 1 });
    } catch (error) {
      if (error.code === "ERR_BUFFER_TOO_LARGE") throw documentError("DOCX 实际展开内容超过工作台 50 MiB 安全上限，请拆分文件", 413);
      throw documentError("DOCX 压缩内容损坏，请重新另存文件");
    }
    if (actual.length !== expanded) throw documentError("DOCX 展开大小与目录不一致，请重新另存文件");
    total += actual.length;
    names.add(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    cursor += recordLength;
  }
  if (cursor !== end || !names.has("word/document.xml") || !names.has("[Content_Types].xml")) throw documentError("文件不是有效的 Word DOCX，请不要只改扩展名");
}

async function parseDocumentBuffer(buffer, name) {
  const extension = path.extname(name).toLowerCase();
  let text;
  if (extension === ".docx") {
    validateDocxZip(buffer);
    const { default: mammoth } = await import("mammoth");
    try { text = (await mammoth.extractRawText({ buffer })).value; }
    catch { throw documentError("DOCX 正文解析失败，请用 Word 重新另存为 DOCX 后上传"); }
  } else if (extension === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false });
    try { text = (await parser.getText({ pageJoiner: "\n\n" })).text; }
    catch (error) {
      throw documentError(error.name === "PasswordException"
        ? "PDF 已加密或需要密码，请先解除密码再上传"
        : "PDF 正文解析失败，文件可能损坏，请重新导出 PDF 后上传");
    } finally { await parser.destroy().catch(() => {}); }
  } else {
    throw documentError("本地文档提取仅支持 DOCX 和 PDF；旧版 DOC 请先另存为 DOCX");
  }
  text = String(text || "").trim();
  if (!text) throw documentError(extension === ".pdf"
    ? "PDF 没有可提取的正文，可能是扫描件；请将页面作为图片交给支持视觉的模型进行 OCR"
    : "DOCX 没有可提取的正文，请检查文件是否只有图片或为空");
  if (Buffer.byteLength(text, "utf8") > TEXT_DOCUMENT_MAX_BYTES) throw documentError("提取正文超过工作台 10 MiB 上限，请拆分文档；未截断内容", 413);
  return { name, text };
}

function runDocumentParser(buffer, name) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = fork(DOCUMENT_PARSER_PATH, ["--text-document-parser"], {
        execArgv: ["--max-old-space-size=256"], serialization: "advanced",
        silent: true, windowsHide: true,
      });
    } catch {
      reject(documentError("文档解析无法启动，请稍后重试", 503));
      return;
    }
    // Parser diagnostics must not enter the workbench's shared logs.
    child.stdout.resume();
    child.stderr.resume();
    let outcome;
    const timer = setTimeout(() => stop(documentError("文档解析超过 30 秒，已停止；请拆分或重新导出文件后上传", 408)), 30000);
    function stop(error, result) {
      if (outcome) return;
      outcome = { error, result };
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
    child.on("message", (message) => {
      if (message?.ok) stop(undefined, message.result);
      else stop(documentError(message?.message || "文档解析失败，请重新导出文件后上传", message?.status || 400));
    });
    child.on("error", () => stop(documentError("文档解析异常或超出安全资源上限，已停止；请拆分或重新导出文件", 413)));
    child.on("close", () => {
      // Wait for actual process exit, including native-library crashes.
      if (!outcome) {
        clearTimeout(timer);
        outcome = { error: documentError("文档解析意外停止或超出安全资源上限，请拆分或重新导出文件后上传", 413) };
      }
      outcome.error ? reject(outcome.error) : resolve(outcome.result);
    });
    child.send({ type: "text-document", bytes: buffer, name }, (error) => {
      if (error) stop(documentError("文档解析无法接收文件，请稍后重试", 503));
    });
  });
}

export async function extractDocumentText(file) {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer) || !file.buffer.length) throw documentError("请选择非空的 DOCX 或 PDF 文件");
  const buffer = file.buffer;
  if (buffer.length > TEXT_DOCUMENT_MAX_BYTES) throw documentError("文档超过工作台 10 MiB 上传上限，请拆分后上传", 413);
  const name = String(file.originalname || "");
  const extension = path.extname(name).toLowerCase();
  if (extension === ".docx") {
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw documentError("文件内容不是普通 DOCX；旧版 DOC 请先另存为 DOCX，加密文档请先解除密码，不要只改扩展名");
  } else if (extension === ".pdf") {
    if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw documentError("文件内容不是 PDF，请重新导出真正的 PDF 文件");
  } else {
    throw documentError("本地文档提取仅支持 DOCX 和 PDF；旧版 DOC 请先另存为 DOCX");
  }
  return runDocumentParser(buffer, name);
}

if (process.argv[2] === "--text-document-parser" && process.send) {
  process.once("message", (message) => {
    if (message?.type !== "text-document") return;
    parseDocumentBuffer(Buffer.from(message.bytes), message.name)
      .then((result) => process.send({ ok: true, result }))
      .catch((error) => process.send({ ok: false, status: error.status || 400, message: error.code === "TEXT_DOCUMENT_INVALID" ? error.message : "文档解析失败，请重新导出文件后上传" }));
  });
}
