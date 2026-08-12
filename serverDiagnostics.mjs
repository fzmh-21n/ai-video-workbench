const SECRET_KEY = /key|authorization|password|credential|cookie/i;

export function sanitizeDiagnostic(value, key = "", knownSecrets = []) {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnostic(item, "", knownSecrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      sanitizeDiagnostic(child, childKey, knownSecrets),
    ]));
  }
  if (typeof value !== "string") return value;
  let sanitized = value;
  for (const secret of knownSecrets) {
    if (secret) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{6,}\b/g, "sk-[REDACTED]");
}

export function diagnosticIdentity(req) {
  const clean = (name, max = 120) => String(req.get(name) || "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, max);
  return {
    sessionId: clean("x-diagnostic-session-id"),
    requestId: clean("x-diagnostic-request-id") || req.diagnostic?.requestId || "",
    batchId: clean("x-diagnostic-batch-id"),
    section: clean("x-diagnostic-section", 20),
    sequence: clean("x-diagnostic-sequence", 20),
    adapter: clean("x-api-adapter", 40),
  };
}

export function filterDiagnosticEntries(entries, { sessionId = "", adapter = "" } = {}) {
  return (entries || []).filter((entry) => (
    (!sessionId || entry.sessionId === sessionId) && (!adapter || entry.adapter === adapter)
  ));
}
