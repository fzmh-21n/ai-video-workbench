export const AUTOMATIC_UPLOAD_SERVICES = ["Uguu", "Litterbox", "Tmpfiles"];

export function configuredUploadBatchSize(adapter) {
  return adapter === "ziyuai" ? 1 : 50;
}

export function configuredUploadRetryDelay(retryAfter, retryIndex, now = Date.now()) {
  const raw = String(retryAfter || "").trim();
  let delayMs = 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    delayMs = Number(raw) * 1000;
  } else if (raw) {
    const retryAt = Date.parse(raw);
    if (Number.isFinite(retryAt)) delayMs = retryAt - now;
  }
  if (!(delayMs > 0)) delayMs = 5000 * (2 ** Math.max(0, Number(retryIndex) || 0));
  return Math.min(120_000, Math.max(1000, Math.round(delayMs)));
}

export function createUploadCircuitBreaker({ failureThreshold = 2, monitoredServices = ["Litterbox"] } = {}) {
  const monitored = new Set(monitoredServices);
  const failures = new Map();
  const opened = new Set();
  return {
    isOpen(service) {
      return opened.has(service);
    },
    recordFailure(service) {
      if (!monitored.has(service)) return false;
      const count = Number(failures.get(service) || 0) + 1;
      failures.set(service, count);
      if (count >= failureThreshold) opened.add(service);
      return opened.has(service);
    },
    recordSuccess(service) {
      failures.delete(service);
      opened.delete(service);
    },
  };
}

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
