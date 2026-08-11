export function mediaUploadMode(config, mimeType) {
  if (!config?.mediaUploadUrl) return "temporary";
  try {
    const isPaipuUpload = new URL(config.mediaUploadUrl).hostname === "api.paipu.net";
    if (isPaipuUpload && !String(mimeType || "").startsWith("image/")) return "temporary";
  } catch {}
  return "configured";
}

export function tmpfilesDirectUrl(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.hostname !== "tmpfiles.org") throw new Error("Tmpfiles 返回地址无效");
  if (!parsed.pathname.startsWith("/dl/")) parsed.pathname = `/dl${parsed.pathname}`;
  return parsed.toString();
}
