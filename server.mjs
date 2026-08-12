import express from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clearedSessionCookie,
  cookieValue,
  createSessionToken,
  sessionCookie,
  verifyLoginCredentials,
  verifySessionToken,
} from "./serverAuth.mjs";
import {
  LWAIGC_VIDEO_MODELS,
  lwaigcLimitIssue,
  lwaigcVideoPayload,
} from "./src/lwaigcCatalog.js";
import {
  MEAICC_VIDEO_MODELS,
  meaiccLimitIssue,
  meaiccVideoPayload,
} from "./src/meaiccCatalog.js";
import { mediaUploadMode, tmpfilesDirectUrl } from "./src/uploadPolicy.js";
import { ziyuJobFrom, ziyuJobPayload, ziyuModels, ziyuTaskId } from "./src/ziyuCatalog.js";
import {
  GLOBAL_AIOPC_BASE_URL,
  GLOBAL_AIOPC_MODELS,
  globalAiOpcCreatePath,
  globalAiOpcPayload,
  globalAiOpcStatusPath,
} from "./src/globalAiOpcCatalog.js";
import { MAXFORAI_VIDEO_MODELS, maxforaiVideoPayload } from "./src/maxforaiCatalog.js";
import { normalizedTaskProgress } from "./src/taskProgress.js";
import { friendlyUpstreamError } from "./src/upstreamError.js";
import {
  diagnosticIdentity,
  filterDiagnosticEntries,
  sanitizeDiagnostic,
} from "./serverDiagnostics.mjs";
import { capabilityLimitIssue, submissionTimeoutForAdapter } from "./src/providerCatalog.js";

// 与飞猫最新插件保持一致：本地中转服务不继承梯子/环境代理。
// 只影响本工作台进程，不会改动 Windows 或浏览器的代理设置。
for (const key of [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "all_proxy",
]) delete process.env[key];
process.env.NO_PROXY = "*";
process.env.no_proxy = "*";

const app = express();
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);
const dataDir = path.join(rootDir, ".workbench-data");
const uploadDir = path.join(dataDir, "uploads");
const diagnosticLogPath = path.join(dataDir, "diagnostics.jsonl");
const automaticUploadServices = ["Litterbox", "Uguu", "Tmpfiles"];
mkdirSync(dataDir, { recursive: true });
mkdirSync(uploadDir, { recursive: true });

function diagnosticEntries() {
  try {
    return readFileSync(diagnosticLogPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function rotateDiagnosticLog() {
  try {
    if (statSync(diagnosticLogPath).size <= 8 * 1024 * 1024) return;
    const retained = diagnosticEntries().slice(-4000);
    writeFileSync(diagnosticLogPath, `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  } catch {}
}

function writeDiagnostic(req, stage, details = {}) {
  const identity = diagnosticIdentity(req);
  const startedAt = Number(req.diagnostic?.startedAt || Date.now());
  const modelHeader = String(req.get("x-api-model") || "");
  let model = modelHeader;
  try { model = decodeURIComponent(modelHeader); } catch {}
  const knownSecrets = [req.get("x-api-key"), req.get("x-media-upload-key")]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const entry = sanitizeDiagnostic({
    timestamp: new Date().toISOString(),
    source: "server",
    ...identity,
    stage,
    elapsedMs: Date.now() - startedAt,
    model,
    ...details,
  }, "", knownSecrets);
  try {
    appendFileSync(diagnosticLogPath, `${JSON.stringify(entry)}\n`);
    rotateDiagnosticLog();
  } catch {}
  if (req.diagnostic) req.diagnostic.lastStage = stage;
  return entry;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, callback) =>
      callback(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 50, fields: 200 },
});

const FMGO_MODELS = [
  "grok-1.5-fast",
  "grok-1.5",
  "sora-2",
  "sora-2-pro",
  "veo-3.1",
  "veo-3.1-fast",
  "omni",
  "feimiao-v2",
  "feimiao-v2-fast",
  "feimiao-v2-431",
  "feimiao-v2-431-fast",
];

const FMGO_CHAT_MODELS = new Set([
  "sora-2",
  "sora-2-pro",
  "veo-3.1",
  "veo-3.1-fast",
  "feimiao-v2",
  "feimiao-v2-fast",
]);

const FMGO_SORA_VIDEO_MODELS = new Set([
  "omni",
  "feimiao-v2-431",
  "feimiao-v2-431-fast",
]);

const PAIPU_MODELS = [
  "lec-grok-video-1-5",
  "lec-seedance-2-0-933-stable",
  "lec-seedance-2-0-fast-431-720p",
  "lec-seedance-2-0-full-431-720p",
  "lec-seedance-2-0-mini-431-480p",
  "lec-seedance-2-0-fast-933-720p",
  "lec-seedance-2-0-full-933-480p",
  "lec-seedance-2-0-full-933-1080p",
  "lec-seedance-2-0-full-933-720p-mx",
  "lec-seedance-2-0-super-933-1080p",
  "lec-ac-seedance-900-720p",
  "lec-seedance-2-0",
  "lec-seedance-videos-standard",
  "lec-seedance-videos-fast",
  "lec-seedance-videos-mini",
  "lec-seedance-videos-stable",
  "lec-seedance-videos-stable-fast",
  "lec-seedance-videos-stable-mini",
  "lec-dj-video-v1",
  "lec-vm-sd2-full-night-720",
  "lec-vm-sd2-full-flex-720",
  "lec-seedance-2-5",
  "lec-vm-sd25-full-720",
];

const VIRALEE_MODELS = [
  "viraldance",
  "viraldance-fast",
  "viraldance900",
  "viralhorse-5s",
  "viralhorse-10s",
  "viraldance921",
  "viraldance921-fast",
  "viraldance921-2.0",
  "viraldance933",
  "viraldance933-fast",
  "sora-2-landscape-8s",
  "sora-2-landscape-12s",
  "sora-2-portrait-8s",
  "sora-2-portrait-12s",
];

const CANSEEDREAM_ROUTES = ["kele_pool", "tc_pool", "shutiao_pool", "lajiao_pool", "yingtao_pool"];

const secretPath = path.join(dataDir, "job-secret");
if (!existsSync(secretPath))
  writeFileSync(secretPath, crypto.randomBytes(48).toString("hex"), { mode: 0o600 });
const jobSecret = readFileSync(secretPath, "utf8").trim();
const loginUsername = String(process.env.WORKBENCH_USERNAME || "").trim();
const loginPassword = String(process.env.WORKBENCH_PASSWORD || "");
const loginConfigured = Boolean(loginUsername && loginPassword);
const loginAttempts = new Map();
const completedVideoUrls = new Map();

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(fc|fd|fe80):/i.test(host)
  );
}

function publicUrl(value, label = "URL") {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw httpError(400, `${label} 无效`);
  }
  if (!["https:", "http:"].includes(parsed.protocol) || isPrivateHost(parsed.hostname))
    throw httpError(400, `${label} 必须是公网 HTTP(S) 地址`);
  return parsed;
}

function baseUrl(value) {
  const parsed = publicUrl(value, "Base URL");
  if (parsed.protocol !== "https:") throw httpError(400, "Base URL 必须使用 HTTPS");
  return parsed.origin;
}

function inferAdapter(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (host === "api.fmgo.top") return "fmgo";
  if (host === "api.paipu.net") return "paipu";
  if (host === "api.viralee.top") return "viralee";
  if (host === "canseedream.com" || host === "see.ximeiedu.org") return "canseedream";
  if (host === "ai.lwaigc.cn") return "lwaigc";
  if (host === "api.meaicc.com") return "meaicc";
  if (host === "ziyuai.vip" || host === "www.ziyuai.vip") return "ziyuai";
  if (host === "zcbservice.aizfw.cn" || host === "docs.globalaiopc.com" || host === "api.globalaiopc.com") return "globalaiopc";
  if (host === "maxforai.top" || host === "www.maxforai.top") return "maxforai";
  return "newapi";
}

function providerConfig(req, requireModel = true) {
  let resolvedBaseUrl = baseUrl(req.get("x-api-base-url"));
  const apiKey = String(req.get("x-api-key") || "").trim();
  const encodedModel = String(req.get("x-api-model") || "").trim();
  let model = encodedModel;
  try { model = decodeURIComponent(encodedModel); } catch {}
  const requestedAdapter = String(req.get("x-api-adapter") || "").trim();
  const adapter = ["fmgo", "paipu", "viralee", "canseedream", "lwaigc", "meaicc", "ziyuai", "globalaiopc", "maxforai", "newapi"].includes(requestedAdapter)
    ? requestedAdapter
    : inferAdapter(resolvedBaseUrl);
  // canseedream.com 目前会 301 跳转至 see.ximeiedu.org。跨域跳转会按
  // Fetch 安全规则移除 Authorization，导致正确的 SK 也被上游判为缺失。
  // 同时兼容用户浏览器里已经保存的旧地址，直接改用当前官方接口域名。
  if (adapter === "canseedream" && new URL(resolvedBaseUrl).hostname === "canseedream.com")
    resolvedBaseUrl = "https://see.ximeiedu.org";
  if (adapter === "globalaiopc") resolvedBaseUrl = GLOBAL_AIOPC_BASE_URL;
  const rawUploadUrl = String(req.get("x-media-upload-url") || "").trim();
  const mediaUploadUrl = rawUploadUrl
    ? publicUrl(rawUploadUrl, "素材上传地址").toString()
    : adapter === "lwaigc"
      ? `${resolvedBaseUrl}/v1/assets`
      : adapter === "ziyuai"
        ? `${resolvedBaseUrl}/api/v1/uploads`
        : adapter === "maxforai"
          ? `${resolvedBaseUrl}/v1/assets`
      : "";
  const mediaUploadKey = String(req.get("x-media-upload-key") || "").trim() || apiKey;
  if (!apiKey) throw httpError(400, "请填写 API Key");
  if (requireModel && !model) throw httpError(400, "请选择模型");
  return { baseUrl: resolvedBaseUrl, apiKey, model, adapter, mediaUploadUrl, mediaUploadKey };
}

function authHeaders(config, extra = {}) {
  return { Authorization: `Bearer ${config.apiKey}`, ...extra };
}

const retryableStatuses = new Set([408, 425, 429, 433, 500, 502, 503, 504, 520, 522, 523, 524]);
const retryableMethods = new Set(["GET", "HEAD", "OPTIONS"]);

function retryDelay(attempt, response) {
  const retryAfter = Number(response?.headers?.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(10_000, retryAfter * 1000);
  return Math.min(5000, 500 * (2 ** attempt));
}

async function upstream(url, options = {}, timeoutMs = 180_000) {
  const method = String(options.method || "GET").toUpperCase();
  const maxAttempts = retryableMethods.has(method) ? 3 : 1;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      if (attempt + 1 < maxAttempts && retryableStatuses.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt, response)));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
    }
  }
  throw lastError || new Error("上游请求失败");
}

async function readJson(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    let message =
      body?.error?.message || body?.error || body?.message || body?.detail || `上游返回 HTTP ${response.status}`;
    if (response.status === 433) {
      message = `HTTP 433：网络代理或连接链路异常。工作台已启用直连防丢包，请稍后重试。${message ? ` ${message}` : ""}`;
    }
    throw httpError(response.status, friendlyUpstreamError(message));
  }
  return body;
}

function fallbackModels(adapter) {
  return adapter === "fmgo"
    ? FMGO_MODELS
    : adapter === "paipu"
      ? PAIPU_MODELS
      : adapter === "viralee"
        ? VIRALEE_MODELS
        : adapter === "canseedream"
          ? CANSEEDREAM_ROUTES
          : adapter === "lwaigc"
            ? LWAIGC_VIDEO_MODELS
            : adapter === "meaicc"
              ? MEAICC_VIDEO_MODELS
              : adapter === "globalaiopc"
                ? GLOBAL_AIOPC_MODELS
                : adapter === "maxforai"
                  ? MAXFORAI_VIDEO_MODELS
        : [];
}

function sign(value) {
  return crypto.createHmac("sha256", jobSecret).update(value).digest("base64url");
}

function encodeJob(job) {
  const payload = Buffer.from(JSON.stringify(job)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function decodeJob(token) {
  try {
    const [payload, signature, extra] = String(token).split(".");
    if (!payload || !signature || extra) throw new Error();
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error();
    const job = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!job?.taskId || !job?.baseUrl || !job?.adapter || !String(job.statusPath).startsWith("/"))
      throw new Error();
    return job;
  } catch {
    throw httpError(400, "任务 ID 无效或已被修改");
  }
}

function taskIdFrom(body) {
  return String(
    body?.id ||
      body?.task_id ||
      body?.task?.id ||
      body?.data?.id ||
      body?.data?.task_id ||
      body?.jobId ||
      body?.data?.jobId ||
      "",
  ).trim();
}

function normalizeStatus(value) {
  const status = String(value || "queued").toLowerCase();
  if (["completed", "succeeded", "success"].includes(status)) return "completed";
  if (["failed", "error", "cancelled", "canceled"].includes(status) || status.startsWith("failed:")) return "failed";
  if (["queued", "pending", "waiting", "submitted"].includes(status)) return "queued";
  return "processing";
}

function videoUrlsFrom(body, base) {
  const candidates = [
    body?.video?.url,
    body?.data?.video?.url,
    body?.video_url,
    body?.result_url,
    body?.url,
    body?.file_url,
    typeof body?.object === "string" && /^https?:\/\//i.test(body.object) ? body.object : null,
    body?.metadata?.url,
    body?.content?.video_url,
    body?.output?.url,
    body?.result?.url,
    body?.data?.video_url,
    body?.data?.result_url,
    body?.data?.url,
    body?.data?.metadata?.url,
    body?.data?.[0]?.url,
    body?.data?.[0]?.video_url,
    body?.previewUrl,
    body?.data?.previewUrl,
  ];
  return [...new Set(candidates.flatMap((candidate) => {
    if (typeof candidate !== "string" || !candidate.trim()) return [];
    try { return [new URL(candidate, base).toString()]; } catch { return []; }
  }))];
}

function videoUrlFrom(body, base) {
  return videoUrlsFrom(body, base)[0] || null;
}

function errorFrom(body) {
  const statusError = /^failed:\s*(.+)$/i.exec(String(body?.status || ""))?.[1];
  return String(body?.failureReason || body?.data?.failureReason || body?.error?.message || body?.message || statusError || body?.error || "视频生成失败");
}

function dateText(value) {
  if (!value) return undefined;
  const date = typeof value === "number" ? new Date(value > 1e12 ? value : value * 1000) : new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString("zh-CN", { hour12: false });
}

function safeNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function validateLwaigcLimits(config, meta, duration) {
  if (config.adapter !== "lwaigc") return;
  const issue = lwaigcLimitIssue(config.model, meta, duration);
  if (issue) throw httpError(400, issue);
}

function validateMeaiccLimits(config, meta, duration) {
  if (config.adapter !== "meaicc") return;
  const issue = meaiccLimitIssue(config.model, meta, duration);
  if (issue) throw httpError(400, issue);
}

function validateProviderLimits(config, meta, duration) {
  // CanSeeDream 与 Ziyu 的能力由带当前 Key 的实时模型接口返回，服务端在
  // 创建阶段拿不到这份动态表；这两家保留前端实时校验并交给上游复核。
  if (["lwaigc", "meaicc", "newapi", "canseedream", "ziyuai"].includes(config.adapter)) return;
  const issue = capabilityLimitIssue({ adapter: config.adapter, model: config.model }, meta, duration);
  if (issue) throw httpError(400, issue);
}

function cleanupFiles(files) {
  for (const file of files || []) {
    try {
      unlinkSync(file.path);
    } catch {}
  }
}

function fileBytes(file) {
  if (Buffer.isBuffer(file?.buffer)) return file.buffer;
  if (!file?.path || !existsSync(file.path))
    throw httpError(400, `本地素材临时文件已丢失：${file?.originalname || "未知文件"}。请重新添加素材后再提交。`);
  const bytes = readFileSync(file.path);
  file.buffer = bytes;
  return bytes;
}

async function uploadTemporaryMedia(file, material = {}, req) {
  const displayName = String(material.name || file.originalname || "本地素材");
  const bytes = fileBytes(file);
  const errors = [];

  let attemptStartedAt = Date.now();
  writeDiagnostic(req, "temporary_upload_attempt_started", { service: "Litterbox", fileName: displayName, bytes: bytes.length });
  try {
    const form = new FormData();
    form.set("reqtype", "fileupload");
    form.set("time", "1h");
    form.set("fileToUpload", new Blob([bytes], { type: file.mimetype || "application/octet-stream" }), displayName);
    const response = await upstream(
      "https://litterbox.catbox.moe/resources/internals/api.php",
      { method: "POST", body: form },
      180_000,
    );
    const value = (await response.text()).trim();
    if (response.ok && /^https:\/\/litter\.catbox\.moe\//i.test(value)) {
      writeDiagnostic(req, "temporary_upload_attempt_completed", { service: "Litterbox", fileName: displayName, durationMs: Date.now() - attemptStartedAt, status: response.status });
      return publicUrl(value, "自动素材 URL").toString();
    }
    writeDiagnostic(req, "temporary_upload_attempt_failed", { service: "Litterbox", fileName: displayName, durationMs: Date.now() - attemptStartedAt, status: response.status });
    errors.push(`Litterbox: HTTP ${response.status}`);
  } catch (error) {
    writeDiagnostic(req, "temporary_upload_attempt_failed", { service: "Litterbox", fileName: displayName, durationMs: Date.now() - attemptStartedAt, error: error?.message || "连接失败" });
    errors.push(`Litterbox: ${error?.message || "连接失败"}`);
  }

  attemptStartedAt = Date.now();
  writeDiagnostic(req, "temporary_upload_attempt_started", { service: "Uguu", fileName: displayName, bytes: bytes.length });
  try {
    const form = new FormData();
    form.set("files[]", new Blob([bytes], { type: file.mimetype || "application/octet-stream" }), displayName);
    const response = await upstream("https://uguu.se/upload", { method: "POST", body: form }, 180_000);
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}
    const value = body?.files?.[0]?.url;
    if (response.ok && body?.success && /^https:\/\/[^/]+\.uguu\.se\//i.test(String(value || ""))) {
      writeDiagnostic(req, "temporary_upload_attempt_completed", { service: "Uguu", fileName: displayName, durationMs: Date.now() - attemptStartedAt, status: response.status });
      return publicUrl(value, "自动素材 URL").toString();
    }
    writeDiagnostic(req, "temporary_upload_attempt_failed", { service: "Uguu", fileName: displayName, durationMs: Date.now() - attemptStartedAt, status: response.status });
    errors.push(`Uguu: HTTP ${response.status}${body?.description ? ` ${body.description}` : ""}`);
  } catch (error) {
    writeDiagnostic(req, "temporary_upload_attempt_failed", { service: "Uguu", fileName: displayName, durationMs: Date.now() - attemptStartedAt, error: error?.message || "连接失败" });
    errors.push(`Uguu: ${error?.message || "连接失败"}`);
  }

  attemptStartedAt = Date.now();
  writeDiagnostic(req, "temporary_upload_attempt_started", { service: "Tmpfiles", fileName: displayName, bytes: bytes.length });
  try {
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: file.mimetype || "application/octet-stream" }), displayName);
    const response = await upstream("https://tmpfiles.org/api/v1/upload", { method: "POST", body: form }, 180_000);
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}
    const value = body?.data?.url;
    if (response.ok && /^https:\/\/tmpfiles\.org\//i.test(String(value || ""))) {
      writeDiagnostic(req, "temporary_upload_attempt_completed", { service: "Tmpfiles", fileName: displayName, durationMs: Date.now() - attemptStartedAt, status: response.status });
      return publicUrl(tmpfilesDirectUrl(value), "自动素材 URL").toString();
    }
    writeDiagnostic(req, "temporary_upload_attempt_failed", { service: "Tmpfiles", fileName: displayName, durationMs: Date.now() - attemptStartedAt, status: response.status });
    errors.push(`Tmpfiles: HTTP ${response.status}${body?.status ? ` ${body.status}` : ""}`);
  } catch (error) {
    writeDiagnostic(req, "temporary_upload_attempt_failed", { service: "Tmpfiles", fileName: displayName, durationMs: Date.now() - attemptStartedAt, error: error?.message || "连接失败" });
    errors.push(`Tmpfiles: ${error?.message || "连接失败"}`);
  }

  throw httpError(
    502,
    `自动临时转链失败：${displayName}。已尝试 ${automaticUploadServices.join("、")}。${errors.join("；")}。可以稍后重试，或填写自己的上传地址。`,
  );
}

async function uploadMedia(config, file, material = {}, req) {
  if (mediaUploadMode(config, file.mimetype) === "temporary") {
    return uploadTemporaryMedia(file, material, req);
  }
  const displayName = String(material.name || file.originalname || "本地素材");
  const bytes = fileBytes(file);
  const uploadStartedAt = Date.now();
  writeDiagnostic(req, "configured_upload_started", {
    service: config.adapter,
    fileName: displayName,
    bytes: bytes.length,
    kind: material.kind || "",
  });
  if (config.adapter === "ziyuai") {
    const kind = ["image", "audio", "video"].includes(material.kind) ? material.kind : "image";
    const data = `data:${file.mimetype || "application/octet-stream"};base64,${bytes.toString("base64")}`;
    const response = await upstream(config.mediaUploadUrl, {
      method: "POST",
      headers: authHeaders(config, { "Content-Type": "application/json" }),
      body: JSON.stringify({ files: [{ type: kind, name: displayName, data }] }),
    }, 180_000);
    const body = await readJson(response);
    const value = body?.assets?.[0]?.url || body?.data?.assets?.[0]?.url;
    if (!value) throw httpError(502, `紫域 AI 素材上传成功但没有返回 URL：${displayName}`);
    writeDiagnostic(req, "configured_upload_completed", { service: config.adapter, fileName: displayName, durationMs: Date.now() - uploadStartedAt, status: response.status });
    return publicUrl(value, "紫域 AI 素材 URL").toString();
  }
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: file.mimetype || "application/octet-stream" }), displayName);
  const headers = { Authorization: `Bearer ${config.mediaUploadKey}` };
  if (config.adapter === "lwaigc") {
    const fingerprint = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 40);
    headers["Idempotency-Key"] = `asset_${fingerprint}`;
  }
  const response = await upstream(
    config.mediaUploadUrl,
    { method: "POST", headers, body: form },
    180_000,
  );
  const body = await readJson(response);
  const value = body?.url || body?.data?.url || body?.data?.[0]?.url;
  if (!value) throw httpError(502, `素材上传成功但没有返回 URL：${displayName}`);
  writeDiagnostic(req, "configured_upload_completed", { service: config.adapter, fileName: displayName, durationMs: Date.now() - uploadStartedAt, status: response.status });
  return publicUrl(value, "素材 URL").toString();
}

async function importLwaigcMedia(config, value) {
  const source = publicUrl(value, "素材 URL");
  if (
    source.origin === config.baseUrl &&
    /^\/v1\/(?:assets|media-references)\//.test(source.pathname)
  ) return source.toString();

  const fingerprint = crypto.createHash("sludes(config.adapter)) return;
  const issue = capabilityLimitIssue({ adapter: config.adapter, model: config.model }, meta, duration);
  if (issue) throw httpError(400, issue);
}

function cleanupFiles(files) {
  for (const file of files || []) {
    try {
      unlinkSync(file.path);
    } catch {}
  }
}

function fileBytes(file) {
  if (Buffer.isBuffer(file?.buffer)) return file.buffer;
  if (!file?.path || !existsSync(file.path))
    throw httpError(400, `本地素材临时文件已丢失：${file?.originalname || "未知文件"}。请重新添加素材后再提交。`);
  const bytes = readFileSync(file.path);
  file.buffer = bytes;
  return bytes;
}

async function uploadTemporaryMedia(file, material = {}, req) {
  const displayName = String(material.name || file.originalname || "本地素材");
  const bytes = fileBytes(file);
  const errors = [];

  let attemptStartedAt = Date.now();
  writeDiagnostic(req, "temporary_upload_attempt_started", { service: "Litterbox", fileName: displayName, bytes: bytes.length });
  try {
    const form = new FormData();
    form.set("reqtype", "fileupload");
    form.set("time", "1h");
    form.set("fileToUpload", new Blob([bytes], { type: file.mimetype || "application/octet-stream" }), displayName);
    const response = await upstream(
      "https://litterbox.catbox.moe/resources/internals/api.php",
      { method: "POST", body: form },
      180_000,
    );
    const value = (await response.text()).trim();
    if (response.ok && /^https:\/\/litter\.catbox\.moe\//i.test(value)) {
      writeDiagnostic(req, "temporary_upload_attempt_completed", { service: "Litterbox", fileName: displayName, durationMs: Date.now() - attemptStartedAt, status: response.status });
      return publicUrl(value, "自动素材 URL").toString();
    }
    writeDiagnostic(req, "temporary_upload_attempt_failed", { service: "Litterbox", fileName: displayName, durationMs: Date.now() - attemptStartedAt, status: response.status });
    errors.push(`Litterbox: HTTP ${response.status}`);
  } catch (error) {
    writeDiagnostic(req, "temporary_upload_attempt_failed", { service: "Litterbox", fileName: displayName, durationMs: Date.now() - attemptStartedAt, error: error?.message || "连接失败" });
    errors.push(`Litterbox: ${error?.message || "连接失败"}`);
  }

  attemptStartedAt = Date.now();
  writeDiagnostic(req, "temporary_upload_attempt_started", { service: "Uguu", fileName: displayName, bytes: bytes.length });
  try {
    const form = new FormData();
    form.set("files[]", new Blob([bytes], { type: file.mimetype || "application/octet-stream" }), displayName);
    const response = await upstream("https://uguu.se/upload", { method: "POST", body: form }, 180_000);
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}
    const value = body?.files?.[0]?.url;
    if (response.ok && body?.success && /^https:\/\/[^/]+\.uguu\.se\//i.test(String(value || ""))) {
      writeDiagnostic(req, "temporary_upload_attempt_completed", { service: "Uguu", fileName: displayName, durationMs: Date.now() - attemptStartedAt, status: response.status });
      return publicUrl(value, "自动素材 URL").toString();
    }
    writeDiagnostic(req, "temporary_upload_attempt_failed", { service: "Uguu", fileName: displayName, durationMs: Date.now() - attemptStartedAt, status: response.status });
    errors.push(`Uguu: HTTP ${response.status}${body?.description ? ` ${body.description}` : ""}`);
  } catch (error) {
    writeDiagnostic(req, "temporary_upload_attempt_failed", { service: "Uguu", fileName: displayName, durationMs: Date.now() - attemptStartedAt, error: error?.message || "连接失败" });
    errors.push(`Uguu: ${error?.message || "连接失败"}`);
  }

  attemptStartedAt = Date.now();
  writeDiagnostic(req, "temporary_upload_attempt_started", { service: "Tmpfiles", fileName: displayName, bytes: bytes.length });
  try {
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: file.mimetype || "application/octet-stream" }), displayName);
    const response = await upstream("https://tmpfiles.org/api/v1/upload", { method: "POST", body: form }, 180_000);
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}
    const value = body?.data?.url;
    if (response.ok && /^https:\/\/tmpfiles\.org\//i.test(String(value || ""))) {
      writeDiagnostic(req, "temporary_upload_attempt_completed", { service: "Tmpfiles", fileName: displayName, durationMs: Date.now() - attemptStartedAt, status: response.status });
      return publicUrl(tmpfilesDirectUrl(value), "自动素材 URL").toString();
    }
    writeDiagnostic(req, "temporary_upload_attempt_failed", { service: "Tmpfiles", fileName: displayName, durationMs: Date.now() - attemptStartedAt, status: response.status });
    errors.push(`Tmpfiles: HTTP ${response.status}${body?.status ? ` ${body.status}` : ""}`);
  } catch (error) {
    writeDiagnostic(req, "temporary_upload_attempt_failed", { service: "Tmpfiles", fileName: displayName, durationMs: Date.now() - attemptStartedAt, error: error?.message || "连接失败" });
    errors.push(`Tmpfiles: ${error?.message || "连接失败"}`);
  }

  throw httpError(
    502,
    `自动临时转链失败：${displayName}。已尝试 ${automaticUploadServices.join("、")}。${errors.join("；")}。可以稍后重试，或填写自己的上传地址。`,
  );
}

async function uploadMedia(config, file, material = {}, req) {
  if (mediaUploadMode(config, file.mimetype) === "temporary") {
    return uploadTemporaryMedia(file, material, req);
  }
  const displayName = String(material.name || file.originalname || "本地素材");
  const bytes = fileBytes(file);
  const uploadStartedAt = Date.now();
  writeDiagnostic(req, "configured_upload_started", {
    service: config.adapter,
    fileName: displayName,
    bytes: bytes.length,
    kind: material.kind || "",
  });
  if (config.adapter === "ziyuai") {
    const kind = ["image", "audio", "video"].includes(material.kind) ? material.kind : "image";
    const data = `data:${file.mimetype || "application/octet-stream"};base64,${bytes.toString("base64")}`;
    const response = await upstream(config.mediaUploadUrl, {
      method: "POST",
      headers: authHeaders(config, { "Content-Type": "application/json" }),
      body: JSON.stringify({ files: [{ type: kind, name: displayName, data }] }),
    }, 180_000);
    const body = await readJson(response);
    const value = body?.assets?.[0]?.url || body?.data?.assets?.[0]?.url;
    if (!value) throw httpError(502, `紫域 AI 素材上传成功但没有返回 URL：${displayName}`);
    writeDiagnostic(req, "configured_upload_completed", { service: config.adapter, fileName: displayName, durationMs: Date.now() - uploadStartedAt, status: response.status });
    return publicUrl(value, "紫域 AI 素材 URL").toString();
  }
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: file.mimetype || "application/octet-stream" }), displayName);
  const headers = { Authorization: `Bearer ${config.mediaUploadKey}` };
  if (config.adapter === "lwaigc") {
    const fingerprint = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 40);
    headers["Idempotency-Key"] = `asset_${fingerprint}`;
  }
  const response = await upstream(
    config.mediaUploadUrl,
    { method: "POST", headers, body: form },
    180_000,
  );
  const body = await readJson(response);
  const value = body?.url || body?.data?.url || body?.data?.[0]?.url;
  if (!value) throw httpError(502, `素材上传成功但没有返回 URL：${displayName}`);
  writeDiagnostic(req, "configured_upload_completed", { service: config.adapter, fileName: displayName, durationMs: Date.now() - uploadStartedAt, status: response.status });
  return publicUrl(value, "素材 URL").toString();
}

async function importLwaigcMedia(config, value) {
  const source = publicUrl(value, "素材 URL");
  if (
    source.origin === config.baseUrl &&
    /^\/v1\/(?:assets|media-references)\//.test(source.pathname)
  ) return source.toString();

  const fingerprint = crypto.createHash("sha256").update(source.toString()).digest("hex").slice(0, 40);
  const response = await upstream(`${config.baseUrl}/v1/assets/url`, {
    method: "POST",
    headers: authHeaders(config, {
      "Content-Type": "application/json",
      "Idempotency-Key": `asset_url_${fingerprint}`,
    }),
    body: JSON.stringify({ url: source.toString() }),
  }, 180_000);
  const body = await readJson(response);
  if (!body?.url) throw httpError(502, "LWAIGC 转存公网素材成功但没有返回 URL");
  return publicUrl(body.url, "LWAIGC 素材 URL").toString();
}

function imageDataUrl(file) {
  const bytes = fileBytes(file);
  return `data:${file.mimetype || "image/png"};base64,${bytes.toString("base64")}`;
}

async function prepareMaterials(config, files, meta, req) {
  const materials = new Array(meta.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, meta.length) }, async () => {
    while (cursor < meta.length) {
      const index = cursor;
      cursor += 1;
      const item = meta[index];
      const kind = ["image", "audio", "video"].includes(item.kind) ? item.kind : "image";
      if (item.url) {
        const url = config.adapter === "lwaigc"
          ? await importLwaigcMedia(config, item.url)
          : publicUrl(item.url, "素材 URL").toString();
        materials[index] = { ...item, kind, url };
        continue;
      }
      const file = files[Number(item.fileIndex)];
      if (!file) throw httpError(400, `找不到素材文件：${item.name || item.tag}`);
      let url;
      if (kind === "image" && config.adapter === "newapi" && !config.mediaUploadUrl) {
        url = imageDataUrl(file);
      } else {
        url = await uploadMedia(config, file, item, req);
      }
      materials[index] = { ...item, kind, url };
    }
  });
  await Promise.all(workers);
  return materials;
}

function withReferenceMapping(prompt, materials, enabled) {
  if (!enabled || !materials.length) return prompt;
  const lines = materials.map(
    (item, index) => `${item.tag || `@Reference${index + 1}`} = ${item.kind} 参考素材（${item.name || "网络素材"}）`,
  );
  return `${prompt}\n\n参考素材映射：\n${lines.join("\n")}`;
}

function paipuPayload(config, input) {
  const images = input.materials.filter((item) => item.kind === "image").map((item) => item.url);
  const videos = input.materials.filter((item) => item.kind === "video").map((item) => item.url);
  const audios = input.materials.filter((item) => item.kind === "audio").map((item) => item.url);
  const model = config.model.toLowerCase();
  const payload = { model: config.model, prompt: input.prompt };
  const attachImages = () => {
    if (images.length) payload.images = images;
  };
  const attachMixed = () => {
    attachImages();
    if (videos.length) payload.videos = videos;
    if (audios.length) payload.audios = audios;
    payload.generate_audio = input.syncAudio;
  };

  if (model === "lec-grok-video-1-5") {
    payload.duration = input.duration;
    payload.size = {
      "9:16": "720x1280",
      "1:1": "1024x1024",
    }[input.aspectRatio] || "1280x720";
    if (images.length) payload.images = images.slice(0, 1);
    return payload;
  }

  if (model === "lec-seedance-2-0" || model === "lec-dj-video-v1" || model === "lec-ac-seedance-900-720p") {
    payload.duration = input.duration;
    payload.aspect_ratio = input.aspectRatio;
    attachMixed();
    return payload;
  }

  if (model === "lec-vm-sd25-full-720" || model === "lec-vm-sd2-full-night-720") {
    attachMixed();
    return payload;
  }

  if (model === "lec-vm-sd2-full-flex-720") {
    payload.duration = input.duration;
    attachMixed();
    return payload;
  }

  payload.duration = input.duration;
  payload.aspect_ratio = input.aspectRatio;
  const fixedResolutionModel = /^lec-seedance-2-0-(?:fast|full|mini|super)-(?:431|933)-(?:480p|720p|1080p)(?:-mx)?$/.test(model);
  if (!fixedResolutionModel && model !== "lec-seedance-videos-fast")
    payload.resolution = input.resolution;
  if (model === "lec-seedance-2-0-933-stable") payload.watermark = false;
  attachMixed();
  return payload;
}

function viraleePayload(config, input) {
  const model = config.model.toLowerCase();
  const images = input.materials.filter((item) => item.kind === "image");
  const videos = input.materials.filter((item) => item.kind === "video");
  const audios = input.materials.filter((item) => item.kind === "audio");
  const payload = { model: config.model, prompt: input.prompt, generate_audio: input.syncAudio };
  if (model === "viraldance" || model === "viraldance-fast") {
    payload.duration = input.duration;
    payload.ratio = input.aspectRatio;
    payload.generate_audio = input.syncAudio;
    if (input.seed !== null) payload.seed = input.seed;
    payload.content = [
      ...images.map((item) => ({ type: "image_url", image_url: { url: item.url }, sub_type: item.subType || "reference" })),
      ...videos.map((item) => ({ type: "video_url", video_url: { url: item.url }, sub_type: "reference" })),
      ...audios.map((item) => ({ type: "audio_url", audio_url: { url: item.url }, sub_type: "reference" })),
    ];
  } else if (model === "viraldance900") {
    payload.duration = input.duration;
    payload.ratio = input.aspectRatio;
    if (images.length) payload.images = images.slice(0, 9).map((item) => item.url);
  } else if (model.startsWith("viralhorse-")) {
    if (images.length) payload.images = images.slice(0, 4).map((item) => item.url);
  } else if (model.startsWith("viraldance921")) {
    payload.duration = input.duration;
    payload.ratio = input.aspectRatio;
    payload.content = [
      ...images.map((item) => ({ type: "image_url", image_url: { url: item.url }, sub_type: "reference" })),
      ...videos.map((item) => ({ type: "video_url", video_url: { url: item.url }, sub_type: "reference" })),
      ...audios.map((item) => ({ type: "audio_url", audio_url: { url: item.url }, sub_type: "reference" })),
    ];
  } else if (model === "viraldance933" || model === "viraldance933-fast") {
    payload.duration = input.duration;
    payload.ratio = input.aspectRatio;
    payload.resolution = "720p";
    payload.generate_audio = true;
    if (images.length) payload.image_urls = images.map((item) => item.url);
    if (videos.length) payload.video_urls = videos.map((item) => item.url);
    if (audios.length) payload.audio_urls = audios.map((item) => item.url);
  } else if (model.startsWith("sora-2-")) {
    if (images[0]) payload.image_url = images[0].url;
  } else {
    payload.duration = input.duration;
    payload.aspect_ratio = input.aspectRatio;
    payload.resolution = input.resolution;
    if (images.length) payload.images = images.map((item) => item.url);
  }
  return payload;
}

function genericPayload(config, input) {
  const payload = {
    model: config.model,
    prompt: input.prompt,
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
    generate_audio: input.syncAudio,
  };
  for (const kind of ["image", "video", "audio"]) {
    const values = input.materials.filter((item) => item.kind === kind).map((item) => item.url);
    if (values.length) payload[`${kind}s`] = values;
  }
  if (input.seed !== null) payload.seed = input.seed;
  return payload;
}

function canSeeDreamPayload(config, input) {
  const images = input.materials.filter((item) => item.kind === "image");
  const videos = input.materials.filter((item) => item.kind === "video");
  const audios = input.materials.filter((item) => item.kind === "audio");
  const timedAsset = (item, label) => {
    const durationSeconds = Number(item.durationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
      throw httpError(400, `无法读取${label}“${item.name || item.tag}”的时长，请重新添加本地文件或使用可直接访问的素材 URL`);
    return { url: item.url, durationSeconds: Math.ceil(durationSeconds) };
  };
  const payload = {
    model: "video",
    provider_route: config.model,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio,
    generate_audio: input.syncAudio,
    number_of_runs: 1,
  };
  if (config.model !== "tc_pool") pay