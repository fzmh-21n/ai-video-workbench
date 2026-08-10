export function mediaUploadMode(config, mimeType) {
  if (!config?.mediaUploadUrl) return "temporary";
  try {
    const isPaipuUpload = new URL(config.mediaUploadUrl).hostname === "api.paipu.net";
    if (isPaipuUpload && !String(mimeType || "").startsWith("image/")) return "temporary";
  } catch {}
  return "configured";
}
