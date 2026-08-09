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
const automaticUploadServices = ["Litterbox", "Uguu"];
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
  return "newapi";
}

function providerConfig(req, requireModel = true) {
  let resolvedBaseUrl = baseUrl(req.get("x-api-base-url"));
  const apiKey = String(req.get("x-api-key") || "").trim();
  const model = String(req.get("x-api-model") || "").trim();
  const requestedAdapter = String(req.get("x-api-adapter") || "").trim();
  const adapter = ["fmgo", "paipu", "viralee", "canseedream", "newapi"].includes(requestedAdapter)
    ? requestedAdapter
    : inferAdapter(resolvedBaseUrl);
  // canseedream.com 目前会 301 跳转至 see.ximeiedu.org。跨域跳转会按
  // Fetch 安全规则移除 Authorization，导致正确的 SK 也被上游判为缺失。
  // 同时兼容用户浏览器里已经保存的旧地址，直接改用当前官方接口域名。
  if (adapter === "canseedream" && new URL(resolvedBaseUrl).hostname === "canseedream.com")
    resolvedBaseUrl = "https://see.ximeiedu.org";
  const rawUploadUrl = String(req.get("x-media-upload-url") || "").trim();
  const mediaUploadUrl = rawUploadUrl ? publicUrl(rawUploadUrl, "素材上传地址").toString() : "";
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
    throw httpError(response.status, String(message));
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
      "",
  ).trim();
}

function normalizeStatus(value) {
  const status = String(value || "queued").toLowerCase();
  if (["completed", "succeeded", "success"].includes(status)) return "completed";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  if (["queued", "pending", "waiting", "submitted"].includes(status)) return "queued";
  return "processing";
}

function videoUrlFrom(body, base) {
  const candidates = [
    body?.video_url,
    body?.result_url,
    body?.url,
    body?.file_url,
    body?.metadata?.url,
    body?.content?.video_url,
    body?.video?.url,
    body?.output?.url,
    body?.result?.url,
    body?.data?.video_url,
    body?.data?.result_url,
    body?.data?.url,
    body?.data?.metadata?.url,
    body?.data?.[0]?.url,
    body?.data?.[0]?.video_url,
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  if (!value) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function errorFrom(body) {
  return String(body?.error?.message || body?.error || body?.message || "视频生成失败");
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

  throw httpError(
    502,
    `自动临时转链失败：${displayName}。已尝试 ${automaticUploadServices.join("、")}。${errors.join("；")}。可以稍后重试，或填写自己的上传地址。`,
  );
}

async function uploadMedia(config, file, material = {}) {
  if (!config.mediaUploadUrl) return uploadTemporaryMedia(file, material);
  const displayName = String(material.name || file.originalname || "本地素材");
  const kindLabel = material.kind === "audio" ? "音频" : material.kind === "video" ? "视频" : "图片";
  if (
    new URL(config.mediaUploadUrl).hostname === "api.paipu.net" &&
    !String(file.mimetype || "").startsWith("image/")
  ) {
    throw httpError(400, `Paipu 的公开上传接口目前只支持图片；本地${kindLabel}“${displayName}”请使用公网素材 URL`);
  }
  const bytes = fileBytes(file);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: file.mimetype || "application/octet-stream" }), displayName);
  const response = await upstream(
    config.mediaUploadUrl,
    { method: "POST", headers: { Authorization: `Bearer ${config.mediaUploadKey}` }, body: form },
    180_000,
  );
  const body = await readJson(response);
  const value = body?.url || body?.data?.url || body?.data?.[0]?.url;
  if (!value) throw httpError(502, `素材上传成功但没有返回 URL：${displayName}`);
  return publicUrl(value, "素材 URL").toString();
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
      materials.push({ ...item, kind, url: publicUrl(item.url, "素材 URL").toString() });
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
    attachImages();
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
    if (images.length)
      payload.content = images.map((item) => ({ type: "image_url", image_url: { url: item.url }, sub_type: "reference" }));
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

async function createVideo(config, input) {
  if (config.adapter === "fmgo") return createFmgo(config, input);
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
  const payload =
    config.adapter === "paipu"
      ? paipuPayload(config, input)
      : config.adapter === "viralee"
        ? viraleePayload(config, input)
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
  const body = await readJson(response);
  return {
    body,
    status: normalizeStatus(
      body?.status || body?.state || body?.task_status || body?.data?.status || body?.data?.state,
    ),
    progress: safeNumber(
      body?.progress ?? body?.percentage ?? body?.data?.progress ?? body?.data?.percentage ?? 0,
      0,
      0,
      100,
    ),
    videoUrl: videoUrlFrom(body, config.baseUrl),
  };
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

app.use((req, _res, next) => {
  const length = Number(req.get("content-length") || 0);
  if (length > 220 * 1024 * 1024) return next(httpError(413, "上传素材总大小不能超过 220 MB"));
  next();
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

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
    const response = await upstream(`${config.baseUrl}/v1/models`, { headers: authHeaders(config) });
    if (!response.ok && [404, 405, 501].includes(response.status)) {
      const fallback = fallbackModels(config.adapter);
      if (fallback.length) return res.json({ models: fallback, warning: "模型列表接口不可用，已使用公开文档中的模型" });
    }
    const body = await readJson(response);
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    const models = list.map((item) => (typeof item === "string" ? item : item?.id || item?.name)).filter(Boolean);
    res.json({ models: models.length ? models : fallbackModels(config.adapter) });
  } catch (error) {
    const adapter = (() => {
      try { return providerConfig(req, false).adapter; } catch { return ""; }
    })();
    const fallback = fallbackModels(adapter);
    if (fallback.length && error.status >= 500) return res.json({ models: fallback, warning: error.message });
    next(error);
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
    const materials = await prepareMaterials(config, files, meta);
    const prompt = withReferenceMapping(
      rawPrompt,
      materials,
      String(req.body.autoReference || "true") !== "false",
    );
    const input = {
      prompt,
      materials,
      duration: safeNumber(req.body.duration, 5, 1, 60),
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
    if (config.adapter !== "canseedream") {
      const fixedResponse = await upstream(
        `${config.baseUrl}/v1/videos/${encodeURIComponent(job.taskId)}/content`,
        { headers: authHeaders(config, range ? { Range: range } : {}) },
        1_800_000,
      );
      if (fixedResponse.ok) return streamResponse(fixedResponse, res);
    }

    const result = await pollJob(config, job);
    if (result.status !== "completed") throw httpError(409, "视频尚未生成完成");
    if (!result.videoUrl) throw httpError(502, "任务已完成但没有返回视频地址");
    const resultUrl = publicUrl(result.videoUrl, "视频地址");
    const sameProvider = resultUrl.origin === config.baseUrl;
    const headers = { Accept: "video/*,*/*", ...(range ? { Range: range } : {}) };
    if (sameProvider) headers.Authorization = `Bearer ${config.apiKey}`;
    const response = await upstream(resultUrl, { headers }, 1_800_000);
    if (!response.ok) throw httpError(response.status, "读取生成视频失败");
    return streamResponse(response, res);
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
