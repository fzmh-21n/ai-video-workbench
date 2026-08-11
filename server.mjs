import express from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import {
  existsSync,
  mkdirSync,
  readFileSync,
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
import { normalizedTaskProgress } from "./src/taskProgress.js";
import { friendlyUpstreamError } from "./src/upstreamError.js";

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
const automaticUploadServices = ["Litterbox", "Uguu", "Tmpfiles"];
mkdirSync(dataDir, { recursive: true });
mkdirSync(uploadDir, { recursive: true });

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
  return "newapi";
}

function providerConfig(req, requireModel = true) {
  let resolvedBaseUrl = baseUrl(req.get("x-api-base-url"));
  const apiKey = String(req.get("x-api-key") || "").trim();
  const model = String(req.get("x-api-model") || "").trim();
  const requestedAdapter = String(req.get("x-api-adapter") || "").trim();
  const adapter = ["fmgo", "paipu", "viralee", "canseedream", "lwaigc", "meaicc", "ziyuai", "globalaiopc", "newapi"].includes(requestedAdapter)
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

async function uploadTemporaryMedia(file, material = {}) {
  const displayName = String(material.name || file.originalname || "本地素材");
  const bytes = fileBytes(file);
  const errors = [];

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
      return publicUrl(value, "自动素材 URL").toString();
    }
    errors.push(`Litterbox: HTTP ${response.status}`);
  } catch (error) {
    errors.push(`Litterbox: ${error?.message || "连接失败"}`);
  }

  try {
    const form = new FormData();
    form.set("files[]", new Blob([bytes], { type: file.mimetype || "application/octet-stream" }), displayName);
    const response = await upstream("https://uguu.se/upload", { method: "POST", body: form }, 180_000);
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}
    const value = body?.files?.[0]?.url;
    if (response.ok && body?.success && /^https:\/\/[^/]+\.uguu\.se\//i.test(String(value || ""))) {
      return publicUrl(value, "自动素材 URL").toString();
    }
    errors.push(`Uguu: HTTP ${response.status}${body?.description ? ` ${body.description}` : ""}`);
  } catch (error) {
    errors.push(`Uguu: ${error?.message || "连接失败"}`);
  }

  try {
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: file.mimetype || "application/octet-stream" }), displayName);
    const response = await upstream("https://tmpfiles.org/api/v1/upload", { method: "POST", body: form }, 180_000);
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}
    const value = body?.data?.url;
    if (response.ok && /^https:\/\/tmpfiles\.org\//i.test(String(value || ""))) {
      return publicUrl(tmpfilesDirectUrl(value), "自动素材 URL").toString();
    }
    errors.push(`Tmpfiles: HTTP ${response.status}${body?.status ? ` ${body.status}` : ""}`);
  } catch (error) {
    errors.push(`Tmpfiles: ${error?.message || "连接失败"}`);
  }

  throw httpError(
    502,
    `自动临时转链失败：${displayName}。已尝试 ${automaticUploadServices.join("、")}。${errors.join("；")}。可以稍后重试，或填写自己的上传地址。`,
  );
}

async function uploadMedia(config, file, material = {}) {
  if (mediaUploadMode(config, file.mimetype) === "temporary") {
    return uploadTemporaryMedia(file, material);
  }
  const displayName = String(material.name || file.originalname || "本地素材");
  const bytes = fileBytes(file);
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
    return publicUrl(value, "紫域 AI 素材 URL").toString();
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

async function prepareMaterials(config, files, meta) {
  const materials = [];
  for (const item of meta) {
    const kind = ["image", "audio", "video"].includes(item.kind) ? item.kind : "image";
    if (item.url) {
      const url = config.adapter === "lwaigc"
        ? await importLwaigcMedia(config, item.url)
        : publicUrl(item.url, "素材 URL").toString();
      materials.push({ ...item, kind, url });
      continue;
    }
    const file = files[Number(item.fileIndex)];
    if (!file) throw httpError(400, `找不到素材文件：${item.name || item.tag}`);
    let url;
    if (kind === "image" && config.adapter === "newapi" && !config.mediaUploadUrl) {
      url = imageDataUrl(file);
    } else {
      url = await uploadMedia(config, file, item);
    }
    materials.push({ ...item, kind, url });
  }
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
        : genericPayload(config, input);
  const response = await upstream(`${config.baseUrl}/v1/videos`, {
    method: "POST",
    headers: authHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  }, 180_000);
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
    let meta;
    try {
      meta = JSON.parse(req.body.referenceMeta || "[]");
    } catch {
      throw httpError(400, "预上传素材信息无效");
    }
    if (!Array.isArray(meta) || meta.length !== files.length || meta.length > 50)
      throw httpError(400, "预上传素材数量无效");
    const materials = await prepareMaterials(config, files, meta);
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
  } catch (error) {
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
    const materials = await prepareMaterials(config, files, meta);
    const prompt = withReferenceMapping(
      rawPrompt,
      materials,
      String(req.body.autoReference || "true") !== "false",
    );
    const input = {
      prompt,
      materials,
      duration: requestedDuration,
      resolution: ["480p", "720p", "1080p", "4K"].includes(req.body.resolution)
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
    const quantity = safeNumber(req.body.quantity, 1, 1, 4);
    const jobs = await Promise.all(Array.from({ length: quantity }, () => createVideo(config, input)));
    const createdAt = new Date().toLocaleString("zh-CN", { hour12: false });
    const tasks = jobs.map((job) => ({
      id: encodeJob(job),
      status: "queued",
      progress: 0,
      createdAt,
    }));
    res.status(202).json({ tasks });
  } catch (error) {
    next(error);
  } finally {
    cleanupFiles(files);
  }
});

app.get("/api/tasks/:id", async (req, res, next) => {
  try {
    const config = providerConfig(req);
    const job = decodeJob(req.params.id);
    verifyJobConfig(config, job);
    const result = await pollJob(config, job);
    res.json({
      id: req.params.id,
      status: result.status,
      progress: result.progress,
      videoUrl: result.status === "completed" ? `/api/tasks/${encodeURIComponent(req.params.id)}/content` : undefined,
      error: result.status === "failed" ? errorFrom(result.body) : undefined,
      cost: result.body?.cost ?? result.body?.usage?.cost ?? result.body?.metadata?.cost,
      completedAt: dateText(result.body?.completed_at || result.body?.completedAt),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:id/content", async (req, res, next) => {
  try {
    const config = providerConfig(req);
    const job = decodeJob(req.params.id);
    verifyJobConfig(config, job);
    const range = req.get("range");
    if (config.adapter !== "canseedream" && config.adapter !== "meaicc" && config.adapter !== "ziyuai" && config.adapter !== "globalaiopc") {
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

app.use((error, _req, res, _next) => {
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
