import express from "express";
import multer from "multer";
import COS from "cos-nodejs-sdk-v5";
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
  isLwaigcDqModel,
  lwaigcLimitIssue,
  lwaigcVideoPayload,
} from "./src/lwaigcCatalog.js";
import {
  MEAICC_VIDEO_MODELS,
  meaiccLimitIssue,
  meaiccVideoPayload,
} from "./src/meaiccCatalog.js";
import {
  AUTOMATIC_UPLOAD_SERVICES,
  configuredUploadRetryDelay,
  createUploadCircuitBreaker,
  mediaUploadMode,
  tmpfilesDirectUrl,
} from "./src/uploadPolicy.js";
import { ziyuJobFrom, ziyuJobPayload, ziyuModels, ziyuTaskId } from "./src/ziyuCatalog.js";
import {
  GLOBAL_AIOPC_BASE_URL,
  GLOBAL_AIOPC_MODELS,
  globalAiOpcCreatePath,
  globalAiOpcPayload,
  globalAiOpcStatusPath,
} from "./src/globalAiOpcCatalog.js";
import { MAXFORAI_VIDEO_MODELS, maxforaiVideoPayload } from "./src/maxforaiCatalog.js";
import { CLMM_BASE_URL, clmmLimitIssue, clmmModels, clmmVideoPayload } from "./src/clmmCatalog.js";
import { PIDOI_BASE_URL, PIDOI_MODELS, pidoiVideoPayload } from "./src/pidoiCatalog.js";
import { normalizedTaskProgress } from "./src/taskProgress.js";
import { taskFailureDetails } from "./src/upstreamTaskFailure.js";
import { friendlyUpstreamError } from "./src/upstreamError.js";
import {
  diagnosticIdentity,
  filterDiagnosticEntries,
  sanitizeDiagnostic,
} from "./serverDiagnostics.mjs";
import { capabilityLimitIssue, submissionTimeoutForAdapter } from "./src/providerCatalog.js";
import { cosFingerprintKey, cosPublicUrl, normalizeCosConfig } from "./src/cosStorage.js";

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
const cosConfigPath = path.join(dataDir, "cos-config.json");
const automaticUploadServices = AUTOMATIC_UPLOAD_SERVICES;
const automaticUploadCircuit = createUploadCircuitBreaker({ failureThreshold: 2 });
mkdirSync(dataDir, { recursive: true });
mkdirSync(uploadDir, { recursive: true });

function cosConfig() {
  try { return normalizeCosConfig(JSON.parse(readFileSync(cosConfigPath, "utf8"))); } catch { return null; }
}

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
  if (host === "clmm-mall.top" || host === "www.clmm-mall.top") return "clmm";
  if (host === "pidoi.com" || host === "www.pidoi.com") return "pidoi";
  return "newapi";
}

function providerConfig(req, requireModel = true) {
  let resolvedBaseUrl = baseUrl(req.get("x-api-base-url"));
  const apiKey = String(req.get("x-api-key") || "").trim();
  const encodedModel = String(req.get("x-api-model") || "").trim();
  let model = encodedModel;
  try { model = decodeURIComponent(encodedModel); } catch {}
  const requestedAdapter = String(req.get("x-api-adapter") || "").trim();
  const adapter = ["fmgo", "paipu", "viralee", "canseedream", "lwaigc", "meaicc", "ziyuai", "globalaiopc", "maxforai", "clmm", "pidoi", "newapi"].includes(requestedAdapter)
    ? requestedAdapter
    : inferAdapter(resolvedBaseUrl);
  // canseedream.com 目前会 301 跳转至 see.ximeiedu.org。跨域跳转会按
  // Fetch 安全规则移除 Authorization，导致正确的 SK 也被上游判为缺失。
  // 同时兼容用户浏览器里已经保存的旧地址，直接改用当前官方接口域名。
  if (adapter === "canseedream" && new URL(resolvedBaseUrl).hostname === "canseedream.com")
    resolvedBaseUrl = "https://see.ximeiedu.org";
  if (adapter === "globalaiopc") resolvedBaseUrl = GLOBAL_AIOPC_BASE_URL;
  if (adapter === "clmm") resolvedBaseUrl = CLMM_BASE_URL;
  if (adapter === "pidoi") resolvedBaseUrl = PIDOI_BASE_URL;
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
                : adapter === "pidoi"
                  ? PIDOI_MODELS
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
    typeof body?.content === "string" ? body.content : null,
    body?.content?.video_url,
    body?.output?.url,
    body?.result?.url,
    body?.data?.video_url,
    body?.data?.result_url,
    body?.data?.url,
    body?.data?.metadata?.url,
    typeof body?.data?.content === "string" ? body.data.content : null,
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

async function temporaryUploadAttempt(service, bytes, file, displayName) {
  const mimeType = file.mimetype || "application/octet-stream";
  if (service === "Uguu") {
    const form = new FormData();
    form.set("files[]", new Blob([bytes], { type: mimeType }), displayName);
    const response = await upstream("https://uguu.se/upload", { method: "POST", body: form }, 180_000);
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}
    const value = body?.files?.[0]?.url;
    if (response.ok && body?.success && /^https:\/\/[^/]+\.uguu\.se\//i.test(String(value || ""))) {
      return { status: response.status, url: publicUrl(value, "自动素材 URL").toString() };
    }
    throw Object.assign(new Error(`HTTP ${response.status}${body?.description ? ` ${body.description}` : ""}`), { status: response.status });
  }
  if (service === "Litterbox") {
    const form = new FormData();
    form.set("reqtype", "fileupload");
    form.set("time", "1h");
    form.set("fileToUpload", new Blob([bytes], { type: mimeType }), displayName);
    const response = await upstream(
      "https://litterbox.catbox.moe/resources/internals/api.php",
      { method: "POST", body: form },
      180_000,
    );
    const value = (await response.text()).trim();
    if (response.ok && /^https:\/\/litter\.catbox\.moe\//i.test(value)) {
      return { status: response.status, url: publicUrl(value, "自动素材 URL").toString() };
    }
    throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  }
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mimeType }), displayName);
  const response = await upstream("https://tmpfiles.org/api/v1/upload", { method: "POST", body: form }, 180_000);
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  const value = body?.data?.url;
  if (response.ok && /^https:\/\/tmpfiles\.org\//i.test(String(value || ""))) {
    return { status: response.status, url: publicUrl(tmpfilesDirectUrl(value), "自动素材 URL").toString() };
  }
  throw Object.assign(new Error(`HTTP ${response.status}${body?.status ? ` ${body.status}` : ""}`), { status: response.status });
}

async function uploadTemporaryMedia(file, material = {}, req) {
  const displayName = String(material.name || file.originalname || "本地素材");
  const bytes = fileBytes(file);
  const errors = [];

  for (const service of automaticUploadServices) {
    if (automaticUploadCircuit.isOpen(service)) {
      writeDiagnostic(req, "temporary_upload_service_skipped", {
        service,
        fileName: displayName,
        reason: "本次服务运行中连续失败，已自动熔断",
      });
      errors.push(`${service}: 已熔断跳过`);
      continue;
    }
    const attemptStartedAt = Date.now();
    writeDiagnostic(req, "temporary_upload_attempt_started", { service, fileName: displayName, bytes: bytes.length });
    try {
      const result = await temporaryUploadAttempt(service, bytes, file, displayName);
      automaticUploadCircuit.recordSuccess(service);
      writeDiagnostic(req, "temporary_upload_attempt_completed", {
        service,
        fileName: displayName,
        durationMs: Date.now() - attemptStartedAt,
        status: result.status,
      });
      return result.url;
    } catch (error) {
      const circuitOpened = automaticUploadCircuit.recordFailure(service);
      writeDiagnostic(req, "temporary_upload_attempt_failed", {
        service,
        fileName: displayName,
        durationMs: Date.now() - attemptStartedAt,
        status: error?.status,
        error: error?.message || "连接失败",
        circuitOpened,
      });
      errors.push(`${service}: ${error?.message || "连接失败"}`);
    }
  }

  throw httpError(
    502,
    `自动临时转链失败：${displayName}。已尝试 ${automaticUploadServices.join("、")}。${errors.join("；")}。可以稍后重试，或填写自己的上传地址。`,
  );
}

async function uploadCosMedia(storage, file, material = {}, req) {
  const bytes = fileBytes(file);
  const displayName = String(material.name || file.originalname || "本地素材");
  const kind = ["image", "audio", "video"].includes(material.kind) ? material.kind : "file";
  const extension = path.extname(displayName || file.originalname || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const key = cosFingerprintKey({ kind, digest, extension });
  const startedAt = Date.now();
  writeDiagnostic(req, "cos_upload_started", { service: "Tencent COS", fileName: displayName, kind, bytes: bytes.length });
  try {
    const client = new COS({ SecretId: storage.secretId, SecretKey: storage.secretKey, Timeout: 300_000 });
    const exists = await new Promise((resolve, reject) => client.headObject({
      Bucket: storage.bucket,
      Region: storage.region,
      Key: key,
    }, (error) => {
      const status = Number(error?.statusCode || error?.status || 0);
      if (!error) return resolve(true);
      if (status === 404 || error?.code === "NoSuchKey" || error?.code === "NotFound") return resolve(false);
      return reject(error);
    }));
    if (exists) {
      writeDiagnostic(req, "cos_upload_reused", {
        service: "Tencent COS",
        fileName: displayName,
        kind,
        bytes: bytes.length,
        fingerprint: digest,
        durationMs: Date.now() - startedAt,
      });
      return cosPublicUrl(storage, key);
    }
    await new Promise((resolve, reject) => client.putObject({
      Bucket: storage.bucket,
      Region: storage.region,
      Key: key,
      Body: bytes,
      ContentType: file.mimetype || "application/octet-stream",
    }, (error, data) => error ? reject(error) : resolve(data)));
    writeDiagnostic(req, "cos_upload_completed", {
      service: "Tencent COS",
      fileName: displayName,
      kind,
      bytes: bytes.length,
      fingerprint: digest,
      durationMs: Date.now() - startedAt,
    });
    return cosPublicUrl(storage, key);
  } catch (error) {
    const status = Number(error?.statusCode || error?.status || 500);
    const message = error?.error?.Message || error?.message || error?.code || "COS 上传失败";
    writeDiagnostic(req, "cos_upload_failed", {
      service: "Tencent COS",
      fileName: displayName,
      kind,
      durationMs: Date.now() - startedAt,
      status,
      error: message,
    });
    throw httpError(status, `腾讯云 COS 上传失败：${message}`);
  }
}

async function uploadMedia(config, file, material = {}, req) {
  const storage = cosConfig();
  if (storage) return uploadCosMedia(storage, file, material, req);
  if (mediaUploadMode(config, file.mimetype) === "temporary") {
    return uploadTemporaryMedia(file, material, req);
  }
  const displayName = String(material.name || file.originalname || "本地素材");
  const bytes = fileBytes(file);
  const uploadStartedAt = Date.now();
  let uploadAttemptCount = 0;
  writeDiagnostic(req, "configured_upload_started", {
    service: config.adapter,
    fileName: displayName,
    bytes: bytes.length,
    kind: material.kind || "",
  });
  try {
    if (config.adapter === "ziyuai") {
      const kind = ["image", "audio", "video"].includes(material.kind) ? material.kind : "image";
      const data = `data:${file.mimetype || "application/octet-stream"};base64,${bytes.toString("base64")}`;
      const payload = JSON.stringify({ files: [{ type: kind, name: displayName, data }] });
      const maxAttempts = 4;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        uploadAttemptCount = attempt;
        writeDiagnostic(req, "configured_upload_attempt_started", {
          service: config.adapter,
          fileName: displayName,
          attempt,
          maxAttempts,
        });
        const response = await upstream(config.mediaUploadUrl, {
          method: "POST",
          headers: authHeaders(config, { "Content-Type": "application/json" }),
          body: payload,
        }, 180_000);
        let body;
        try {
          body = await readJson(response);
        } catch (error) {
          if (response.status === 429 && attempt < maxAttempts) {
            const delayMs = configuredUploadRetryDelay(response.headers.get("retry-after"), attempt - 1);
            writeDiagnostic(req, "configured_upload_retry_wait", {
              service: config.adapter,
              fileName: displayName,
              status: response.status,
              attempt,
              nextAttempt: attempt + 1,
              delayMs,
              retryAfter: response.headers.get("retry-after") || "",
            });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
          throw error;
        }
        const value = body?.assets?.[0]?.url || body?.data?.assets?.[0]?.url;
        if (!value) throw httpError(502, `紫域 AI 素材上传成功但没有返回 URL：${displayName}`);
        writeDiagnostic(req, "configured_upload_completed", {
          service: config.adapter,
          fileName: displayName,
          durationMs: Date.now() - uploadStartedAt,
          status: response.status,
          attemptCount: attempt,
        });
        return publicUrl(value, "紫域 AI 素材 URL").toString();
      }
    }
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: file.mimetype || "application/octet-stream" }), displayName);
    const headers = { Authorization: `Bearer ${config.mediaUploadKey}` };
    if (config.adapter === "lwaigc") {
      const fingerprint = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 40);
      headers["Idempotency-Key"] = `asset_${fingerprint}`;
    }
    uploadAttemptCount = 1;
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
  } catch (error) {
    writeDiagnostic(req, "configured_upload_failed", {
      service: config.adapter,
      fileName: displayName,
      durationMs: Date.now() - uploadStartedAt,
      status: error?.status || 500,
      error: error?.message || "素材上传失败",
      attemptCount: uploadAttemptCount,
    });
    throw error;
  }
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
  const concurrency = config.adapter === "ziyuai" ? 1 : 4;
  const workers = Array.from({ length: Math.min(concurrency, meta.length) }, async () => {
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
      if (kind === "image" && config.adapter === "newapi" && !config.mediaUploadUrl && !cosConfig()) {
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
  if (config.model !== "tc_pool") payload.duration = input.duration;
  if (images.length) payload.image_urls = images.map((item) => item.url);
  if (audios.length) payload.audio_urls = audios.map((item) => timedAsset(item, "音频"));
  if (videos.length) payload.video_urls = videos.map((item) => timedAsset(item, "视频"));
  return payload;
}

function fmgoModelName(model, duration, resolution) {
  if (model === "grok-1.5") return `grok-video-1.5-${duration}s`;
  if (model === "grok-1.5-fast") return `grok-video-${duration}s`;
  if (model === "omni") return "gemini-omni-flash";
  if (model === "feimiao-v2" || model === "feimiao-v2-fast")
    return `${model}-${resolution}-${duration}s`;
  return model;
}

function openAiMessage(prompt, materials) {
  if (!materials.length) return { role: "user", content: prompt };
  return {
    role: "user",
    content: [
      { type: "text", text: prompt },
      ...materials.map((item) => {
        if (item.kind === "audio") {
          return { type: "audio_url", audio_url: { url: item.url } };
        }
        if (item.kind === "video") {
          return { type: "video_url", video_url: { url: item.url } };
        }
        return { type: "image_url", image_url: { url: item.url } };
      }),
    ],
  };
}

function isFmgoChatModel(model) {
  return (
    FMGO_CHAT_MODELS.has(model) ||
    /^feimiao-v2(?:-fast)?-(?:480p|720p|1080p)-\d+s$/i.test(model)
  );
}

function isFmgoSoraVideoModel(model) {
  return (
    FMGO_SORA_VIDEO_MODELS.has(model) ||
    /^feimiao-v2-431(?:-fast)?-(?:480p|720p|1080p)-\d+s$/i.test(model)
  );
}

function safeStatusPath(base, candidate, fallback) {
  if (!candidate) return fallback;
  try {
    const resolved = new URL(candidate, base);
    if (resolved.origin !== new URL(base).origin) return fallback;
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return fallback;
  }
}

async function createFmgo(config, input) {
  const maxImages = config.model.startsWith("sora-")
    ? 1
    : config.model.startsWith("veo-3.1")
      ? 3
      : config.model === "omni"
        ? 7
        : config.model.startsWith("feimiao-v2")
          ? 9
          : 7;
  const images = input.materials
    .filter((item) => item.kind === "image")
    .slice(0, maxImages)
    .map((item) => item.url);
  const chatMaterials = input.materials.filter((item) => {
    if (item.kind === "image") return images.includes(item.url);
    return item.kind === "audio" || item.kind === "video";
  });
  const model = config.model;
  const upstreamModel = fmgoModelName(model, input.duration, input.resolution);

  if (isFmgoChatModel(model)) {
    const videoConfig = {
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      generateAudio: input.syncAudio,
    };
    if (!model.startsWith("sora-")) videoConfig.resolution = input.resolution;
    const payload = {
      model: upstreamModel,
      messages: [openAiMessage(input.prompt, chatMaterials)],
      generationConfig: { videoConfig },
      async: true,
    };
    if (model === "veo-3.1" && images.length > 1) payload.reference_mode = "image";
    const response = await upstream(
      `${config.baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: authHeaders(config, {
          "Content-Type": "application/json",
          Prefer: "respond-async",
        }),
        body: JSON.stringify(payload),
      },
      180_000,
    );
    const body = await readJson(response);
    const taskId = taskIdFrom(body);
    if (!taskId) throw httpError(502, "FMGO 创建成功但没有返回任务 ID");
    return {
      adapter: "fmgo",
      baseUrl: config.baseUrl,
      taskId,
      kind: "fmgo-chat",
      statusPath: safeStatusPath(
        config.baseUrl,
        body?.task?.status_url,
        `/v1/tasks/${encodeURIComponent(taskId)}`,
      ),
      model: config.model,
    };
  }

  const soraStyle = isFmgoSoraVideoModel(model);
  const payload = soraStyle
    ? {
        model: upstreamModel,
        prompt: input.prompt,
        aspect_ratio: input.aspectRatio,
        resolution: input.resolution,
        seconds: String(input.duration),
      }
    : {
        model: upstreamModel,
        prompt: input.prompt,
        ratio: input.aspectRatio,
        resolution: input.resolution,
        duration: input.duration,
        response_format: "url",
      };
  if (images.length) {
    if (soraStyle) {
      payload.image_url = images[0];
      if (images.length > 1) payload.images = images.slice(1);
    } else {
      payload.reference_images = images;
    }
  }
  payload.generate_audio = input.syncAudio;
  const response = await upstream(
    `${config.baseUrl}/v1/videos`,
    {
      method: "POST",
      headers: authHeaders(config, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    },
    180_000,
  );
  const body = await readJson(response);
  const taskId = taskIdFrom(body);
  if (!taskId) throw httpError(502, "FMGO 创建成功但没有返回任务 ID");
  return {
    adapter: "fmgo",
    baseUrl: config.baseUrl,
    taskId,
    kind: "fmgo-videos",
    statusPath: `/v1/videos/${encodeURIComponent(taskId)}`,
    model: config.model,
  };
}

async function createLwaigc(config, input) {
  const clientTaskId = `workbench_${crypto.randomUUID()}`;
  const bodyText = JSON.stringify(lwaigcVideoPayload(config.model, input, clientTaskId));
  const request = () => upstream(`${config.baseUrl}/v1/videos`, {
    method: "POST",
    headers: authHeaders(config, {
      "Content-Type": "application/json",
      "Idempotency-Key": clientTaskId,
    }),
    body: bodyText,
  }, 180_000);

  let response;
  try {
    response = await request();
  } catch {
    response = await request();
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    response = await request();
  }
  const body = await readJson(response);
  const taskId = taskIdFrom(body);
  if (!taskId) throw httpError(502, "LWAIGC 创建成功但没有返回任务 ID");
  return {
    adapter: "lwaigc",
    baseUrl: config.baseUrl,
    taskId,
    statusPath: `/v1/videos/${encodeURIComponent(taskId)}`,
    model: config.model,
  };
}

async function createVideo(config, input) {
  if (config.adapter === "fmgo") return createFmgo(config, input);
  if (config.adapter === "lwaigc") return createLwaigc(config, input);
  if (config.adapter === "clmm") {
    const response = await upstream(`${CLMM_BASE_URL}/v1/videos`, {
      method: "POST",
      headers: authHeaders(config, { "Content-Type": "application/json" }),
      body: JSON.stringify(clmmVideoPayload(config.model, input)),
    }, 180_000);
    const body = await readJson(response);
    const taskId = taskIdFrom(body);
    if (!taskId) throw httpError(502, "CLMM Mall 创建成功但没有返回 task_id");
    return {
      adapter: "clmm",
      baseUrl: CLMM_BASE_URL,
      taskId,
      statusPath: `/v1/videos/${encodeURIComponent(taskId)}`,
      model: config.model,
    };
  }
  if (config.adapter === "globalaiopc") {
    const response = await upstream(`${config.baseUrl}${globalAiOpcCreatePath(config.model)}`, {
      method: "POST",
      headers: authHeaders(config, { "Content-Type": "application/json" }),
      body: JSON.stringify(globalAiOpcPayload(config.model, input)),
    }, 180_000);
    const body = await readJson(response);
    const taskId = taskIdFrom(body);
    if (!taskId) throw httpError(502, "全球 AI 创建成功但没有返回任务 ID");
    return {
      adapter: "globalaiopc",
      baseUrl: config.baseUrl,
      taskId,
      statusPath: globalAiOpcStatusPath(config.model, taskId),
      model: config.model,
    };
  }
  if (config.adapter === "canseedream") {
    const response = await upstream(`${config.baseUrl}/api/v3/contents/generations/tasks`, {
      method: "POST",
      headers: authHeaders(config, {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      }),
      body: JSON.stringify(canSeeDreamPayload(config, input)),
    }, 180_000);
    const body = await readJson(response);
    const taskId = taskIdFrom(body);
    if (!taskId) throw httpError(502, "CanSeeDream 创建成功但没有返回任务 ID");
    return {
      adapter: config.adapter,
      baseUrl: config.baseUrl,
      taskId,
      statusPath: `/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      model: config.model,
    };
  }
  if (config.adapter === "ziyuai") {
    const response = await upstream(`${config.baseUrl}/api/v1/jobs`, {
      method: "POST",
      headers: authHeaders(config, { "Content-Type": "application/json" }),
      body: JSON.stringify(ziyuJobPayload(config.model, input)),
    }, 180_000);
    const body = await readJson(response);
    const taskId = ziyuTaskId(body);
    if (!taskId) throw httpError(502, "紫域 AI 创建成功但没有返回任务 ID");
    return {
      adapter: "ziyuai",
      baseUrl: config.baseUrl,
      taskId,
      statusPath: `/api/v1/jobs/${encodeURIComponent(taskId)}`,
      model: config.model,
    };
  }
  const payload =
    config.adapter === "paipu"
      ? paipuPayload(config, input)
      : config.adapter === "viralee"
        ? viraleePayload(config, input)
        : config.adapter === "meaicc"
          ? meaiccVideoPayload(config.model, input)
        : config.adapter === "maxforai"
          ? maxforaiVideoPayload(config.model, input)
        : config.adapter === "pidoi"
          ? pidoiVideoPayload(config.model, input)
        : genericPayload(config, input);
  const response = await upstream(`${config.baseUrl}/v1/videos`, {
    method: "POST",
    headers: authHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  }, submissionTimeoutForAdapter(config.adapter));
  const body = await readJson(response);
  const taskId = taskIdFrom(body);
  if (!taskId) throw httpError(502, "上游创建成功但没有返回任务 ID");
  return {
    adapter: config.adapter,
    baseUrl: config.baseUrl,
    taskId,
    statusPath: `/v1/videos/${encodeURIComponent(taskId)}`,
    model: config.model,
  };
}

function verifyJobConfig(config, job) {
  if (config.baseUrl !== job.baseUrl || config.adapter !== job.adapter)
    throw httpError(400, "任务所属中转站与当前配置不一致");
}

async function pollJob(config, job) {
  const response = await upstream(`${config.baseUrl}${job.statusPath}`, {
    headers: authHeaders(config),
  });
  const responseBody = await readJson(response);
  const body = config.adapter === "ziyuai" ? ziyuJobFrom(responseBody) : responseBody;
  const status = normalizeStatus(
    body?.status || body?.state || body?.task_status || body?.data?.status || body?.data?.state,
  );
  const result = {
    body,
    status,
    progress: normalizedTaskProgress(
      status,
      body?.progress ?? body?.percentage ?? body?.data?.progress ?? body?.data?.percentage ?? 0,
    ),
    videoUrl: videoUrlFrom(body, config.baseUrl),
  };
  if (result.status === "completed" && result.videoUrl) {
    const cacheKey = `${config.baseUrl}\n${job.taskId}`;
    completedVideoUrls.set(cacheKey, result.videoUrl);
    if (completedVideoUrls.size > 1000) {
      completedVideoUrls.delete(completedVideoUrls.keys().next().value);
    }
  }
  return result;
}

function streamResponse(response, res) {
  res.status(response.status);
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"]) {
    const value = response.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  if (!response.body) return res.end();
  Readable.fromWeb(response.body).pipe(res);
}

function sameSiteHost(leftUrl, rightUrl) {
  const left = leftUrl.hostname.toLowerCase();
  const right = rightUrl.hostname.toLowerCase();
  if (left === right) return true;
  const site = (host) => host.split(".").slice(-2).join(".");
  return site(left) === site(right);
}

app.use((req, _res, next) => {
  const length = Number(req.get("content-length") || 0);
  if (length > 220 * 1024 * 1024) return next(httpError(413, "上传素材总大小不能超过 220 MB"));
  next();
});

app.use(express.json({ limit: "16kb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

function secureCookie(req) {
  return (
    process.env.NODE_ENV === "production" ||
    req.secure ||
    String(req.get("x-forwarded-proto") || "").split(",")[0].trim() === "https"
  );
}

function currentSession(req) {
  if (!loginConfigured) return null;
  const token = cookieValue(req.get("cookie"), "workbench_session");
  return verifySessionToken(token, jobSecret);
}

app.get("/api/auth/session", (req, res) => {
  const session = currentSession(req);
  if (!session) return res.status(401).json({ authenticated: false });
  return res.json({ authenticated: true, username: session.username });
});

app.post("/api/auth/login", (req, res) => {
  if (!loginConfigured) {
    return res.status(503).json({ message: "服务器尚未配置工作台登录账号" });
  }
  const address = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const previous = loginAttempts.get(address);
  const recent = previous && now - previous.startedAt < 15 * 60 * 1000
    ? previous
    : { count: 0, startedAt: now };
  if (recent.count >= 5) return res.status(429).json({ message: "登录失败次数过多，请 15 分钟后再试" });

  const valid = verifyLoginCredentials(
    req.body?.username,
    req.body?.password,
    loginUsername,
    loginPassword,
  );
  if (!valid) {
    loginAttempts.set(address, { ...recent, count: recent.count + 1 });
    return res.status(401).json({ message: "用户名或密码错误" });
  }

  loginAttempts.delete(address);
  const token = createSessionToken(loginUsername, jobSecret);
  res.setHeader("Set-Cookie", sessionCookie(token, secureCookie(req)));
  return res.json({ authenticated: true, username: loginUsername });
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", clearedSessionCookie(secureCookie(req)));
  res.json({ authenticated: false });
});

app.use("/api", (req, res, next) => {
  if (!currentSession(req)) return res.status(401).json({ message: "请先登录工作台" });
  return next();
});

app.use("/api", (req, res, next) => {
  req.diagnostic = {
    requestId: String(req.get("x-diagnostic-request-id") || "").trim() || crypto.randomUUID(),
    startedAt: Date.now(),
    lastStage: "request_received",
  };
  res.on("close", () => {
    if (!res.writableEnded && ["POST", "PUT", "PATCH"].includes(req.method)) {
      writeDiagnostic(req, "client_connection_closed", { statusCode: res.statusCode });
    }
  });
  next();
});

app.get("/api/diagnostics", (req, res) => {
  const sessionId = String(req.query.sessionId || "").trim();
  const adapter = String(req.query.adapter || "").trim();
  if (!sessionId || !adapter) return res.status(400).json({ message: "诊断日志筛选参数不完整" });
  const entries = filterDiagnosticEntries(diagnosticEntries(), { sessionId, adapter }).slice(-2000);
  return res.json({ entries });
});

app.post("/api/diagnostics/clear", (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim();
  const adapter = String(req.body?.adapter || "").trim();
  if (!sessionId || !adapter) return res.status(400).json({ message: "诊断日志筛选参数不完整" });
  const entries = diagnosticEntries();
  const removed = filterDiagnosticEntries(entries, { sessionId, adapter }).length;
  const retained = entries.filter((entry) => entry.sessionId !== sessionId || entry.adapter !== adapter);
  try {
    writeFileSync(diagnosticLogPath, retained.length ? `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "");
  } catch (error) {
    return res.status(500).json({ message: error.message || "清空诊断日志失败" });
  }
  return res.json({ removed });
});

app.get("/api/storage/status", (_req, res) => {
  const storage = cosConfig();
  return res.json(storage
    ? {
        configured: true,
        provider: "Tencent COS",
        bucket: storage.bucket,
        region: storage.region,
        endpoint: `https://${storage.bucket}.cos.${storage.region}.myqcloud.com`,
      }
    : { configured: false });
});

app.get("/api/config/models", async (req, res, next) => {
  try {
    const config = providerConfig(req, false);
    if (config.adapter === "canseedream") {
      const keyCheck = await upstream(
        `${config.baseUrl}/api/v3/contents/generations/tasks/cstask_connection_test`,
        { headers: authHeaders(config) },
      );
      if ([401, 403].includes(keyCheck.status)) await readJson(keyCheck);
      const healthResponse = await upstream(`${config.baseUrl}/health`);
      const health = await readJson(healthResponse);
      const providers = Array.isArray(health?.defaults?.videoProviders)
        ? health.defaults.videoProviders
        : [];
      if (!providers.length) throw httpError(502, "CanSeeDream 当前没有返回可用视频线路");
      const capabilities = {};
      const labels = {};
      for (const provider of providers) {
        const id = String(provider?.id || "").trim();
        if (!id) continue;
        const limits = provider?.limits || {};
        const durations = provider?.duration === "auto"
          ? ["auto"]
          : Array.isArray(provider?.allowedDurations) && provider.allowedDurations.length
            ? provider.allowedDurations
            : [Number(provider?.durationSeconds) || 15];
        capabilities[id] = {
          images: Number(limits.maxImages) || 0,
          videos: Number(limits.maxVideos) || 0,
          audios: Number(limits.maxAudio) || 0,
          durations,
          resolutions: [String(provider?.resolution || "720p")],
          ratios: Array.isArray(limits.allowedRatios) && limits.allowedRatios.length
            ? limits.allowedRatios
            : ["16:9", "9:16", "1:1"],
          seed: false,
          syncAudio: true,
        };
        const cost = Number(provider?.pointsCost);
        labels[id] = `${provider?.label || id} · ${provider?.resolution || "720p"} · ${provider?.durationLabel || "自动"}${Number.isFinite(cost) ? ` · ${cost}积分` : ""}`;
      }
      return res.json({ models: Object.keys(capabilities), capabilities, labels });
    }
    if (config.adapter === "ziyuai") {
      const response = await upstream(`${config.baseUrl}/api/v1/models`, { headers: authHeaders(config) });
      const body = await readJson(response);
      const catalog = ziyuModels(body);
      if (!catalog.models.length) throw httpError(502, "紫域 AI 当前没有返回可用视频模型");
      return res.json(catalog);
    }
    if (config.adapter === "clmm") {
      const response = await upstream(`${CLMM_BASE_URL}/v1/api/pricing`, { headers: authHeaders(config) });
      const models = clmmModels(await readJson(response));
      if (!models.length) throw httpError(502, "CLMM Mall 当前没有返回可用视频模型");
      return res.json({ models });
    }
    if (config.adapter === "pidoi") {
      return res.json({ models: PIDOI_MODELS });
    }
    const response = await upstream(`${config.baseUrl}/v1/models`, { headers: authHeaders(config) });
    if (!response.ok && [404, 405, 501].includes(response.status)) {
      const fallback = fallbackModels(config.adapter);
      if (fallback.length) return res.json({ models: fallback, warning: "模型列表接口不可用，已使用公开文档中的模型" });
    }
    const body = await readJson(response);
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    let models = list.map((item) => (typeof item === "string" ? item : item?.id || item?.name)).filter(Boolean);
    if (config.adapter === "lwaigc") {
      const documentedVideoModels = new Set(LWAIGC_VIDEO_MODELS);
      models = models.filter((model) => documentedVideoModels.has(model));
    }
    if (config.adapter === "globalaiopc") {
      models = [...new Set([...models, ...GLOBAL_AIOPC_MODELS])];
    }
    if (config.adapter === "maxforai") {
      const allowed = new Set(MAXFORAI_VIDEO_MODELS);
      models = [...new Set([...models.filter((model) => allowed.has(model)), ...MAXFORAI_VIDEO_MODELS])];
    }
    res.json({
      models: config.adapter === "lwaigc" ? models : models.length ? models : fallbackModels(config.adapter),
    });
  } catch (error) {
    const adapter = (() => {
      try { return providerConfig(req, false).adapter; } catch { return ""; }
    })();
    const fallback = fallbackModels(adapter);
    if (fallback.length && error.status >= 500) return res.json({ models: fallback, warning: error.message });
    next(error);
  }
});

app.post("/api/materials", upload.array("references", 50), async (req, res, next) => {
  const files = Array.isArray(req.files) ? req.files : [];
  try {
    for (const file of files) fileBytes(file);
    const config = providerConfig(req, false);
    writeDiagnostic(req, "materials_request_parsed", {
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + Number(file.size || 0), 0),
    });
    let meta;
    try {
      meta = JSON.parse(req.body.referenceMeta || "[]");
    } catch {
      throw httpError(400, "预上传素材信息无效");
    }
    if (!Array.isArray(meta) || meta.length !== files.length || meta.length > 50)
      throw httpError(400, "预上传素材数量无效");
    const prepareStartedAt = Date.now();
    writeDiagnostic(req, "materials_prepare_started", { materialCount: meta.length });
    const materials = await prepareMaterials(config, files, meta, req);
    writeDiagnostic(req, "materials_prepare_completed", {
      durationMs: Date.now() - prepareStartedAt,
      materialCount: materials.length,
      kinds: materials.reduce((result, item) => ({ ...result, [item.kind]: (result[item.kind] || 0) + 1 }), {}),
    });
    res.json({
      materials: materials.map((item) => ({
        key: item.projectAssetKey || item.key || item.tag,
        kind: item.kind,
        name: item.name,
        url: item.url,
        durationSeconds: item.durationSeconds || null,
      })),
      expiresAt: Date.now() + 50 * 60 * 1000,
    });
    writeDiagnostic(req, "materials_response_sent", { materialCount: materials.length });
  } catch (error) {
    writeDiagnostic(req, "materials_failed", { error: error?.message || "素材预上传失败", status: error?.status || 500 });
    next(error);
  } finally {
    cleanupFiles(files);
  }
});

app.post("/api/tasks", upload.array("references", 50), async (req, res, next) => {
  const files = Array.isArray(req.files) ? req.files : [];
  try {
    // Multer 完成接收后立即把素材读入内存，避免系统清理临时目录或
    // 多素材逐个转链期间文件被移除，导致后续 readFile 出现 ENOENT。
    for (const file of files) fileBytes(file);
    const config = providerConfig(req);
    writeDiagnostic(req, "task_request_parsed", {
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + Number(file.size || 0), 0),
    });
    const rawPrompt = String(req.body.prompt || "").trim();
    if (!rawPrompt) throw httpError(400, "提示词不能为空");
    let meta;
    try {
      meta = JSON.parse(req.body.referenceMeta || "[]");
    } catch {
      throw httpError(400, "参考素材信息无效");
    }
    if (!Array.isArray(meta) || meta.length > 50) throw httpError(400, "参考素材数量无效");
    const requestedDuration = safeNumber(req.body.duration, 5, 1, 60);
    validateLwaigcLimits(config, meta, requestedDuration);
    validateMeaiccLimits(config, meta, requestedDuration);
    validateProviderLimits(config, meta, requestedDuration);
    if (config.adapter === "clmm") {
      const issue = clmmLimitIssue(config.model, meta, requestedDuration);
      if (issue) throw httpError(400, issue);
    }
    const prepareStartedAt = Date.now();
    writeDiagnostic(req, "task_materials_prepare_started", { materialCount: meta.length });
    const materials = await prepareMaterials(config, files, meta, req);
    writeDiagnostic(req, "task_materials_prepare_completed", {
      durationMs: Date.now() - prepareStartedAt,
      materialCount: materials.length,
      cachedUrlCount: meta.filter((item) => item.url).length,
    });
    const prompt = withReferenceMapping(
      rawPrompt,
      materials,
      String(req.body.autoReference || "true") !== "false",
    );
    if (config.adapter === "pidoi" && config.model === "tejiasd" && prompt.length > 2500)
      throw httpError(400, `Pidoi tejiasd 提示词最多 2500 字，当前为 ${prompt.length} 字`);
    const input = {
      prompt,
      materials,
      duration: requestedDuration,
      resolution: ["480p", "720p", "1080p", "2K", "4K"].includes(req.body.resolution)
        ? req.body.resolution
        : "720p",
      aspectRatio: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "auto", "adaptive"].includes(req.body.aspectRatio)
        ? req.body.aspectRatio
        : "16:9",
      seed: String(req.body.seed || "").trim()
        ? safeNumber(req.body.seed, 0, 0, 2147483647)
        : null,
      syncAudio: String(req.body.syncAudio || "false") === "true",
    };
    if (config.adapter === "lwaigc" && isLwaigcDqModel(config.model) && Number(input.seed) > 999999999)
      throw httpError(400, "DQ Seedance 2.0 的随机种子必须在 0–999999999 之间");
    const quantity = safeNumber(req.body.quantity, 1, 1, 4);
    const providerStartedAt = Date.now();
    writeDiagnostic(req, "provider_submit_started", {
      quantity,
      duration: requestedDuration,
      materialCounts: materials.reduce((result, item) => ({ ...result, [item.kind]: (result[item.kind] || 0) + 1 }), {}),
    });
    const jobs = await Promise.all(Array.from({ length: quantity }, () => createVideo(config, input)));
    writeDiagnostic(req, "provider_task_ids_received", {
      durationMs: Date.now() - providerStartedAt,
      quantity: jobs.length,
      upstreamTaskIds: jobs.map((job) => job.taskId),
    });
    const createdAt = new Date().toLocaleString("zh-CN", { hour12: false });
    const tasks = jobs.map((job) => ({
      id: encodeJob(job),
      status: "queued",
      progress: 0,
      createdAt,
    }));
    res.status(202).json({ tasks });
    writeDiagnostic(req, "task_response_sent", { quantity: tasks.length });
  } catch (error) {
    writeDiagnostic(req, "task_submission_failed", {
      error: error?.message || "任务提交失败",
      status: error?.status || (error?.name === "TimeoutError" ? 504 : 500),
      ambiguous: isAmbiguousMeaiccSubmission(error, req),
    });
    next(error);
  } finally {
    cleanupFiles(files);
  }
});

app.post("/api/tasks/recover", async (req, res, next) => {
  try {
    const config = providerConfig(req);
    if (config.adapter !== "meaicc") throw httpError(400, "当前仅支持找回 MEAICC 任务");
    const taskIds = Array.isArray(req.body?.taskIds)
      ? req.body.taskIds.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    if (!taskIds.length || taskIds.length > 50) throw httpError(400, "请输入 1—50 个 MEAICC 任务 ID");
    const validMeaiccTaskId = /^(?:wr_[0-9a-f-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
    if (taskIds.some((taskId) => !validMeaiccTaskId.test(taskId)))
      throw httpError(400, "MEAICC 任务 ID 格式不正确");
    const createdAt = new Date().toLocaleString("zh-CN", { hour12: false });
    res.json({
      tasks: taskIds.map((taskId) => ({
        id: encodeJob({
          adapter: config.adapter,
          baseUrl: config.baseUrl,
          taskId,
          statusPath: `/v1/videos/${encodeURIComponent(taskId)}`,
          model: config.model,
        }),
        upstreamTaskId: taskId,
        status: "queued",
        progress: 0,
        createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:id", async (req, res, next) => {
  try {
    const config = providerConfig(req);
    const job = decodeJob(req.params.id);
    verifyJobConfig(config, job);
    const pollStartedAt = Date.now();
    const result = await pollJob(config, job);
    const failure = result.status === "failed" ? taskFailureDetails(result.body) : null;
    writeDiagnostic(req, "task_status_received", {
      durationMs: Date.now() - pollStartedAt,
      upstreamTaskId: job.taskId,
      taskStatus: result.status,
      progress: result.progress,
      failureReason: failure?.reason,
      failureCode: failure?.code,
    });
    res.json({
      id: req.params.id,
      status: result.status,
      progress: result.progress,
      videoUrl: result.status === "completed" ? `/api/tasks/${encodeURIComponent(req.params.id)}/content` : undefined,
      error: failure?.reason,
      cost: result.body?.cost ?? result.body?.usage?.cost ?? result.body?.metadata?.cost,
      completedAt: dateText(result.body?.completed_at || result.body?.completedAt),
    });
  } catch (error) {
    writeDiagnostic(req, "task_status_failed", { error: error?.message || "查询任务状态失败", status: error?.status || 500 });
    next(error);
  }
});

app.get("/api/tasks/:id/content", async (req, res, next) => {
  try {
    const config = providerConfig(req);
    const job = decodeJob(req.params.id);
    verifyJobConfig(config, job);
    const range = req.get("range");
    if (config.adapter !== "canseedream" && config.adapter !== "meaicc" && config.adapter !== "ziyuai" && config.adapter !== "globalaiopc" && config.adapter !== "clmm" && config.adapter !== "pidoi") {
      const fixedResponse = await upstream(
        `${config.baseUrl}/v1/videos/${encodeURIComponent(job.taskId)}/content`,
        { headers: authHeaders(config, range ? { Range: range } : {}) },
        1_800_000,
      );
      if (fixedResponse.ok) return streamResponse(fixedResponse, res);
    }

    const cachedVideoUrl = completedVideoUrls.get(`${config.baseUrl}\n${job.taskId}`);
    const result = cachedVideoUrl
      ? { status: "completed", videoUrl: cachedVideoUrl }
      : await pollJob(config, job);
    if (result.status !== "completed") throw httpError(409, "视频尚未生成完成");
    const candidateUrls = cachedVideoUrl
      ? [cachedVideoUrl]
      : videoUrlsFrom(result.body, config.baseUrl);
    if (result.videoUrl && !candidateUrls.includes(result.videoUrl)) candidateUrls.unshift(result.videoUrl);
    if (!candidateUrls.length) throw httpError(502, "任务已完成但没有返回视频地址");
    const providerUrl = new URL(config.baseUrl);
    let lastStatus = 502;
    let attemptedUrls = 0;
    const tryCandidateUrls = async (urls) => {
      for (const candidateUrl of urls) {
        attemptedUrls += 1;
        const resultUrl = publicUrl(candidateUrl, "视频地址");
        const sameProvider = resultUrl.origin === providerUrl.origin || sameSiteHost(resultUrl, providerUrl);
        const headers = {
          Accept: "video/*,*/*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
          Referer: `${providerUrl.origin}/`,
          ...(range ? { Range: range } : {}),
        };
        let response = await upstream(resultUrl, { headers }, 1_800_000);
        if (!response.ok && sameProvider) {
          await response.body?.cancel().catch(() => {});
          response = await upstream(resultUrl, {
            headers: { ...headers, Authorization: `Bearer ${config.apiKey}` },
          }, 1_800_000);
        }
        if (response.ok) {
          streamResponse(response, res);
          return true;
        }
        lastStatus = response.status;
        await response.body?.cancel().catch(() => {});
      }
      return false;
    };
    if (await tryCandidateUrls(candidateUrls)) return;

    // MEAICC 的 object 字段通常是带有效期签名的 OSS 地址。缓存地址失效时，
    // 重新查询任务可以取得一条新的签名地址，再继续本次下载。
    if (config.adapter === "meaicc" && cachedVideoUrl) {
      completedVideoUrls.delete(`${config.baseUrl}\n${job.taskId}`);
      const refreshed = await pollJob(config, job);
      if (refreshed.status === "completed") {
        const refreshedUrls = videoUrlsFrom(refreshed.body, config.baseUrl)
          .filter((url) => !candidateUrls.includes(url));
        if (refreshed.videoUrl && !refreshedUrls.includes(refreshed.videoUrl) && !candidateUrls.includes(refreshed.videoUrl))
          refreshedUrls.unshift(refreshed.videoUrl);
        if (await tryCandidateUrls(refreshedUrls)) return;
      }
    }
    if (config.adapter === "viralee" && lastStatus === 404) {
      throw httpError(410, "ViralE 返回的视频结果地址已经失效（上游 HTTP 404），请让中转站刷新下载地址或到中转站任务记录中下载");
    }
    throw httpError(lastStatus, `读取生成视频失败：已尝试 ${attemptedUrls} 个结果地址（最后 HTTP ${lastStatus}）`);
  } catch (error) {
    next(error);
  }
});

if (!process.argv.includes("--api-only")) {
  app.use(express.static(path.join(rootDir, "dist")));
  app.get("*", (_req, res) => res.sendFile(path.join(rootDir, "dist", "index.html")));
}

function isAmbiguousMeaiccSubmission(error, req) {
  if (req.method !== "POST" || req.path !== "/api/tasks") return false;
  if (String(req.get("x-api-adapter") || "").toLowerCase() !== "meaicc") return false;
  const status = Number(error?.status || 0);
  const message = String(error?.message || "");
  return [408, 502, 504, 520, 522, 523, 524].includes(status)
    || /fetch failed|timeout|timed out|network|socket|ECONNRESET|UND_ERR/i.test(message);
}

app.use((error, req, res, _next) => {
  if (isAmbiguousMeaiccSubmission(error, req)) {
    return res.status(502).json({
      code: "SUBMISSION_UNKNOWN",
      submissionUnknown: true,
      message: "MEAICC 可能已经收到任务，但连接超时，工作台没有拿到任务 ID。请先到中转后台核对；为避免重复扣费，本条不会自动重试。",
    });
  }
  const status = Number(
    error?.status ||
      (error instanceof multer.MulterError ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 400) : 0) ||
      (error?.name === "TimeoutError" ? 504 : 500),
  );
  res.status(status >= 400 && status < 600 ? status : 500).json({
    message: error?.message || "服务器处理失败",
  });
});

app.listen(port, () => console.log(`AI Video Workbench server listening on ${port}`));
