export const BAOJU_BASE_URL = "https://aimjbbb.cn";

function values(items) {
  return [...new Set((Array.isArray(items) ? items : []).filter((value) => typeof value === "string" && value.trim()))];
}

function rawCapability(cap) {
  return cap?._baojuCapabilities || cap || {};
}

function referenceLimit(value) {
  const maximum = value?.maximum;
  return Number.isInteger(maximum) && maximum >= 0 ? Math.min(15, maximum) : 15;
}

function durationValues(duration) {
  if (Array.isArray(duration?.allowed)) return [...new Set(duration.allowed.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  if (Number.isInteger(duration?.minimum) && Number.isInteger(duration?.maximum) && duration.minimum > 0 && duration.maximum >= duration.minimum && duration.maximum - duration.minimum < 1000) {
    return Array.from({ length: duration.maximum - duration.minimum + 1 }, (_, index) => duration.minimum + index);
  }
  return Number.isInteger(duration?.default) && duration.default > 0 ? [duration.default] : [];
}

function durationDeclared(duration) {
  return duration && typeof duration === "object" && !Array.isArray(duration) && (
    [duration.minimum, duration.maximum, duration.default].some((value) => Number.isInteger(value) && value > 0) ||
    Array.isArray(duration.allowed) && duration.allowed.some((value) => Number.isInteger(value) && value > 0)
  );
}

export function baojuCapability(cap = {}, model = "") {
  const source = rawCapability(cap);
  return {
    images: referenceLimit(source.references?.image),
    videos: referenceLimit(source.references?.video),
    audios: referenceLimit(source.references?.audio),
    durations: durationValues(source.duration_seconds),
    resolutions: values(source.resolutions),
    ratios: values(source.aspect_ratios),
    ...(Number.isInteger(source.duration_seconds?.default) && source.duration_seconds.default > 0 ? { defaultDuration: source.duration_seconds.default } : {}),
    seed: false, syncAudio: false, syncAudioFixed: true,
    _sdVersion: /(?:seedance|sd)[-. ]?2[.-]?5/i.test(model) ? "sd25" : "sd20",
    _preserveLimits: true,
    _baojuCapabilities: source,
  };
}

export function baojuModels(body) {
  const models = [];
  const capabilities = {};
  const labels = {};
  for (const row of Array.isArray(body?.data) ? body.data : []) {
    if (typeof row?.id !== "string" || !row.id.trim() || models.includes(row.id)) continue;
    const id = row.id;
    const capability = baojuCapability(row.capabilities, `${id} ${row.name || ""}`);
    models.push(id);
    capabilities[id] = capability;
    const billing = row.billing || {};
    const unit = billing.mode === "per_second" ? "积分/秒" : billing.mode === "per_request" ? "积分/次" : "";
    const price = typeof billing.credits_per_unit === "number" && Number.isFinite(billing.credits_per_unit) && unit ? `${billing.credits_per_unit}${unit}` : "";
    const resolutionPrices = (Array.isArray(billing.resolution_prices) ? billing.resolution_prices : []).filter((item) => typeof item?.resolution === "string" && typeof item.credits_per_unit === "number" && Number.isFinite(item.credits_per_unit)).map((item) => `${item.resolution} ${item.credits_per_unit}${item.mode === "per_second" ? "积分/秒" : item.mode === "per_request" ? "积分/次" : unit}`).join("/");
    labels[id] = [row.name || id, resolutionPrices || price, capability.resolutions.join("/"), capability.durations.length ? `${capability.durations[0]}${capability.durations.length > 1 ? `–${capability.durations.at(-1)}` : ""}秒` : "", `${capability.images}图/${capability.videos}视频/${capability.audios}音频`].filter(Boolean).join(" · ");
  }
  return { models, labels, capabilities };
}

function publicUrl(value) {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host.includes(".") && !host.startsWith("[")) return false;
    if (/(?:^|\.)(?:localhost|local|internal|lan)$/.test(host)) return false;
    if (host.startsWith("[")) return !/^\[(?:::|::1|::ffff:|f[cd]|fe[89ab]|ff)/i.test(host);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split(".").map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function payloadFor(model, input, source) {
  const payload = { model, prompt: input.prompt };
  if (durationDeclared(source.duration_seconds) && input.duration != null && input.duration !== "") payload.duration_seconds = Number(input.duration);
  if (values(source.aspect_ratios).length && input.aspectRatio) payload.aspect_ratio = input.aspectRatio;
  if (values(source.resolutions).length && input.resolution) payload.resolution = input.resolution;
  for (const kind of ["image", "video", "audio"]) {
    const urls = (Array.isArray(input.materials) ? input.materials : []).filter((item) => item?.kind === kind).map((item) => item.url);
    if (urls.length) payload[`${kind}_urls`] = urls;
  }
  return payload;
}

export function baojuInputIssue(cap, input = {}, model = "") {
  const source = rawCapability(cap);
  if (typeof input.prompt !== "string" || !input.prompt.trim() || [...input.prompt].length > 50000) return "Baoju 提示词必须为 1–50000 个字符";
  if (input.duration != null && input.duration !== "" && (!Number.isInteger(Number(input.duration)) || Number(input.duration) < 1 || Number(input.duration) > 600)) return "Baoju 视频时长必须为 1–600 秒的整数";
  const duration = source.duration_seconds;
  if (durationDeclared(duration) && input.duration != null && input.duration !== "") {
    const selected = Number(input.duration);
    if (!Number.isInteger(selected) || selected < 1 || Number.isFinite(duration.minimum) && selected < duration.minimum || Number.isFinite(duration.maximum) && selected > duration.maximum || duration.allowed?.length && !duration.allowed.includes(selected)) return "Baoju 当前模型不支持所选时长";
  }
  for (const [field, selected, label] of [["aspect_ratios", input.aspectRatio, "比例"], ["resolutions", input.resolution, "分辨率"]]) {
    const options = values(source[field]);
    if (options.length && selected && !options.includes(selected)) return `Baoju 当前模型不支持所选${label}`;
  }
  const materials = Array.isArray(input.materials) ? input.materials : [];
  if (materials.some((item) => !["image", "video", "audio"].includes(item?.kind))) return "Baoju 参考素材类型不支持";
  for (const kind of ["image", "video", "audio"]) {
    const items = materials.filter((item) => item.kind === kind);
    const limit = referenceLimit(source.references?.[kind]);
    if (items.length > limit) return `Baoju ${kind} 参考最多 ${limit} 个`;
    if (items.some((item) => !publicUrl(item.url))) return "Baoju 素材必须使用不超过 8192 字符的公网 HTTP(S) URL，不能使用本地路径、内网地址或 Data URL";
  }
  if (new TextEncoder().encode(JSON.stringify(payloadFor(model, input, source))).length > 256 * 1024) return "Baoju 请求正文超过 256 KiB 上限";
  return "";
}

export function baojuPayload(model, input, capability = {}) {
  const issue = typeof model !== "string" || !model.trim() ? "Baoju 缺少模型 ID" : baojuInputIssue(capability, input, model);
  if (issue) {
    const error = new Error(issue);
    error.status = 400;
    throw error;
  }
  return payloadFor(model, input, rawCapability(capability));
}

export function baojuTaskResult(body, baseUrl = BAOJU_BASE_URL) {
  if (typeof body?.id !== "string" || !body.id) throw new Error(typeof body?.error === "string" ? body.error : body?.error?.message || "Baoju 没有返回任务 ID");
  const expired = body.status === "expired" || body.result_state === "expired";
  const failed = expired || ["failed", "cancelled"].includes(body.status) || ["failed", "cancelled"].includes(body.result_state);
  let videoUrl = "";
  if (!failed && body.status === "succeeded" && body.result_state === "ready") {
    for (const output of Array.isArray(body.output) ? body.output : []) {
      if (typeof output?.content_url !== "string" || !output.content_url.trim()) continue;
      try {
        const url = new URL(output.content_url, baseUrl);
        if (url.origin === new URL(baseUrl).origin && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password) { videoUrl = url.toString(); break; }
      } catch {}
    }
  }
  const status = failed ? "failed" : videoUrl ? "completed" : body.status === "queued" ? "queued" : "processing";
  const error = expired ? `Baoju 结果已过期；请查询原任务，不要重新生成${typeof body.error === "string" && body.error ? `：${body.error}` : ""}` : body.error;
  const progress = status === "completed" ? 100 : status === "failed" ? 0 : Math.max(0, Math.min(99, Number(body.progress) || 0));
  const seconds = Number(body.poll_after_seconds);
  return { ...body, status, progress, error, videoUrl, ...(expired ? { retryable: false, autoRetryBlocked: true } : {}), ...(seconds > 0 && Number.isFinite(seconds) ? { retryAfterMs: seconds * 1000 } : {}) };
}
