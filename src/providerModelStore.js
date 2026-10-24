import { normalizeApiKey } from "./apiKey.js";

export const PROVIDER_MODEL_CATALOGS_KEY = "video-workbench-model-catalogs-v1";

export function normalizeModelNames(payload, fallback = []) {
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload?.data) ? payload.data : fallback;
  return [...new Set(rows.map((row) => typeof row === "string" ? row : row?.id || row?.name)
    .filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

export async function modelKeyFingerprint(apiKey) {
  const bytes = new TextEncoder().encode(normalizeApiKey(apiKey));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function readModelCatalogs(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(PROVIDER_MODEL_CATALOGS_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function saveModelCatalog(profile, fingerprint, payload, storage = globalThis.localStorage) {
  const entry = {
    baseUrl: new URL(profile.baseUrl).origin,
    adapter: profile.adapter,
    keyFingerprint: fingerprint,
    models: normalizeModelNames(payload),
    source: payload?.source || (payload?.warning ? "fallback" : "live"),
    fetchedAt: payload?.source === "cached" && Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : Date.now(),
    capabilities: payload?.capabilities || {},
    labels: payload?.labels || {},
  };
  try {
    storage?.setItem(PROVIDER_MODEL_CATALOGS_KEY, JSON.stringify({ ...readModelCatalogs(storage), [profile.id]: entry }));
  } catch {}
  return entry;
}

export function modelCatalogMatches(entry, profile, fingerprint) {
  try {
    return Boolean(entry && fingerprint && Array.isArray(entry.models)
      && entry.baseUrl === new URL(profile.baseUrl).origin && entry.adapter === profile.adapter
      && entry.keyFingerprint === fingerprint);
  } catch {
    return false;
  }
}

export function removeModelCatalog(profileId, storage = globalThis.localStorage) {
  const catalogs = readModelCatalogs(storage);
  delete catalogs[profileId];
  try { storage?.setItem(PROVIDER_MODEL_CATALOGS_KEY, JSON.stringify(catalogs)); } catch {}
}

export async function restoreModelCatalogs(profiles, keyFor, storage = globalThis.localStorage) {
  const catalogs = readModelCatalogs(storage);
  const entries = await Promise.all((profiles || []).map(async (profile) => {
    const entry = catalogs[profile.id];
    if (!entry) return null;
    const key = normalizeApiKey(keyFor(profile));
    if (!key) return null;
    const fingerprint = await modelKeyFingerprint(key);
    return modelCatalogMatches(entry, profile, fingerprint) ? [profile.id, entry] : null;
  }));
  return Object.fromEntries(entries.filter(Boolean));
}
