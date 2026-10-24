import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { ChildProcess } from "node:child_process";
import express from "express";
import { createServer } from "node:http";
import { extractDocumentText, TEXT_DOCUMENT_MAX_BYTES } from "../serverTextDocuments.mjs";
import { textServiceRouter } from "../serverTextService.mjs";

const require = createRequire(import.meta.url);
const JSZip = createRequire(require.resolve("mammoth"))("jszip");
const types = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
async function docx(text = "本地 Word 正文") {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", types);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
function pdf({ text = "HELLO LOCAL PDF", encrypted = false } = {}) {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`);
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { body += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encrypted ? `/Encrypt 6 0 R /ID [<${"11".repeat(16)}> <${"11".repeat(16)}>]` : ""} >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body);
}
const file = (originalname, buffer) => ({ originalname, buffer });

function observeParserStop(t) {
  const kill = ChildProcess.prototype.kill;
  return t.mock.method(ChildProcess.prototype, "kill", function (...args) {
    assert.ok(this.spawnargs.includes("--max-old-space-size=256"));
    assert.ok(this.spawnargs.includes("--text-document-parser"));
    assert.deepEqual(args, ["SIGKILL"]);
    return kill.apply(this, args);
  });
}

test("DOCX real isolated extraction preserves Chinese text and stops its process without detaching upload", async (t) => {
  const stop = observeParserStop(t);
  const buffer = await docx("人物甲&lt;说明&gt;");
  const original = Buffer.from(buffer);
  const result = await extractDocumentText(file("角色说明.docx", buffer));
  assert.equal(result.name, "角色说明.docx");
  assert.equal(result.text, "人物甲<说明>");
  assert.deepEqual(buffer, original);
  assert.equal(stop.mock.callCount(), 1);
});

test("PDF real isolated extraction reads its text layer and stops its process", async (t) => {
  const stop = observeParserStop(t);
  const result = await extractDocumentText(file("script.pdf", pdf()));
  assert.equal(result.name, "script.pdf");
  assert.ok(result.text.includes("HELLO LOCAL PDF"));
  assert.ok(!result.text.includes("page_number"));
  assert.equal(stop.mock.callCount(), 1);
});

test("scanned or empty PDF explains missing text and image OCR recovery", async () => {
  await assert.rejects(extractDocumentText(file("scan.pdf", pdf({ text: "" }))), (error) => error.status === 400 && /OCR/.test(error.message));
});

test("encrypted PDF returns a specific remove-password instruction", async () => {
  await assert.rejects(extractDocumentText(file("password.pdf", pdf({ encrypted: true }))), (error) => error.status === 400 && /密码/.test(error.message));
});

test("empty DOCX does not invent text or silently succeed", async () => {
  await assert.rejects(extractDocumentText(file("empty.docx", await docx(""))), (error) => error.status === 400 && /没有可提取/.test(error.message));
});

test("unsupported, corrupted, missing and renamed binary documents fail with sanitized recovery instructions", async () => {
  for (const input of [
    undefined, file("empty.pdf", Buffer.alloc(0)), file("old.doc", Buffer.from("old binary")), file("notes.txt", Buffer.from("plain text")),
    file("renamed.docx", Buffer.from("plain text")), file("renamed.pdf", Buffer.from("PK fake")),
    file("broken.docx", Buffer.from("PK\x03\x04broken")), file("broken.pdf", Buffer.from("%PDF-1.4\nbroken")),
  ]) {
    await assert.rejects(extractDocumentText(input), (error) => error.status === 400 && error.code === "TEXT_DOCUMENT_INVALID" && !/node_modules|stack|ENOENT/.test(error.message));
  }
});

test("local document 10MiB bound rejects before parser work", async () => {
  const bytes = Buffer.alloc(TEXT_DOCUMENT_MAX_BYTES + 1);
  await assert.rejects(extractDocumentText(file("large.pdf", bytes)), (error) => error.status === 413 && /10 MiB/.test(error.message));
});

test("DOCX rejects forged expanded-size metadata and actual decompression bombs", async () => {
  const normal = await docx();
  const forged = Buffer.from(normal);
  const central = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  forged.writeUInt32LE(1, central + 24);
  await assert.rejects(extractDocumentText(file("forged.docx", forged)), (error) => error.status === 400 && /大小/.test(error.message));
  const zip = new JSZip();
  zip.file("[Content_Types].xml", types);
  zip.file("word/document.xml", Buffer.alloc(50 * 1024 * 1024 + 1, 65));
  const bomb = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const declared = Buffer.from(bomb);
  await assert.rejects(extractDocumentText(file("declared.docx", declared)), (error) => error.status === 413 && /50 MiB/.test(error.message));
  let cursor = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (cursor >= 0) {
    if (bomb.readUInt32LE(cursor + 24) > 50 * 1024 * 1024) { bomb.writeUInt32LE(1, cursor + 24); break; }
    cursor = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cursor + 4);
  }
  await assert.rejects(extractDocumentText(file("actual-bomb.docx", bomb)), (error) => error.status === 413 && /50 MiB/.test(error.message));
});

// Exercise private process lifecycle boundaries without sleeping for 30 seconds
// or adding test-only knobs to the document extraction API.
async function parserHarness({ startError, delayedStop = false, sendError = false } = {}) {
  const source = await readFile(new URL("../serverTextDocuments.mjs", import.meta.url), "utf8");
  const errorFunction = source.slice(source.indexOf("function documentError("), source.indexOf("function validateDocxZip("));
  const parserFunction = source.slice(source.indexOf("function runDocumentParser("), source.indexOf("export async function extractDocumentText("));
  const state = { cleared: [], stopped: 0, drained: 0 };
  class FakeChild extends EventEmitter {
    constructor(path, args, options) {
      super();
      if (startError) throw new Error("sensitive process startup detail");
      state.child = this;
      state.path = path;
      state.args = args;
      state.options = options;
      this.stdout = this.stderr = { resume: () => { state.drained += 1; } };
    }
    kill(signal) {
      state.stopped += 1;
      state.signal = signal;
      if (delayedStop) state.completeStop = () => this.emit("close", null, signal);
      else this.emit("close", null, signal);
      return true;
    }
    send(payload, callback) {
      state.payload = payload;
      callback(sendError ? new Error("sensitive IPC detail") : undefined);
    }
  }
  const run = runInNewContext(`${errorFunction}\n${parserFunction}\nrunDocumentParser;`, {
    fork: (path, args, options) => new FakeChild(path, args, options), DOCUMENT_PARSER_PATH: "local-document-parser",
    setTimeout: (callback, delay) => { state.timeout = callback; state.delay = delay; return "document-timer"; },
    clearTimeout: (handle) => state.cleared.push(handle),
  });
  return { run, state };
}

test("isolated parser uses advanced buffer IPC, hidden process, V8 limit, muted diagnostics and waits for stop", async () => {
  const { run, state } = await parserHarness({ delayedStop: true });
  const source = Buffer.from("document upload");
  const pending = run(source, "source.pdf");
  assert.equal(state.delay, 30000);
  assert.equal(state.options.execArgv[0], "--max-old-space-size=256");
  assert.equal(state.options.serialization, "advanced");
  assert.equal(state.options.silent, true);
  assert.equal(state.options.windowsHide, true);
  assert.equal(state.args[0], "--text-document-parser");
  assert.equal(state.payload.type, "text-document");
  assert.equal(state.payload.name, "source.pdf");
  assert.equal(Buffer.from(state.payload.bytes).toString(), source.toString());
  assert.equal(state.drained, 2);
  let returned = false;
  pending.then(() => { returned = true; });
  const result = { name: "source.pdf", text: "正文" };
  state.child.emit("message", { ok: true, result });
  await Promise.resolve();
  assert.equal(returned, false);
  assert.equal(state.stopped, 1);
  assert.equal(state.signal, "SIGKILL");
  assert.deepEqual(state.cleared, ["document-timer"]);
  state.completeStop();
  assert.deepEqual(await pending, result);
  state.timeout();
  assert.equal(state.stopped, 1);
});

test("parser 30-second deadline kills process and returns sanitized timeout without waiting in test", async () => {
  const { run, state } = await parserHarness();
  const pending = run(Buffer.from("bytes"), "slow.pdf");
  state.timeout();
  await assert.rejects(pending, (error) => error.status === 408 && error.code === "TEXT_DOCUMENT_INVALID" && /30 秒.*停止/.test(error.message));
  assert.equal(state.stopped, 1);
  assert.deepEqual(state.cleared, ["document-timer"]);
  state.child.emit("error", new Error("sensitive native parser detail"));
  state.child.emit("close", 3221225477);
  assert.equal(state.stopped, 1);
});

test("process resource error, Windows native crash and parse rejection each return friendly sanitized errors", async () => {
  for (const event of ["error", "close", "message"]) {
    const { run, state } = await parserHarness();
    const pending = run(Buffer.from("bytes"), "broken.pdf");
    state.child.emit(event, event === "message" ? { ok: false, status: 400, message: "PDF 已加密，请解除密码" } : event === "close" ? 3221225477 : new Error("sensitive internal stack"));
    await assert.rejects(pending, (error) => error.code === "TEXT_DOCUMENT_INVALID" && (event === "message" ? error.status === 400 && /密码/.test(error.message) : error.status === 413 && /资源/.test(error.message)) && !/sensitive|stack/.test(error.message));
    assert.equal(state.stopped, event === "close" ? 0 : 1);
    assert.deepEqual(state.cleared, ["document-timer"]);
    state.timeout();
    assert.equal(state.stopped, event === "close" ? 0 : 1);
  }
});

test("process construction failure is sanitized and creates no dangling timer", async () => {
  const { run, state } = await parserHarness({ startError: true });
  await assert.rejects(run(Buffer.from("bytes"), "source.pdf"), (error) => error.status === 503 && /无法启动/.test(error.message) && !/sensitive/.test(error.message));
  assert.equal(state.timeout, undefined);
  assert.equal(state.stopped, 0);
});

test("process IPC send failure stops child and returns recoverable error", async () => {
  const { run, state } = await parserHarness({ sendError: true });
  await assert.rejects(run(Buffer.from("bytes"), "source.pdf"), (error) => error.status === 503 && /接收文件/.test(error.message) && !/sensitive/.test(error.message));
  assert.equal(state.stopped, 1);
  assert.deepEqual(state.cleared, ["document-timer"]);
});

test("real isolated PDF parser succeeds ten consecutive times without native crash in parent", async () => {
  for (let index = 0; index < 10; index += 1) {
    const result = await extractDocumentText(file(`repeat-${index}.pdf`, pdf({ text: `REPEAT ${index}` })));
    assert.ok(result.text.includes(`REPEAT ${index}`));
  }
});

async function extractionServer(t) {
  let calls = 0;
  const app = express();
  app.use("/api/text", textServiceRouter({ fetchImpl: async () => { calls += 1; throw new Error("Extraction must not call upstream"); } }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return {
    calls: () => calls,
    send: async (name, buffer, field = "file") => {
      const form = new FormData();
      if (name) form.append(field, new Blob([buffer]), name);
      return fetch(`http://127.0.0.1:${server.address().port}/api/text/extract`, { method: "POST", body: form });
    },
  };
}

test("multipart extract returns local DOCX/PDF text without a text key or upstream request", async (t) => {
  const server = await extractionServer(t);
  const word = await server.send("script.docx", await docx("本地提取无需扣费"));
  assert.equal(word.status, 200);
  assert.equal(word.headers.get("cache-control"), "no-store");
  assert.deepEqual(await word.json(), { name: "script.docx", text: "本地提取无需扣费" });
  const document = await server.send("script.pdf", pdf());
  assert.equal(document.status, 200);
  assert.ok((await document.json()).text.includes("HELLO LOCAL PDF"));
  assert.equal(server.calls(), 0);
});

test("multipart extract validates missing/unsupported/wrong-field/oversized uploads locally", async (t) => {
  const server = await extractionServer(t);
  for (const result of [await server.send(), await server.send("old.doc", Buffer.from("DOC")), await server.send("file.pdf", pdf(), "other")]) {
    assert.equal(result.status, 400);
    assert.equal(typeof (await result.json()).error.message, "string");
  }
  const large = await server.send("large.pdf", Buffer.alloc(TEXT_DOCUMENT_MAX_BYTES + 1));
  assert.equal(large.status, 413);
  assert.match((await large.json()).error.message, /10 MiB/);
  assert.equal(server.calls(), 0);
});
