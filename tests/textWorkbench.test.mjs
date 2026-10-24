import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { TEXT_PROTOCOLS, buildTextRequest, readTextResponse } from "../src/textService.js";
import { TEXT_ATTACHMENT_MAX_BYTES, TEXT_REQUEST_MAX_BYTES, attachmentKind, readTextAttachment } from "../src/textAttachments.js";

const source = readFileSync(new URL("../src/TextWorkbench.jsx", import.meta.url), "utf8");
const request = { apiKey: "sk_txt_mock", protocol: "responses", idempotencyKey: "same-request", body: { model: "text-model", input: "原始文本", stream: true } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "upstream-id" } });

test("model refresh and model changes preserve an explicit protocol when metadata is absent, without guessing", () => {
  const rows = [{ id: "unknown-a", protocols: [] }, { id: "unknown-b", protocols: [] }, { id: "known", protocols: ["responses"] }];
  const state = {};
  const ctx = vm.createContext({
    models: rows, protocol: "messages", TEXT_PROTOCOLS,
    setModel: (value) => { state.model = value; },
    setProtocol: (value) => { state.protocol = value; ctx.protocol = value; }, setMaxOutputTokens: () => {},
  });
  vm.runInContext(source.slice(source.indexOf("  function chooseModel("), source.indexOf("  async function loadModels(")), ctx);
  ctx.chooseModel("unknown-a", rows, "messages");
  assert.equal(state.protocol, "messages");
  ctx.chooseModel("unknown-b");
  assert.equal(state.protocol, "messages");
  ctx.chooseModel("known");
  assert.equal(state.protocol, "responses");
  ctx.chooseModel("unknown-a", rows, "not-a-protocol");
  assert.equal(state.protocol, "");
  ctx.chooseModel("unknown-b", rows, "");
  assert.equal(state.protocol, "");
});

test("disabled submit always explains its blocking condition, including the reported missing protocol", () => {
  const start = source.indexOf("  const submitDisabledReason =");
  const end = source.indexOf(";", start);
  assert.ok(start > 0);
  const defaults = { busy: false, readingFiles: false, loadingModels: false, modelRow: { id: "model" }, protocols: [{ id: "messages" }], protocol: "messages", prompt: "已填写需求" };
  const cases = [
    [{ protocol: "" }, /请选择.*接口协议/], [{ prompt: " \n " }, /填写.*需求/], [{ modelRow: undefined }, /读取.*模型/],
    [{ readingFiles: true }, /读取附件/], [{ loadingModels: true }, /读取模型/], [{ busy: true }, /推理.*进行中/],
    [{ protocol: "responses" }, /请选择.*接口协议/],
  ];
  for (const [changes, expected] of cases) {
    const ctx = vm.createContext({ ...defaults, ...changes });
    const reason = vm.runInContext(`${source.slice(start, end + 1)}\nsubmitDisabledReason`, ctx);
    assert.match(reason, expected);
  }
  assert.equal(vm.runInContext(`${source.slice(start, end + 1)}\nsubmitDisabledReason`, vm.createContext(defaults)), "");
});

test("missing protocol or requirement never sends inference; selecting Messages unlocks the native request", () => {
  const sent = [];
  let notice = "";
  const ctx = vm.createContext({
    inFlightRef: { current: false }, readingFilesRef: { current: false }, loadingModels: false, attachments: [], apiKey: "sk_txt_mock", normalizeApiKey: (value) => value,
    modelRow: { id: "claude", maxOutputTokens: null }, model: "claude", protocols: TEXT_PROTOCOLS, protocol: "", prompt: "已填写需求", maxOutputTokens: 256,
    buildTextRequest, status: "idle", crypto: { randomUUID: () => "new-id" }, runRequest: (value) => sent.push(value), setNotice: (value) => { notice = value; },
  });
  vm.runInContext(source.slice(source.indexOf("  function submit("), source.indexOf("  async function copyAnswer(")), ctx);
  ctx.submit({ preventDefault() {} });
  assert.match(notice, /协议/);
  assert.equal(sent.length, 0);
  ctx.protocol = "messages";
  ctx.prompt = "  ";
  ctx.submit({ preventDefault() {} });
  assert.match(notice, /提示词/);
  assert.equal(sent.length, 0);
  ctx.prompt = "已填写需求";
  ctx.loadingModels = true;
  ctx.submit({ preventDefault() {} });
  assert.equal(sent.length, 0);
  ctx.loadingModels = false;
  ctx.submit({ preventDefault() {} });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].protocol, "messages");
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].body.messages)), [{ role: "user", content: "已填写需求" }]);
});

function context(fetchImpl) {
  const state = {};
  const ctx = vm.createContext({
    fetch: fetchImpl, readTextResponse, AbortController, crypto: { randomUUID: () => "new-id" },
    EMPTY_RESULT: { text: "", reasoning: "", usage: null, complete: false, error: "", stopReason: "" },
    inFlightRef: { current: false }, readingFilesRef: { current: false }, controllerRef: { current: null }, originalRequestRef: { current: null },
    ...Object.fromEntries(["Busy", "Status", "CanRecover", "Notice", "Result", "RequestInfo"].map((name) => [`set${name}`, (value) => { state[name] = value; }])),
  });
  const start = source.indexOf("  async function runRequest(");
  const end = source.indexOf("  function submit(", start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(source.slice(start, end), ctx);
  return { ctx, state };
}

test("text UI synchronous lock prevents duplicate paid POST while first request is pending", async () => {
  const calls = [];
  let resolve;
  const { ctx, state } = context(async (...args) => { calls.push(args); return new Promise((done) => { resolve = done; }); });
  const pending = ctx.runRequest(request);
  await ctx.runRequest(request);
  assert.equal(calls.length, 1);
  assert.equal(state.Busy, true);
  resolve(json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "回答" }] }] }));
  await pending;
  assert.equal(state.Status, "completed");
  assert.equal(state.Result.text, "回答");
  assert.equal(ctx.inFlightRef.current, false);
  assert.equal(calls[0][0], "/api/text/responses");
  assert.equal(calls[0][1].headers["x-text-api-key"], request.apiKey);
  assert.equal(calls[0][1].headers["Idempotency-Key"], request.idempotencyKey);
});

test("network loss does not resend; explicit recovery uses captured original key and parameters", async () => {
  const calls = [];
  const { ctx, state } = context(async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw new Error("network lost");
    return json({ status: "completed", output_text: "恢复后的回答" });
  });
  await ctx.runRequest(request);
  assert.equal(calls.length, 1);
  assert.equal(state.Status, "uncertain");
  assert.equal(state.CanRecover, true);
  await ctx.runRequest(ctx.originalRequestRef.current, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].body, calls[1][1].body);
  assert.deepEqual(calls[0][1].headers, calls[1][1].headers);
  assert.equal(state.Status, "completed");
});

test("stopping receipt preserves recovery without claiming the paid generation was cancelled", async () => {
  let calls = 0;
  const { ctx, state } = context(async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  const pending = ctx.runRequest(request);
  ctx.controllerRef.current.abort();
  await pending;
  assert.equal(calls, 1);
  assert.equal(state.Status, "uncertain");
  assert.equal(state.CanRecover, true);
  assert.match(state.Notice, /不等于取消上游/);
});

test("expired recovery cache is final and cannot silently trigger another generation", async () => {
  let calls = 0;
  const { ctx, state } = context(async () => { calls++; return json({ error: { code: "TEXT_RESPONSE_UNAVAILABLE", message: "expired" } }, 410); });
  await ctx.runRequest(request, true);
  assert.equal(calls, 1);
  assert.equal(state.Status, "failed");
  assert.equal(state.CanRecover, false);
  assert.match(state.Notice, /原账单/);
});

test("HTTP timeout preserves uncertainty and the original request for safe recovery", async () => {
  let calls = 0;
  const { ctx, state } = context(async () => { calls++; return json({ error: { message: "upstream timeout" } }, 408); });
  await ctx.runRequest(request);
  assert.equal(calls, 1);
  assert.equal(state.Status, "uncertain");
  assert.equal(state.CanRecover, true);
  assert.equal(ctx.originalRequestRef.current, request);
});

test("clean EOF without a native terminal remains uncertain, not completed", async () => {
  const { ctx, state } = context(async () => new Response('data: {"type":"response.output_text.delta","delta":"部分回答"}\n\n', { headers: { "content-type": "text/event-stream" } }));
  await ctx.runRequest(request);
  assert.equal(state.Result.text, "部分回答");
  assert.equal(state.Status, "uncertain");
  assert.equal(state.CanRecover, true);
});

test("a new request uses a new identifier; uncertain prior generation requires explicit confirmation", () => {
  let sent = [];
  let confirmations = 0;
  let allowed = true;
  let id = 0;
  let notice = "";
  const ctx = vm.createContext({
    inFlightRef: { current: false }, readingFilesRef: { current: false }, loadingModels: false, attachments: [], apiKey: "sk_txt_mock", normalizeApiKey: (value) => value,
    modelRow: { maxOutputTokens: 8192 }, model: "model", protocols: [{ id: "responses" }], protocol: "responses", prompt: "问题", maxOutputTokens: "256",
    buildTextRequest, status: "completed", crypto: { randomUUID: () => `new-${++id}` },
    window: { confirm: () => { confirmations++; return allowed; } }, runRequest: (value) => sent.push(value), setNotice: (value) => { notice = value; },
  });
  const start = source.indexOf("  function submit(");
  const end = source.indexOf("  async function copyAnswer(", start);
  vm.runInContext(source.slice(start, end), ctx);
  ctx.submit({ preventDefault() {} });
  ctx.submit({ preventDefault() {} });
  assert.equal(sent[0].body.max_output_tokens, 256);
  assert.notEqual(sent[0].idempotencyKey, sent[1].idempotencyKey);
  ctx.status = "uncertain";
  allowed = false;
  ctx.submit({ preventDefault() {} });
  assert.equal(sent.length, 2);
  assert.equal(confirmations, 1);
  ctx.status = "completed";
  ctx.modelRow.supportsImages = false;
  ctx.attachments = [{ name: "角色.png", kind: "image", dataUrl: "data:image/png;base64,AQID" }];
  ctx.submit({ preventDefault() {} });
  assert.equal(sent.length, 2);
  assert.match(notice, /不支持图片/);
});

test("text stays mounted alongside media and its proxy stays behind authentication outside media diagnostics", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /<div hidden=\{generationMode !== "text"\}>\s*<TextWorkbench/);
  assert.match(app, /<div hidden=\{generationMode !== "video"\}>\s*<Workbench/);
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(!server.includes('app.use("/api/text", express.json'));
  assert.ok(server.indexOf('if (!renewSession(req, res))') < server.indexOf('app.use("/api/text", textServiceRouter())'));
  assert.ok(server.indexOf('app.use("/api/text", textServiceRouter())') < server.indexOf('req.diagnostic ='));
});

test("text attachments skip the small global parser and reach their large parser only behind login", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  let middleware;
  let parsed = 0;
  let continued = 0;
  const ctx = vm.createContext({
    express: { json: (options) => { assert.equal(options.limit, "16kb"); return (_req, _res, next) => { parsed++; next(); }; } },
    app: { use: (fn) => { middleware = fn; } },
  });
  vm.runInContext(server.slice(server.indexOf("const parseSmallJson ="), server.indexOf('app.get("/api/health"')), ctx);
  for (const path of ["/api/text", "/api/text/responses", "/api/text/extract"]) middleware({ path }, {}, () => continued++);
  assert.equal(parsed, 0);
  for (const path of ["/api/auth/login", "/api/textual", "/api/tasks"]) middleware({ path }, {}, () => continued++);
  assert.equal(parsed, 3);
  assert.equal(continued, 6);
});

test("text panel renders its independent controls without a key or a ready-to-pay submit button", async () => {
  const previousLocal = globalThis.localStorage;
  const previousSession = globalThis.sessionStorage;
  globalThis.localStorage = { getItem: () => null };
  globalThis.sessionStorage = { getItem: () => null };
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  try {
    const { default: TextWorkbench } = await vite.ssrLoadModule("/src/TextWorkbench.jsx");
    const html = renderToStaticMarkup(React.createElement(TextWorkbench, {}));
    for (const label of ["AI 文本推理工作台", "文本专用 API Key", "接口协议", "最大输出 tokens", "推理结果", "回答将显示在这里。", "上传文件 / 图片", "DOCX", "PDF", "扫描版 PDF"])
      assert.ok(html.includes(label), label);
    assert.match(html, /type="file" multiple="" accept="[^"]*\.docx[^\"]*\.pdf[^\"]*\.png/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>开始推理<\/button>/);
    assert.ok(html.includes('id="text-submit-help"'));
    assert.ok(html.includes('aria-describedby="text-submit-help"'));
    assert.ok(!html.includes(">恢复原请求<"));
  } finally {
    await vite.close();
    if (previousLocal === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocal;
    if (previousSession === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSession;
  }
});

function attachmentContext(fetchImpl) {
  const state = {};
  const ctx = vm.createContext({
    fetch: fetchImpl, FormData, crypto, TextEncoder, TEXT_ATTACHMENT_MAX_BYTES, TEXT_REQUEST_MAX_BYTES, attachmentKind, readTextAttachment,
    textServiceError: (body) => body?.error?.message || "", inFlightRef: { current: false }, readingFilesRef: { current: false }, attachmentsRef: { current: [] },
    ...Object.fromEntries(["Attachments", "ReadingFiles", "Notice"].map((name) => [`set${name}`, (value) => { state[name] = value; }])),
  });
  const start = source.indexOf("  async function addFiles(");
  const end = source.indexOf("  async function runRequest(", start);
  vm.runInContext(source.slice(start, end), ctx);
  return { ctx, state };
}

test("selecting mixed attachments reads text locally, extracts documents locally and never calls paid inference", async () => {
  const calls = [];
  const { ctx, state } = attachmentContext(async (...args) => { calls.push(args); return json({ name: "剧本.docx", text: "提取的完整正文" }); });
  const text = new File(["中文文本"], "设定.txt");
  const doc = new File(["test doc"], "剧本.docx");
  const image = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "角色.png");
  const event = { target: { files: [text, doc, image], value: "selection" } };
  await ctx.addFiles(event);
  assert.equal(event.target.value, "");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/text/extract");
  assert.equal(calls[0][1].body.get("file").name, "剧本.docx");
  assert.equal(ctx.attachmentsRef.current.length, 3);
  assert.equal(state.Attachments[0].text, "中文文本");
  assert.equal(state.Attachments[1].text, "提取的完整正文");
  assert.match(state.Attachments[2].dataUrl, /^data:image\/png;base64,/);
  assert.equal(state.ReadingFiles, false);
  assert.equal(ctx.readingFilesRef.current, false);
  await ctx.addFiles({ target: { files: [text, doc, image], value: "again" } });
  assert.equal(ctx.attachmentsRef.current.length, 3);
  assert.equal(calls.length, 1);
});

test("one failed document does not discard successful attachments; removal clears only local selection", async () => {
  const { ctx, state } = attachmentContext(async () => json({ error: { message: "PDF 没有可提取的正文" } }, 400));
  await ctx.addFiles({ target: { files: [new File(["已有正文"], "设定.txt"), new File(["scan"], "scan.pdf"), new File(["old"], "old.doc")], value: "files" } });
  assert.equal(ctx.attachmentsRef.current.length, 1);
  assert.match(state.Notice, /没有可提取的正文/);
  assert.match(state.Notice, /旧版 DOC/);
  ctx.removeAttachment(ctx.attachmentsRef.current[0].id);
  assert.equal(state.Attachments.length, 0);
});

test("large multi-file selections stop adding at the total attachment budget without discarding prior files", async () => {
  const { ctx, state } = attachmentContext(async () => json({ text: "A".repeat(7 * 1024 * 1024) }));
  await ctx.addFiles({ target: { files: ["1.docx", "2.docx", "3.docx"].map((name) => new File(["doc"], name)), value: "files" } });
  assert.equal(ctx.attachmentsRef.current.length, 2);
  assert.match(state.Notice, /合计超过 20 MiB/);
  assert.equal(state.ReadingFiles, false);
});

test("attachment reading lock blocks a second selection and both paid submission and recovery", async () => {
  let resolve;
  let calls = 0;
  const { ctx, state } = attachmentContext(async () => { calls++; return new Promise((done) => { resolve = done; }); });
  const pending = ctx.addFiles({ target: { files: [new File(["doc"], "script.docx")], value: "file" } });
  assert.equal(ctx.readingFilesRef.current, true);
  await ctx.addFiles({ target: { files: [new File(["text"], "ignored.txt")], value: "file" } });
  assert.equal(calls, 1);
  const requestStart = source.indexOf("  async function runRequest(");
  const submitStart = source.indexOf("  function submit(", requestStart);
  const submitEnd = source.indexOf("  async function copyAnswer(", submitStart);
  vm.runInContext(source.slice(requestStart, submitEnd), ctx);
  ctx.submit({ preventDefault() {} });
  await ctx.runRequest(request, true);
  assert.equal(calls, 1);
  resolve(json({ text: "完成的正文" }));
  await pending;
  assert.equal(state.Attachments.length, 1);
  assert.equal(ctx.readingFilesRef.current, false);
});

test("recovery keeps the captured attachment payload even if the current input changes", async () => {
  const calls = [];
  const body = buildTextRequest({ model: "vision", protocol: "messages", prompt: "读附件", maxOutputTokens: 128, attachments: [{ name: "设定.txt", kind: "text", text: "原始附件" }, { name: "图.png", kind: "image", dataUrl: "data:image/png;base64,AQID" }] });
  const original = { ...request, protocol: "messages", body };
  const { ctx } = context(async (...args) => { calls.push(args); if (calls.length === 1) throw new Error("disconnected"); return json({ content: [{ type: "text", text: "恢复" }], stop_reason: "end_turn" }); });
  await ctx.runRequest(original);
  ctx.attachments = [];
  ctx.prompt = "修改后的问题";
  await ctx.runRequest(ctx.originalRequestRef.current, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].body, calls[1][1].body);
  assert.equal(calls[1][1].headers["Idempotency-Key"], original.idempotencyKey);
  assert.match(calls[1][1].body, /原始附件/);
});
