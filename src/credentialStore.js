import { normalizeApiKey } from "./apiKey.js";

const API_KEY_PREFIX = "video-api-key:";
const MEDIA_KEY_PREFIX = "video-media-key:";
const REMEMBER_PREFIX = "video-remember-key:";

function storageValue(storage, key) {
  try {
    return storage?.getItem(key) || "";
  } catch {
    return "";
  }
}

function setStorageValue(storage, key, value) {
  try {
    if (value) storage?.setItem(key, value);
    else storage?.removeItem(key);
  } catch {}
}

export function readCredentials(profileId, local = localStorage, session = sessionStorage) {
  const apiKeyName = `${API_KEY_PREFIX}${profileId}`;
  const mediaKeyName = `${MEDIA_KEY_PREFIX}${profileId}`;
  return {
    apiKey: normalizeApiKey(storageValue(local, apiKeyName) || storageValue(session, apiKeyName)),
    mediaKey: normalizeApiKey(storageValue(local, mediaKeyName) || storageValue(session, mediaKeyName)),
    remember: storageValue(local, `${REMEMBER_PREFIX}${profileId}`) === "true",
  };
}

export function saveCredentials(
  profileId,
  { apiKey = "", mediaKey = "", remember = false },
  local = localStorage,
  session = sessionStorage,
) {
  const values = [
    [`${API_KEY_PREFIX}${profileId}`, normalizeApiKey(apiKey)],
    [`${MEDIA_KEY_PREFIX}${profileId}`, normalizeApiKey(mediaKey)],
  ];
  const persistent = Boolean(remember);
  for (const [key, value] of values) {
    setStorageValue(persistent ? local : session, key, value);
    setStorageValue(persistent ? session : local, key, "");
  }
  setStorageValue(local, `${REMEMBER_PREFIX}${profileId}`, persistent ? "true" : "");
}

export function clearCredentials(profileId, local = localStorage, session = sessionStorage) {
  for (const storage of [local, session]) {
    setStorageValue(storage, `${API_KEY_PREFIX}${profileId}`, "");
    setStorageValue(storage, `${MEDIA_KEY_PREFIX}${profileId}`, "");
  }
  setStorageValue(local, `${REMEMBER_PREFIX}${profileId}`, "");
}
