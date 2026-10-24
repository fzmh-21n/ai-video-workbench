import assert from "node:assert/strict";
import test from "node:test";

import { TEXT_PROTOCOLS, buildTextRequest, createTextStreamParser, normalizeTextModels, parseTextResult, readTextResponse, textServiceError } from "../src/textService.js";
import { TEXT_IMAGE_MAX_BYTES, TEXT_REQUEST_MAX_BYTES } from "../src/textAttachments.js";

const sse = (body, event = "") => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(body)}\n\n`;

test("normalizes public aliases, preserves case and deduplicates model and protocol IDs", () => {
  assert.deepEqual(TEXT_PROTOCOLS.map((item) => item.id), ["responses", "messages", "chat/completions"]);
  assert.deepEqual(normalizeTextModels({ data: [
    { publicAlias: " Public-X ", id: "private-id", name: "公开模型", protocols: ["responses", " responses ", "unknown", null], capabilities: { maxOutputTokens: 8000, defaultMaxOutputTokens: 2000 } },
    { id: "Public-X", name: "重复" }, { id: "public-x" }, { name: "NameOnly", protocols: "messages" }, {},
  ] }), [
    { id: "Public-X", name: "公开模型", protocols: ["responses"], maxOutputTokens: 8000, defaultMaxOutputTokens: 2000 },
    { id: "public-x", name: "public-x", protocols: [], maxOutputTokens: null, defaultMaxOutputTokens: null },
    { id: "NameOnly", name: "NameOnly", protocols: [], maxOutputTokens: null, defaultMaxOutputTokens: null },
  ]);
  assert.equal(normalizeTextModels({ models: [{ id: "other", capabilities: { maxOutputTokens: "100", defaultMaxOutputTokens: -1 } }] })[0].maxOutputTokens, 100);
  assert.equal(normalizeTextModels({ models: [{ id: "other", capabilities: { defaultMaxOutputTokens: -1 } }] })[0].defaultMaxOutputTokens, null);
  assert.deepEqual(normalizeTextModels({}), []);
});

test("builds only the selected native protocol without rewriting the prompt", () => {
  const input = { model: " Model-X ", prompt: "  你好\n原文  ", maxOutputTokens: 100 };
  assert.deepEqual(buildTextRequest({ ...input, protocol: "responses" }), { model: "Model-X", stream: true, input: input.prompt, max_output_tokens: 100, store: false });
  assert.deepEqual(buildTextRequest({ ...input, protocol: "messages" }), { model: "Model-X", stream: true, messages: [{ role: "user", content: input.prompt }], max_tokens: 100 });
  assert.deepEqual(buildTextRequest({ ...input, protocol: "chat/completions" }), { model: "Model-X", stream: true, messages: [{ role: "user", content: input.prompt }], max_tokens: 100, stream_options: { include_usage: true } });
});

test("uses only explicit image capability metadata and never guesses from model names", () => {
  const models = normalizeTextModels({ data: [
    { id: "vision-name-only" },
    { id: "no-images", capabilities: { vision: false }, input_modalities: ["text", "image"] },
    { id: "supports-vision", capabilities: { supportsVision: true } },
    { id: "image-input", capabilities: { imageInput: false } },
    { id: "modalities", input_modalities: ["text", "image"] },
    { id: "text-only", input_modalities: ["text"] },
    { id: "unknown", capabilities: { vision: "unknown" } },
    { id: "empty-modalities", input_modalities: [] },
  ] });
  assert.equal(Object.hasOwn(models[0], "supportsImages"), false);
  assert.deepEqual(models.slice(1).map((model) => model.supportsImages), [false, true, false, true, false, null, null]);
});

test("includes named extracted text attachments verbatim without changing the original prompt or objects", () => {
  const prompt = "  对照附件回答\n原问题  ";
  const attachments = Object.freeze([
    Object.freeze({ id: "a", name: "原稿.docx", kind: "text", text: "  原文第一行\r\n第二行\n  ", size: 50 }),
    Object.freeze({ id: "b", name: "数据.json", kind: "text", text: '{"原始": "不重排"}', size: 24 }),
  ]);
  for (const protocol of TEXT_PROTOCOLS.map((item) => item.id)) {
    const body = buildTextRequest({ model: "model", protocol, prompt, maxOutputTokens: 50, attachments });
    const combined = protocol === "responses" ? body.input : body.messages[0].content;
    assert.equal(typeof combined, "string");
    assert.ok(combined.startsWith(prompt));
    for (const attachment of attachments) {
      assert.ok(combined.includes(attachment.name));
      assert.ok(combined.includes(attachment.text));
    }
    assert.ok(combined.indexOf("原稿.docx") < combined.indexOf("数据.json"));
  }
  assert.equal(attachments[0].text, "  原文第一行\r\n第二行\n  ");
  assert.throws(() => buildTextRequest({ model: "m", protocol: "responses", prompt: "", maxOutputTokens: 1, attachments }), /提示词/);
});

test("builds native multimodal content for each protocol without treating image bytes as text", () => {
  const image = { id: "picture", name: "参考.png", kind: "image", size: 8, dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
  const input = { model: "model", prompt: "看图", maxOutputTokens: 20, attachments: [image] };
  assert.deepEqual(buildTextRequest({ ...input, protocol: "responses" }).input, [{ role: "user", content: [
    { type: "input_text", text: "看图" }, { type: "input_text", text: "图片附件：参考.png" }, { type: "input_image", image_url: image.dataUrl },
  ] }]);
  assert.deepEqual(buildTextRequest({ ...input, protocol: "messages" }).messages, [{ role: "user", content: [
    { type: "text", text: "看图" }, { type: "text", text: "图片附件：参考.png" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
  ] }]);
  assert.deepEqual(buildTextRequest({ ...input, protocol: "chat/completions" }).messages, [{ role: "user", content: [
    { type: "text", text: "看图" }, { type: "text", text: "图片附件：参考.png" }, { type: "image_url", image_url: { url: image.dataUrl } },
  ] }]);
  for (const [mime, data] of [["image/jpeg", "/9j/"], ["image/webp", "UklGRgQAAABXRUJQ"]]) {
    const body = buildTextRequest({ ...input, protocol: "messages", attachments: [{ ...image, dataUrl: `data:${mime};base64,${data}` }] });
    assert.equal(body.messages[0].content[2].source.media_type, mime);
    assert.equal(body.messages[0].content[2].source.data, data);
  }
  const mixed = buildTextRequest({ ...input, protocol: "responses", attachments: [{ name: "说明.txt", kind: "text", text: "原始说明" }, image] });
  assert.ok(mixed.input[0].content[0].text.includes("说明.txt"));
  assert.ok(mixed.input[0].content[0].text.includes("原始说明"));
  assert.equal(mixed.input[0].content[0].text.includes("iVBOR"), false);
  for (const protocol of TEXT_PROTOCOLS.map((item) => item.id)) {
    const body = buildTextRequest({ ...input, protocol, attachments: [
      { ...image, name: "第二张.png" }, { ...image, name: "第一张.png" },
    ] });
    const content = protocol === "responses" ? body.input[0].content : body.messages[0].content;
    assert.equal(content[1].text, "图片附件：第二张.png");
    assert.equal(content[3].text, "图片附件：第一张.png");
    assert.deepEqual(content.slice(1).map((item) => item.type), protocol === "responses"
      ? ["input_text", "input_image", "input_text", "input_image"]
      : ["text", protocol === "messages" ? "image" : "image_url", "text", protocol === "messages" ? "image" : "image_url"]);
  }
});

test("rejects invalid attachment payloads and oversize serialized UTF-8 requests without truncating", () => {
  const valid = { model: "model", protocol: "responses", prompt: "问题", maxOutputTokens: 20 };
  assert.throws(() => buildTextRequest({ ...valid, attachments: {} }), /列表/);
  for (const attachment of [
    { kind: "text", text: "没有名字" }, { name: "原稿.docx", kind: "document" },
    { name: "data.txt", kind: "text", text: new Uint8Array([1]) },
    { name: "图片.png", kind: "image", dataUrl: "https://example.test/image.png" },
    { name: "图片.bmp", kind: "image", dataUrl: "data:image/bmp;base64,AAAA" },
    { name: "图片.png", kind: "image", dataUrl: "data:image/png;base64,broken" },
  ]) assert.throws(() => buildTextRequest({ ...valid, attachments: [attachment] }), /附件|图片/);
  assert.throws(() => buildTextRequest({ ...valid, prompt: "中".repeat(Math.ceil(TEXT_REQUEST_MAX_BYTES / 3)) }), /20 MiB/);
  const text = "x".repeat(TEXT_REQUEST_MAX_BYTES / 2);
  assert.throws(() => buildTextRequest({ ...valid, attachments: [
    { name: "第一份.txt", kind: "text", text }, { name: "第二份.txt", kind: "text", text },
  ] }), /20 MiB/);
  assert.equal(text.length, TEXT_REQUEST_MAX_BYTES / 2);
  const image = { name: "图片.png", kind: "image", size: TEXT_IMAGE_MAX_BYTES, dataUrl: `data:image/png;base64,${"A".repeat(4 * Math.ceil(TEXT_IMAGE_MAX_BYTES / 3))}` };
  assert.throws(() => buildTextRequest({ ...valid, attachments: [image, image, image] }), /20 MiB/);
});

test("rejects missing protocol, prompt, model and invalid output token counts", () => {
  const valid = { model: "model", protocol: "responses", prompt: "内容", maxOutputTokens: 20 };
  for (const maxOutputTokens of [undefined, 0, -1, 1.5, NaN, Infinity, "20"]) assert.throws(() => buildTextRequest({ ...valid, maxOutputTokens }), /正整数/);
  assert.throws(() => buildTextRequest({ ...valid, protocol: "" }), /协议/);
  assert.throws(() => buildTextRequest({ ...valid, prompt: " \n " }), /提示词/);
  assert.throws(() => buildTextRequest({ ...valid, model: "" }), /模型/);
});

test("parses split CRLF and multiline SSE data without fabricating usage or EOF completion", () => {
  const updates = [];
  const parser = createTextStreamParser("chat/completions", (result) => updates.push(result));
  parser.push(': heartbeat\r\ndata: {\r');
  parser.push('\ndata: "choices": [{"delta":{"content":"你好"}}]\r\ndata: }\r\n\r');
  parser.push("\n");
  assert.equal(parser.result().text, "你好");
  assert.equal(parser.finish().complete, false);
  assert.equal(parser.result().usage, null);
  assert.equal(parser.result().error, "");
  assert.equal(updates[0].text, "你好");
});

test("requires each native terminal instead of accepting ChatCompletions DONE for other protocols", () => {
  const responses = createTextStreamParser("responses");
  responses.push(sse({ type: "response.output_text.delta", delta: "响应部分" }) + "data: [DONE]\n\n");
  assert.equal(responses.finish().complete, false);
  assert.equal(responses.result().error, "");
  const messages = createTextStreamParser("messages");
  messages.push(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "消息部分" } }) + "data: [DONE]\n\n");
  assert.equal(messages.finish().complete, false);
  messages.push(sse({ type: "message_stop" }));
  assert.equal(messages.result().complete, true);
});

test("keeps Responses deltas separate from reasoning and does not duplicate completed snapshots", () => {
  const parser = createTextStreamParser("responses");
  parser.push(sse({ type: "response.output_text.delta", delta: "答案" }));
  parser.push(sse({ type: "response.reasoning_summary_text.delta", delta: "摘要" }));
  parser.push(sse({ type: "response.reasoning.delta", delta: "不可展示" }));
  parser.push(sse({ type: "response.completed", response: { output: [
    { type: "message", content: [{ type: "output_text", text: "答案" }] },
    { type: "reasoning", summary: [{ type: "summary_text", text: "摘要" }], encrypted_content: "不可展示" },
  ], usage: { input_tokens: 8, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } } } }));
  const result = parser.finish();
  assert.equal(result.text, "答案");
  assert.equal(result.reasoning, "摘要");
  assert.equal(result.complete, true);
  assert.deepEqual(result.usage, { input_tokens: 8, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } });
});

test("keeps partial Responses output on incomplete or failed terminals and never marks them successful", () => {
  for (const [type, response, message] of [
    ["response.incomplete", { incomplete_details: { reason: "max_output_tokens" } }, /输出上限/],
    ["response.failed", { error: { code: "server_error", message: "服务失败" } }, /服务失败/],
  ]) {
    const parser = createTextStreamParser("responses");
    parser.push(sse({ type: "response.output_text.delta", delta: "已有部分" }));
    parser.push(sse({ type, response }));
    parser.push("data: [DONE]\n\n");
    assert.equal(parser.result().text, "已有部分");
    assert.equal(parser.result().complete, false);
    assert.match(parser.result().error, message);
  }
});

test("uses a final Responses snapshot to fill missing text without appending repeated deltas", () => {
  const parser = createTextStreamParser("responses");
  parser.push(sse({ type: "response.output_text.delta", delta: "前段" }));
  parser.push(sse({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "前段后段" }] }] } }));
  assert.equal(parser.finish().text, "前段后段");
  const failed = parseTextResult("responses", { status: "failed", error: { code: "server_error", message: "服务失败" }, output: [{ type: "message", content: [{ type: "output_text", text: "失败前的部分" }] }] });
  assert.equal(failed.text, "失败前的部分");
  assert.equal(failed.complete, false);
  assert.equal(failed.error, "server_error: 服务失败");
});

test("combines Messages start and delta usage including cache details and keeps thinking out of answer text", () => {
  const parser = createTextStreamParser("messages");
  parser.push(sse({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 4, cache_creation: { ephemeral_5m_input_tokens: 2 } } } }));
  parser.push(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "正文" } }));
  parser.push(sse({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "思考" } }));
  parser.push(sse({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "工具内容" } }));
  parser.push(sse({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 3 } } }));
  parser.push(sse({ type: "message_stop" }));
  assert.deepEqual(parser.finish(), {
    text: "正文", reasoning: "思考", complete: true, error: "", stopReason: "max_tokens",
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 4, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 } },
  });
});

test("parses ChatCompletions reasoning, terminal usage and DONE with length stop reason", () => {
  const parser = createTextStreamParser("chat/completions");
  parser.push(sse({ choices: [{ delta: { content: "正文", reasoning_content: "推理", tool_calls: [{ function: { arguments: "不能显示为正文" } }] } }] }));
  parser.push(sse({ choices: [{ delta: {}, finish_reason: "length" }] }));
  parser.push(sse({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, completion_tokens_details: { reasoning_tokens: 1 } } }));
  parser.push("data: [DONE]");
  const result = parser.finish();
  assert.equal(result.complete, true);
  assert.equal(result.stopReason, "length");
  assert.equal(result.text, "正文");
  assert.equal(result.reasoning, "推理");
  assert.deepEqual(result.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, completion_tokens_details: { reasoning_tokens: 1 } });
});

test("keeps native SSE errors terminal but throws malformed data as unknown", () => {
  const parser = createTextStreamParser("messages");
  parser.push(sse({ error: { code: "overloaded", message: "服务繁忙" } }, "error"));
  parser.push(sse({ type: "message_stop" }));
  assert.equal(parser.result().complete, false);
  assert.equal(parser.result().error, "overloaded: 服务繁忙");
  assert.equal(parser.hasTerminal(), true);
  const malformed = createTextStreamParser("responses");
  assert.throws(() => malformed.push("data: <html>错误页面</html>\n\ndata: [DONE]\n\n"), /无法解析/);
  assert.equal(malformed.result().complete, false);
  assert.equal(malformed.result().error, "");
  assert.equal(malformed.hasTerminal(), false);
});

test("parses native JSON content arrays without exposing tools or encrypted reasoning", () => {
  const responses = parseTextResult("responses", { status: "completed", output: [
    { type: "function_call", arguments: "工具输出" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "答复" }, { type: "image", text: "不是文字" }] },
    { type: "reasoning", encrypted_content: "密文", summary: [{ type: "summary_text", text: "可见摘要" }] },
  ] });
  assert.equal(responses.text, "答复");
  assert.equal(responses.reasoning, "可见摘要");
  assert.equal(responses.complete, true);
  assert.equal(responses.usage, null);
  const messages = parseTextResult("messages", { stop_reason: "end_turn", content: [
    { type: "text", text: "第一段" }, { type: "tool_use", input: "工具数据" },
    { type: "text", text: "第二段" }, { type: "thinking", thinking: "思考" }, { type: "redacted_thinking", data: "密文" },
  ] });
  assert.equal(messages.text, "第一段第二段");
  assert.equal(messages.reasoning, "思考");
  const chat = parseTextResult("chat/completions", { choices: [{ finish_reason: "stop", message: { content: [{ type: "text", text: "答复" }], reasoning_content: "推理" } }] });
  assert.equal(chat.text, "答复");
  assert.equal(chat.complete, true);
});

test("retains native JSON errors and does not invent a terminal state", () => {
  assert.equal(textServiceError({ error: { code: "invalid_key", message: "密钥无效" } }), "invalid_key: 密钥无效");
  assert.equal(textServiceError({ message: "服务错误" }), "服务错误");
  assert.equal(textServiceError("普通错误"), "普通错误");
  assert.equal(textServiceError("<html>错误页面</html>"), "文字服务返回了非 JSON 错误页面");
  assert.equal(textServiceError({ error: { message: "<body>错误页面</body>" } }), "文字服务返回了非 JSON 错误页面");
  assert.equal(parseTextResult("responses", { error: { message: "失败" } }).complete, false);
  assert.equal(parseTextResult("chat/completions", { choices: [{ message: { content: "未完成" } }] }).complete, false);
  assert.equal(parseTextResult("messages", { content: [{ type: "text", text: "未完成" }] }).complete, false);
});

test("reads streamed UTF-8 bytes across multibyte splits and emits full snapshots", async () => {
  const bytes = new TextEncoder().encode(sse({ choices: [{ delta: { content: "你好🙂" } }] }) + "data: [DONE]\n\n");
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
  const changes = [];
  const result = await readTextResponse(response, "chat/completions", (snapshot) => changes.push(snapshot));
  assert.equal(result.text, "你好🙂");
  assert.equal(result.complete, true);
  assert.equal(changes[0].text, "你好🙂");
  assert.equal(changes.at(-1).complete, true);
});

test("returns clean unfinished SSE EOF as unknown rather than success or failure", async () => {
  const response = new Response(sse({ type: "response.output_text.delta", delta: "未完" }), { headers: { "content-type": "text/event-stream" } });
  const result = await readTextResponse(response, "responses");
  assert.equal(result.text, "未完");
  assert.equal(result.complete, false);
  assert.equal(result.error, "");
});

test("throws reader errors after preserving partial callback snapshots", async () => {
  let pulls = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(sse({ type: "response.output_text.delta", delta: "已有部分" })));
    else controller.error(new Error("连接中断"));
  } }), { headers: { "content-type": "text/event-stream" } });
  const changes = [];
  await assert.rejects(readTextResponse(response, "responses", (result) => changes.push(result)), /连接中断/);
  assert.equal(changes.at(-1).text, "已有部分");
  assert.equal(changes.at(-1).complete, false);
});

test("reads native JSON fallback and preserves HTTP error status and code", async () => {
  const success = new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "JSON 答复" }], usage: { input_tokens: 2, output_tokens: 3 } }), { headers: { "content-type": "application/json" } });
  assert.equal((await readTextResponse(success, "messages")).text, "JSON 答复");
  const expired = new Response(JSON.stringify({ error: { code: "expired", message: "资源已过期" } }), { status: 410, headers: { "content-type": "application/json" } });
  await assert.rejects(readTextResponse(expired, "responses"), (error) => error.status === 410 && error.code === "expired" && error.message === "expired: 资源已过期");
  await assert.rejects(readTextResponse(new Response(null, { status: 204 }), "responses"), (error) => !error.status && /没有返回/.test(error.message));
});

test("does not swallow a JSON response body reader failure or display HTML as an answer", async () => {
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error("JSON 连接中断")); } }), { headers: { "content-type": "application/json" } });
  await assert.rejects(readTextResponse(broken, "responses"), /JSON 连接中断/);
  await assert.rejects(readTextResponse(new Response("<html>内部错误</html>", { headers: { "content-type": "text/html" } }), "responses"), (error) => !error.status && /JSON/.test(error.message));
  const changes = [];
  const malformed = new Response(sse({ type: "response.output_text.delta", delta: "已有部分" }) + "data: <html>错误</html>\n\n", { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(readTextResponse(malformed, "responses", (result) => changes.push(result)), (error) => !error.status && /无法解析/.test(error.message));
  assert.equal(changes.at(-1).text, "已有部分");
  assert.equal(changes.at(-1).error, "");
});

function disconnectAfter(payload) {
  let sent = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (!sent) {
      sent = true;
      controller.enqueue(new TextEncoder().encode(payload));
    } else controller.error(new Error("终态后的连接中断"));
  } }), { headers: { "content-type": "text/event-stream" } });
}

test("retains trusted success when the socket disconnects after a native terminal", async () => {
  for (const [protocol, payload] of [
    ["responses", sse({ type: "response.completed", response: { output_text: "完整答复", usage: { output_tokens: 2 } } })],
    ["messages", sse({ type: "content_block_delta", delta: { type: "text_delta", text: "完整答复" } }) + sse({ type: "message_stop" })],
    ["chat/completions", sse({ choices: [{ delta: { content: "完整答复" } }] }) + "data: [DONE]\n\n"],
  ]) {
    const result = await readTextResponse(disconnectAfter(payload), protocol);
    assert.equal(result.text, "完整答复");
    assert.equal(result.complete, true);
    assert.equal(result.error, "");
  }
});

test("retains native failed or incomplete terminals after a trailing socket disconnect", async () => {
  for (const [protocol, payload, expected] of [
    ["responses", sse({ type: "response.failed", response: { error: { code: "server_error", message: "明确失败" } } }), /明确失败/],
    ["responses", sse({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }), /输出上限/],
    ["messages", sse({ type: "error", error: { type: "overloaded_error", message: "明确失败" } }), /明确失败/],
    ["chat/completions", sse({ error: { code: "server_error", message: "明确失败" } }), /明确失败/],
  ]) {
    const result = await readTextResponse(disconnectAfter(payload), protocol);
    assert.equal(result.complete, false);
    assert.match(result.error, expected);
  }
});
