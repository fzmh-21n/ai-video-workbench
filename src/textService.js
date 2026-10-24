import { TEXT_REQUEST_MAX_BYTES } from "./textAttachments.js";

export const TEXT_PROTOCOLS = [
  { id: "responses", label: "Responses" },
  { id: "messages", label: "Messages" },
  { id: "chat/completions", label: "ChatCompletions" },
];

function requireProtocol(protocol) {
  if (!TEXT_PROTOCOLS.some((item) => item.id === protocol)) throw new Error("请选择有效的文字推理协议");
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function normalizeTextModels(body) {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const seen = new Set();
  return rows.flatMap((row) => {
    const id = String(row?.publicAlias || row?.id || row?.name || "").trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const capabilities = row?.capabilities || {};
    const imageFlags = [capabilities.vision, capabilities.supportsVision, capabilities.imageInput];
    const explicitImageFlag = imageFlags.find((value) => typeof value === "boolean");
    const modalities = row?.input_modalities ?? capabilities.input_modalities;
    const supportsImages = explicitImageFlag ?? (Array.isArray(modalities) && modalities.length
      ? modalities.includes("image") : null);
    const declaredImages = imageFlags.some((value) => value !== undefined) || Array.isArray(modalities);
    return [{
      id,
      name: String(row?.name || id).trim() || id,
      protocols: [...new Set((Array.isArray(row?.protocols) ? row.protocols : [])
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => TEXT_PROTOCOLS.some((item) => item.id === value)))],
      maxOutputTokens: positiveInteger(row?.capabilities?.maxOutputTokens ?? row?.maxOutputTokens),
      defaultMaxOutputTokens: positiveInteger(row?.capabilities?.defaultMaxOutputTokens ?? row?.defaultMaxOutputTokens),
      ...(declaredImages ? { supportsImages } : {}),
    }];
  });
}

export function buildTextRequest({ model, protocol, prompt, maxOutputTokens, attachments = [] }) {
  requireProtocol(protocol);
  if (typeof model !== "string" || !model.trim()) throw new Error("请选择文字模型");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("请输入文字提示词");
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new Error("最大输出 token 数必须是正整数");
  if (!Array.isArray(attachments)) throw new Error("文字附件列表格式无效");
  let combinedText = prompt;
  const images = [];
  for (const attachment of attachments) {
    if (typeof attachment?.name !== "string" || !attachment.name.trim()) throw new Error("附件缺少文件名");
    if (attachment.kind === "text" && typeof attachment.text === "string") {
      combinedText += `\n\n--- 附件：${attachment.name} ---\n${attachment.text}\n--- 附件结束：${attachment.name} ---`;
    } else if (attachment.kind === "image" && typeof attachment.dataUrl === "string") {
      const match = attachment.dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match || match[2].length % 4) throw new Error("图片附件必须是本地 PNG、JPEG 或 WEBP 的 base64 内容");
      images.push({ name: attachment.name, dataUrl: attachment.dataUrl, mime: match[1], data: match[2] });
    } else throw new Error("附件尚未提取为文字或有效图片");
  }
  const shared = { model: model.trim(), stream: true };
  let body;
  if (protocol === "responses") body = {
    ...shared,
    input: images.length ? [{ role: "user", content: [
      { type: "input_text", text: combinedText },
      ...images.flatMap((image) => [
        { type: "input_text", text: `图片附件：${image.name}` },
        { type: "input_image", image_url: image.dataUrl },
      ]),
    ] }] : combinedText,
    max_output_tokens: maxOutputTokens, store: false,
  };
  else body = {
    ...shared,
    messages: [{ role: "user", content: images.length ? [
      { type: "text", text: combinedText },
      ...images.flatMap((image) => [
        { type: "text", text: `图片附件：${image.name}` },
        protocol === "messages" ? { type: "image", source: { type: "base64", media_type: image.mime, data: image.data } }
          : { type: "image_url", image_url: { url: image.dataUrl } },
      ]),
    ] : combinedText }],
    max_tokens: maxOutputTokens,
    ...(protocol === "chat/completions" ? { stream_options: { include_usage: true } } : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > TEXT_REQUEST_MAX_BYTES) throw new Error("文字请求总大小不能超过 20 MiB");
  return body;
}

function emptyResult() {
  return { text: "", reasoning: "", usage: null, complete: false, error: "", stopReason: "" };
}

function contentText(value) {
  if (typeof value === "string") return value;
  return (Array.isArray(value) ? value : [])
    .filter((part) => part?.type === "text" || part?.type === "output_text")
    .map((part) => typeof part.text === "string" ? part.text : "").join("");
}

function mergeUsage(current, incoming) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return current;
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeUsage(current?.[key], value) : value;
  }
  return merged;
}

export function textServiceError(body) {
  if (typeof body === "string") return /<\/?[a-z][^>]*>|<!doctype/i.test(body) ? "文字服务返回了非 JSON 错误页面" : body.trim();
  const native = body?.error;
  const code = native && typeof native === "object" ? native.code || native.type : body?.code;
  const message = typeof native === "string" ? native
    : typeof native?.message === "string" ? native.message
      : typeof body?.message === "string" ? body.message : "";
  return [code, /<\/?[a-z][^>]*>|<!doctype/i.test(message) ? "文字服务返回了非 JSON 错误页面" : message].filter(Boolean).join(": ");
}

export function parseTextResult(protocol, body) {
  requireProtocol(protocol);
  const result = emptyResult();
  result.usage = mergeUsage(null, body?.usage);
  if (body?.error || body?.type === "error" || body?.ok === false) {
    result.error = textServiceError(body) || "文字推理失败";
  }
  if (protocol === "responses") {
    for (const item of Array.isArray(body?.output) ? body.output : []) {
      if (item?.type === "message" && (!item.role || item.role === "assistant")) result.text += contentText(item.content);
      if (item?.type === "reasoning") result.reasoning += (Array.isArray(item.summary) ? item.summary : [])
        .filter((part) => part?.type === "summary_text" && typeof part.text === "string")
        .map((part) => part.text).join("");
    }
    if (!result.text && typeof body?.output_text === "string") result.text = body.output_text;
    result.stopReason = body?.incomplete_details?.reason || body?.status || "";
    result.complete = body?.status === "completed" && !result.error;
    if (body?.status === "failed") result.error = textServiceError(body) || "文字推理失败";
    if (body?.status === "incomplete") result.error = result.stopReason === "max_output_tokens"
      ? "达到输出上限，响应未完成" : `响应未完成${result.stopReason ? `：${result.stopReason}` : ""}`;
  } else if (protocol === "messages") {
    result.text = contentText(body?.content);
    result.reasoning = (Array.isArray(body?.content) ? body.content : [])
      .filter((part) => part?.type === "thinking" && typeof part.thinking === "string")
      .map((part) => part.thinking).join("");
    result.stopReason = body?.stop_reason || "";
    result.complete = Boolean(result.stopReason) && !result.error;
  } else {
    const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
    result.text = contentText(choice?.message?.content);
    result.reasoning = typeof choice?.message?.reasoning_content === "string" ? choice.message.reasoning_content : "";
    result.stopReason = choice?.finish_reason || "";
    result.complete = Boolean(result.stopReason) && !result.error;
  }
  return result;
}

export function createTextStreamParser(protocol, onChange) {
  requireProtocol(protocol);
  const state = emptyResult();
  let buffer = "";
  let eventName = "";
  let data = [];
  let terminalReceived = false;
  const result = () => ({ ...state });
  const notify = () => { if (onChange) onChange(result()); };

  function dispatch() {
    const payload = data.join("\n");
    const event = eventName;
    data = [];
    eventName = "";
    if (!payload) return;
    if (payload.trim() === "[DONE]") {
      if (protocol === "chat/completions") {
        terminalReceived = true;
        state.complete = !state.error;
        notify();
      }
      return;
    }
    let body;
    try { body = JSON.parse(payload); }
    catch { throw new Error("文字流包含无法解析的数据"); }
    const type = body?.type || event;
    if (type === "error" || body?.error) {
      terminalReceived = true;
      state.error = textServiceError(body) || "文字推理失败";
      state.complete = false;
    } else if (protocol === "responses") {
      if (type === "response.output_text.delta" && typeof body.delta === "string") state.text += body.delta;
      if (type === "response.reasoning_summary_text.delta" && typeof body.delta === "string") state.reasoning += body.delta;
      if (type === "response.output_text.done" && !state.text && typeof body.text === "string") state.text = body.text;
      if (["response.completed", "response.failed", "response.incomplete"].includes(type)) {
        terminalReceived = true;
        const snapshot = parseTextResult(protocol, { ...body.response, status: type.slice("response.".length) });
        if (snapshot.text) state.text = snapshot.text;
        if (snapshot.reasoning) state.reasoning = snapshot.reasoning;
        state.usage = mergeUsage(state.usage, snapshot.usage);
        state.stopReason = snapshot.stopReason;
        state.error = state.error || snapshot.error;
        state.complete = snapshot.complete && !state.error;
      }
    } else if (protocol === "messages") {
      if (type === "message_start") state.usage = mergeUsage(state.usage, body.message?.usage);
      if (type === "content_block_start") {
        if (body.content_block?.type === "text") state.text += contentText([body.content_block]);
        if (body.content_block?.type === "thinking" && typeof body.content_block.thinking === "string") state.reasoning += body.content_block.thinking;
      }
      if (type === "content_block_delta") {
        if (body.delta?.type === "text_delta" && typeof body.delta.text === "string") state.text += body.delta.text;
        if (body.delta?.type === "thinking_delta" && typeof body.delta.thinking === "string") state.reasoning += body.delta.thinking;
      }
      if (type === "message_delta") {
        state.stopReason = body.delta?.stop_reason || state.stopReason;
        state.usage = mergeUsage(state.usage, body.usage);
      }
      if (type === "message_stop") {
        terminalReceived = true;
        state.complete = !state.error;
      }
    } else {
      const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
      state.text += contentText(choice?.delta?.content);
      if (typeof choice?.delta?.reasoning_content === "string") state.reasoning += choice.delta.reasoning_content;
      state.stopReason = choice?.finish_reason || state.stopReason;
      state.usage = mergeUsage(state.usage, body?.usage);
    }
    notify();
  }

  function consumeLine(line) {
    if (!line) return dispatch();
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }

  function push(text) {
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      consumeLine(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
    }
  }

  function finish() {
    if (buffer) consumeLine(buffer.replace(/\r$/, ""));
    buffer = "";
    dispatch();
    return result();
  }

  return { push, finish, result, hasTerminal: () => terminalReceived };
}

export async function readTextResponse(response, protocol, onChange) {
  requireProtocol(protocol);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(textServiceError(body) || `文字服务返回 HTTP ${response.status}`);
    error.status = response.status;
    error.code = body?.error?.code || body?.error?.type || body?.code || "";
    throw error;
  }
  if (!response.body) throw new Error("文字服务没有返回可读取的响应内容");
  if (!/text\/event-stream/i.test(response.headers.get("content-type") || "")) {
    let body;
    try { body = await response.json(); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error("文字服务没有返回有效的 JSON 结果");
    }
    const result = parseTextResult(protocol, body);
    if (onChange) onChange(result);
    return result;
  }
  const parser = createTextStreamParser(protocol, onChange);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    return parser.finish();
  } catch (error) {
    if (parser.hasTerminal()) return parser.result();
    throw error;
  } finally {
    reader.releaseLock();
  }
}
