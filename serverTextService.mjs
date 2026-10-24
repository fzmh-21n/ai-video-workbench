import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizeApiKey } from "./src/apiKey.js";
import multer from "multer";
import { extractDocumentText, TEXT_DOCUMENT_MAX_BYTES } from "./serverTextDocuments.mjs";

const TEXT_BASE_URL = "https://see.ximeiedu.org/text/v1";

function sendError(res, status, code, message, type = "invalid_request_error") {
  res.status(status).json({ error: { type, code, message } });
}

function imageDataUrl(value) {
  if (typeof value !== "string") return false;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || match[2].length > Math.ceil(5 * 1024 * 1024 / 3) * 4) return false;
  const bytes = Buffer.from(match[2], "base64");
  return bytes.length > 0 && bytes.length <= 5 * 1024 * 1024 && bytes.toString("base64") === match[2];
}

function userContent(value, protocol) {
  if (typeof value === "string") return Boolean(value.trim());
  if (!Array.isArray(value) || !value.length) return false;
  return value.every((item) => {
    if (item?.type === (protocol === "responses" ? "input_text" : "text")) return typeof item.text === "string" && Boolean(item.text.trim());
    if (protocol === "responses" && item?.type === "input_image") return imageDataUrl(item.image_url);
    if (protocol === "chat" && item?.type === "image_url") return imageDataUrl(item.image_url?.url);
    if (protocol === "messages" && item?.type === "image" && item.source?.type === "base64") return imageDataUrl(`data:${item.source.media_type};base64,${item.source.data}`);
    return false;
  });
}

function requestIssue(protocol, body) {
  if (!body || Array.isArray(body) || typeof body !== "object") return "请求体必须是 JSON 对象";
  if (typeof body.model !== "string" || !body.model.trim()) return "请选择文本模型";
  if (body.store !== undefined && body.store !== false || "previous_response_id" in body || "conversation" in body || body.background !== undefined && body.background !== false)
    return "文本工作台仅支持无服务端会话存储的单轮生成，不支持会话续接或后台生成";
  for (const field of ["modalities", "response_modalities"]) {
    if (body[field] !== undefined && (!Array.isArray(body[field]) || body[field].some((item) => typeof item !== "string" || item.toLowerCase() !== "text"))) return "文本工作台仅支持文本输出，不支持图片或音频生成";
  }
  if (body.audio !== undefined && body.audio !== null) return "文本工作台不支持音频输出";
  if (body.service_tier && !["auto", "default", "standard_only"].includes(body.service_tier)
    || body.speed && !["normal", "standard"].includes(body.speed)) return "当前未开放 priority/fast 等额外收费等级";
  if (body.stream !== undefined && typeof body.stream !== "boolean") return "stream 必须是布尔值";
  const tokenField = protocol === "responses" ? "max_output_tokens" : "max_tokens";
  if (body[tokenField] !== undefined && (!Number.isInteger(body[tokenField]) || body[tokenField] <= 0)) return `${tokenField} 必须是正整数`;
  if (protocol === "responses") {
    if (!(typeof body.input === "string" && body.input.trim()) && !(Array.isArray(body.input) && body.input.length === 1 && body.input[0]?.role === "user" && userContent(body.input[0]?.content, protocol)))
      return "Responses 仅支持单轮文本及 PNG/JPEG/WEBP 图片 Data URL";
  } else if (!Array.isArray(body.messages) || body.messages.length !== 1 || body.messages[0]?.role !== "user" || !userContent(body.messages[0]?.content, protocol)) {
    return "仅支持一条 user 消息，内容为文本或 PNG/JPEG/WEBP 图片 Base64；不接收远程或本地路径";
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return "tools 必须是数组";
    const nativeFunction = (tool) => tool && typeof tool === "object" && (protocol === "messages"
      ? tool.type === undefined || tool.type === "custom"
      : tool.type === "function");
    if (!body.tools.every(nativeFunction)) return "当前仅透传原生函数工具，不开放托管搜索、代码执行或图片生成工具";
  }
  return "";
}

export function textServiceRouter({ fetchImpl = fetch } = {}) {
  const router = express.Router();
  router.use(express.json({ limit: "20mb" }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: TEXT_DOCUMENT_MAX_BYTES, files: 1, fields: 0 } });
  router.post("/extract", upload.single("file"), async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await extractDocumentText(req.file));
    } catch (error) {
      sendError(res, error.status || 400, error.code || "TEXT_DOCUMENT_INVALID", error.message || "文档解析失败，请重新另存后上传");
    }
  });

  const forward = (endpoint, protocol = "") => async (req, res) => {
    const key = normalizeApiKey(req.get("x-text-api-key"));
    if (!/^sk_txt_\S+$/.test(key)) return sendError(res, 401, "TEXT_AUTH_INVALID", "请使用有效的文本专用 Key", "authentication_error");
    const post = Boolean(protocol);
    const idempotencyKey = req.get("idempotency-key");
    if (post && (!idempotencyKey || !idempotencyKey.trim() || idempotencyKey.length > 128))
      return sendError(res, 400, "TEXT_IDEMPOTENCY_REQUIRED", "请为本次请求提供稳定的 Idempotency-Key；恢复时保留原编号和请求内容");
    const issue = post ? requestIssue(protocol, req.body) : "";
    if (issue) return sendError(res, 400, "TEXT_REQUEST_UNSUPPORTED", issue);

    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    req.once("aborted", disconnected);
    res.once("close", disconnected);
    let timedOut = false;
    const timer = post ? null : setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    try {
      const headers = protocol === "messages"
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${key}` };
      if (post) Object.assign(headers, { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey });
      const upstream = await fetchImpl(`${TEXT_BASE_URL}/${endpoint}`, {
        method: post ? "POST" : "GET", headers, redirect: "error", signal: controller.signal,
        ...(post ? { body: JSON.stringify(req.body) } : {}),
      });
      res.status(upstream.status);
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
      res.setHeader("Cache-Control", "no-store, no-transform");
      for (const name of ["x-request-id", "x-idempotent-replay", "retry-after"]) {
        const value = upstream.headers.get(name);
        if (value !== null) res.setHeader(name, value);
      }
      if (!upstream.body) return res.end();
      if (/text\/event-stream/i.test(upstream.headers.get("content-type") || "")) res.flushHeaders();
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (error) {
      if (res.destroyed || req.aborted) return;
      if (res.headersSent) return res.destroy(error);
      sendError(res, timedOut ? 504 : 502, timedOut ? "TEXT_UPSTREAM_TIMEOUT" : "TEXT_UPSTREAM_UNAVAILABLE",
        timedOut ? "读取文本模型超时，请稍后再试" : "文本接口连接中断；本次请求不会自动重发，请保留原请求编号并核对中转记录", "api_error");
    } finally {
      if (timer) clearTimeout(timer);
      req.removeListener("aborted", disconnected);
      res.removeListener("close", disconnected);
    }
  };

  router.get("/models", forward("models"));
  router.post("/responses", forward("responses", "responses"));
  router.post("/messages", forward("messages", "messages"));
  router.post("/chat/completions", forward("chat/completions", "chat"));
  router.use((error, _req, res, _next) => {
    const large = error.type === "entity.too.large" || error.code === "LIMIT_FILE_SIZE";
    sendError(res, large ? 413 : 400, large ? "TEXT_REQUEST_TOO_LARGE" : "TEXT_REQUEST_INVALID",
      error.code === "LIMIT_FILE_SIZE" ? "文档超过工作台 10 MiB 上传上限，请拆分后上传" : error instanceof multer.MulterError ? "请选择一个 DOCX/PDF 文件，上传字段必须是 file" : "文本请求 JSON 无效或超过工作台 20 MiB 上限");
  });
  return router;
}
