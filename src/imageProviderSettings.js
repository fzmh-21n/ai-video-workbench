import { IMAGE_PROVIDER_PROFILES, imageModelsFor } from "./imageCatalog.js";

export const IMAGE_PROVIDERS_KEY = "image-workbench-providers-v1";
export const IMAGE_ADAPTERS = ["fmgo", "canseedream", "qiqi"];

export function imageBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); } catch { throw new Error("Base URL 无效，请填写公网 HTTPS 接口域名"); }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Match the server's public HTTPS boundary; the server remains authoritative.
  const privateHost = host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::" || host === "0.0.0.0" ||
    /^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^(fc|fd)[a-f0-9]{0,2}:|^fe80:/i.test(host);
  if (parsed.protocol !== "https:" || privateHost || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("Base URL 必须是公网 HTTPS 地址，不能含账号、密码、查询参数或片段");
  return parsed.origin;
}

export function normalizeImageProvider(value) {
  if (!value || !/^[a-zA-Z0-9._-]+$/.test(value.id || "")) throw new Error("图片中转标识无效");
  if (!IMAGE_ADAPTERS.includes(value.adapter)) throw new Error("请选择受支持的图片接口协议");
  const name = String(value.name || "").trim();
  if (!name) throw new Error("请填写中转名称");
  const models = imageModelsFor(value.adapter);
  return { id: value.id, name: name.slice(0, 200), adapter: value.adapter,
    baseUrl: imageBaseUrl(value.baseUrl), model: String(value.model || "").trim() || models[0] };
}

export function loadImageProviders(storage = localStorage) {
  const profiles = new Map(IMAGE_PROVIDER_PROFILES.map((profile) => [profile.id, { ...profile }]));
  try {
    const saved = JSON.parse(storage.getItem(IMAGE_PROVIDERS_KEY) || "[]");
    for (const value of Array.isArray(saved) ? saved : []) {
      try { const profile = normalizeImageProvider(value); profiles.set(profile.id, profile); } catch { /* Keep other valid profiles/defaults. */ }
    }
  } catch { /* Existing model choices and credentials remain in their original storage keys. */ }
  return [...profiles.values()];
}

export function saveImageProviders(profiles, storage = localStorage) {
  const normalized = profiles.map(normalizeImageProvider);
  storage.setItem(IMAGE_PROVIDERS_KEY, JSON.stringify(normalized));
}

export function imageProfileHeaders(profile, key, model = profile.model) {
  return { "x-api-base-url": profile.baseUrl, "x-api-key": key,
    "x-api-model": encodeURIComponent(model), "x-api-adapter": profile.adapter };
}

export function imageProviderSnapshot(profile) {
  // Never copy API keys, upload credentials or other unrecognized properties into tasks/settings.
  return normalizeImageProvider(profile);
}

export function imageTaskProvider(task, profiles) {
  const current = profiles.find((profile) => profile.id === task.providerId) ||
    profiles.find((profile) => profile.adapter === task.providerId);
  let route = task.providerSnapshot || current;
  try {
    const payload = String(task.id || "").split(".")[0];
    const text = new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)));
    const job = JSON.parse(text);
    // Signed job metadata pins the actual server-resolved origin, including legacy tasks.
    // This is only routing metadata; the server still verifies the full signed token.
    if (job.mediaType === "image" && job.taskId && IMAGE_ADAPTERS.includes(job.adapter))
      route = { ...route, adapter: job.adapter, baseUrl: job.baseUrl };
  } catch { /* Old opaque task IDs can use their saved snapshot or profile. */ }
  if (!route) return null;
  try {
    return normalizeImageProvider({ ...route, id: current?.id || task.providerSnapshot?.id || task.providerId,
      name: task.providerName || current?.name || route.name || "历史图片中转", model: task.model || route.model });
  } catch { return null; }
}

export function imageProviderRoutes(adapter, model) {
  if (adapter === "canseedream") return "生成/参考图：/api/v3/images/generations/tasks；查询：同路径/{任务ID}";
  if (adapter === "fmgo" && String(model).startsWith("gemini-")) return "生成/参考图：/v1/chat/completions；查询：上游返回路径或 /v1/tasks/{任务ID}";
  return adapter === "qiqi"
    ? "生成：/v1/images/generations；参考图：/v1/images/edits；结果保存在本机"
    : "生成：/v1/images/generations；参考图：/v1/images/edits；查询：上游返回路径或 /v1/tasks/{任务ID}";
}
