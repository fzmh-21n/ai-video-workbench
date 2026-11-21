import { imageModelsFor } from "./imageCatalog.js";
import { imageBaseUrl, imageProfileHeaders } from "./imageProviderSettings.js";
import { modelKeyFingerprint, modelCatalogMatches } from "./providerModelStore.js";

export const IMAGE_MODEL_CATALOGS_KEY = "image-workbench-model-catalogs-v1";
export const imageCatalogMatches = modelCatalogMatches;
export const imageModelFingerprint = modelKeyFingerprint;

export function parseImageModelCatalog(payload, adapter, secret = "") {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : null;
  if (!rows) throw new Error("模型列表格式无效；保留现有模型，可手动填写已适配模型");
  const names = new Map();
  for (const row of rows) {
    const value = typeof row === "string" ? row : row?.id || row?.name;
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || id.length > 250 || /[\u0000-\u001f]/.test(id) || (secret && (id === secret || (secret.length >= 8 && id.includes(secret))))) continue;
    names.set(id, row);
  }
  const models = [...names.keys()];
  const supported = imageModelsFor(adapter);
  const groups = { supported: [], candidates: [], other: [] };
  for (const [id, row] of names) {
    const modalities = JSON.stringify(row?.output_modalities || row?.modalities || row?.output || "");
    const kind = supported.includes(id) ? "supported" : ((Array.isArray(payload?.groups?.candidates) && payload.groups.candidates.includes(id)) || /image|imagen|dall[-_ ]?e|flux|seedream|nano2|banana/i.test(id + " " + modalities)) ? "candidates" : "other";
    groups[kind].push(id);
  }
  return { models, groups, source: payload?.source === "fallback" ? "fallback" : "live" };
}

export function imageModelScope(profile, key) {
  let origin;
  try { origin = imageBaseUrl(profile?.baseUrl); } catch { origin = String(profile?.baseUrl || "").trim(); }
  // In-memory scope only, never serialized or shown. Credentials are hashed in persistent catalogs.
  return JSON.stringify([profile?.id, origin, profile?.adapter, String(key || "").trim()]);
}

export function readImageModelCatalogs(storage = globalThis.localStorage) {
  try { const value = JSON.parse(storage?.getItem(IMAGE_MODEL_CATALOGS_KEY) || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

export function saveImageModelCatalog(profile, fingerprint, payload, storage = globalThis.localStorage) {
  const parsed = parseImageModelCatalog(payload, profile.adapter);
  const previous = readImageModelCatalogs(storage)[profile.id];
  if ((parsed.source === "fallback" || !parsed.models.length) && imageCatalogMatches(previous, profile, fingerprint) && previous.source === "live" && previous.models.length)
    return { ...previous, retained: true };
  const entry = { ...parsed, baseUrl: imageBaseUrl(profile.baseUrl), adapter: profile.adapter, keyFingerprint: fingerprint, fetchedAt: Date.now() };
  storage?.setItem(IMAGE_MODEL_CATALOGS_KEY, JSON.stringify({ ...readImageModelCatalogs(storage), [profile.id]: entry }));
  return entry;
}

export function imageSelectableModels(profile, catalog, selected = "") {
  const names = catalog?.baseUrl === imageBaseUrl(profile.baseUrl) && catalog?.adapter === profile.adapter && Array.isArray(catalog.models) ? catalog.models : [];
  return [...new Set([selected, ...imageModelsFor(profile.adapter), ...names].filter(Boolean))];
}

export async function fetchImageModelCatalog(profile, key, { fetchImpl = fetch, signal } = {}) {
  const baseUrl = imageBaseUrl(profile.baseUrl);
  if (!String(key || "").trim()) throw new Error("请填写图片 API Key 后再测试；未发出请求");
  if (!["fmgo", "canseedream", "qiqi"].includes(profile.adapter)) throw new Error("请选择受支持的图片协议");
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  let response;
  try {
    response = await fetchImpl("/api/image-config/models", { cache: "no-store", headers: imageProfileHeaders({ ...profile, baseUrl }, String(key).trim()), signal: combined });
  } catch (error) {
    if (["TimeoutError", "AbortError"].includes(error?.name)) throw new Error("模型读取超时或已取消；检查接口地址、网络和中转状态，未提交生成任务");
    throw new Error("模型目录连接失败；检查本地服务、HTTPS 接口地址和网络，未提交生成任务");
  }
  if ([401, 403].includes(response.status)) throw new Error(`鉴权失败（HTTP ${response.status}）；检查图片 Key 是否有效及模型/分组权限`);
  if ([404, 405].includes(response.status)) throw new Error("本地服务尚未加载图片模型接口；请等任务结束后重启工作台再测试");
  if (!response.ok) throw new Error(`模型目录读取失败（HTTP ${response.status}）；检查地址、权限和中转状态，原模型已保留`);
  let body;
  try { body = await response.json(); } catch { throw new Error("模型目录未返回有效 JSON；若刚更新，请在空闲时重启本地服务，原模型已保留"); }
  const parsed = parseImageModelCatalog(body, profile.adapter, String(key).trim());
  const fingerprint = await imageModelFingerprint(key);
  return { ...parsed, keyFingerprint: fingerprint };
}

export function imageModelCatalogStatus(catalog, retained = false) {
  const suffix = retained ? "；已保留同一地址和 Key 上次读取的目录" : "";
  if (catalog.source === "fallback") return "中转不支持模型列表接口：显示内置参考模型，尚未核实 Key 权限；可手动填写已适配模型" + suffix;
  if (!catalog.models.length) return "目录返回空列表；检查 Key 分组/权限，或手动填写已适配模型，原选择已保留" + suffix;
  return `已读取 ${catalog.models.length} 个模型：已适配图片 ${catalog.groups.supported.length}，图片候选 ${catalog.groups.candidates.length}，其他/用途未确认 ${catalog.groups.other.length}；未自动更换模型，目录不代表生成权限` + suffix;
}
