export function normalizeApiKey(value) {
  let key = String(value || "").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
  key = key.replace(/^Bearer\s+/i, "").trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  return key;
}
