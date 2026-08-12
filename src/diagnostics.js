const STORAGE_KEY = "video-workbench-diagnostics-v1";
const SESSION_KEY = "video-workbench-diagnostic-session-v1";
const MAX_CLIENT_ENTRIES = 2000;

function storage(name) {
  try { return globalThis[name]; } catch { return null; }
}

export function diagnosticSessionId() {
  const session = storage("sessionStorage");
  let value = session?.getItem(SESSION_KEY) || "";
  if (!value) {
    value = globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    session?.setItem(SESSION_KEY, value);
  }
  return value;
}

export function redactDiagnosticValue(value, key = "") {
  if (/key|authorization|password|credential|cookie/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactDiagnosticValue(child, childKey),
    ]));
  }
  if (typeof value !== "string") return value;
  return value
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{6,}\b/g, "sk-[REDACTED]");
}

function readEntries() {
  try {
    const parsed = JSON.parse(storage("localStorage")?.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordDiagnostic(entry) {
  const sanitized = redactDiagnosticValue({
    timestamp: new Date().toISOString(),
    source: "browser",
    sessionId: diagnosticSessionId(),
    ...entry,
  });
  const entries = [...readEntries(), sanitized].slice(-MAX_CLIENT_ENTRIES);
  try { storage("localStorage")?.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch {}
  return sanitized;
}

export function diagnosticHeaders({ requestId, batchId, section, sequence } = {}) {
  return {
    "x-diagnostic-session-id": diagnosticSessionId(),
    ...(requestId ? { "x-diagnostic-request-id": String(requestId) } : {}),
    ...(batchId ? { "x-diagnostic-batch-id": String(batchId) } : {}),
    ...(section != null ? { "x-diagnostic-section": String(section) } : {}),
    ...(sequence != null ? { "x-diagnostic-sequence": String(sequence) } : {}),
  };
}

export async function clearDiagnostics(profile) {
  const sessionId = diagnosticSessionId();
  const adapter = String(profile?.adapter || "");
  const kept = readEntries().filter((entry) => entry.sessionId !== sessionId || entry.adapter !== adapter);
  try { storage("localStorage")?.setItem(STORAGE_KEY, JSON.stringify(kept)); } catch {}
  const response = await fetch("/api/diagnostics/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, adapter }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || "清空诊断日志失败");
  }
}

export function diagnosticExportPayload(profile, serverPayload) {
  const sessionId = diagnosticSessionId();
  const adapter = String(profile?.adapter || "");
  const clientEntries = readEntries().filter((entry) => entry.sessionId === sessionId && entry.adapter === adapter);
  const serverEntries = Array.isArray(serverPayload?.entries) ? serverPayload.entries : [];
  const failures = [...clientEntries, ...serverEntries].filter((entry) => (
    /failed|exception|closed/.test(String(entry.stage || ""))
    && !/^temporary_upload_/.test(String(entry.stage || ""))
  ));
  return redactDiagnosticValue({
    format: "ai-video-workbench-diagnostic-v1",
    exportedAt: new Date().toISOString(),
    provider: {
      id: profile?.id || "",
      name: profile?.name || "",
      adapter,
      model: profile?.model || "",
    },
    sessionId,
    summary: {
      clientRequestTimings: clientEntries
        .filter((entry) => /client_(?:materials_upload|task_submit)_completed/.test(String(entry.stage || "")))
        .map((entry) => ({ stage: entry.stage, batchId: entry.batchId, section: entry.section, durationMs: entry.durationMs, status: entry.status })),
      providerTaskIdTimings: serverEntries
        .filter((entry) => entry.stage === "provider_task_ids_received")
        .map((entry) => ({ batchId: entry.batchId, section: entry.section, sequence: entry.sequence, durationMs: entry.durationMs, upstreamTaskIds: entry.upstreamTaskIds })),
      uploadAttempts: serverEntries
        .filter((entry) => /^(?:(?:temporary_upload_attempt|configured_upload)_(?:completed|failed)|configured_upload_retry_wait|temporary_upload_service_skipped)$/.test(String(entry.stage || "")))
        .map((entry) => ({ stage: entry.stage, service: entry.service, fileName: entry.fileName, durationMs: entry.durationMs, status: entry.status, error: entry.error, reason: entry.reason, circuitOpened: entry.circuitOpened, attempt: entry.attempt, nextAttempt: entry.nextAttempt, delayMs: entry.delayMs, retryAfter: entry.retryAfter, attemptCount: entry.attemptCount })),
      providerFailures: serverEntries
        .filter((entry) => entry.stage === "task_status_received" && entry.taskStatus === "failed")
        .map((entry) => ({ batchId: entry.batchId, section: entry.section, sequence: entry.sequence, upstreamTaskId: entry.upstreamTaskId, failureCode: entry.failureCode, failureReason: entry.failureReason })),
      failures,
    },
    clientEntries,
    serverEntries,
    guidance: `本文件只包含当前浏览器会话中 ${profile?.name || adapter}（接口类型 ${adapter}）的日志，不包含其他中转。日志不包含 API Key、密码、提示词正文或素材 URL。`,
  });
}

function filenamePart(value) {
  return String(value || "provider").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "provider";
}

export async function exportDiagnostics(profile) {
  const sessionId = diagnosticSessionId();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `工作台日志-${filenamePart(profile?.adapter)}-${stamp}.json`;
  const handle = globalThis.showSaveFilePicker
    ? await globalThis.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "JSON 诊断日志", accept: { "application/json": [".json"] } }],
      })
    : null;
  const query = new URLSearchParams({ sessionId, adapter: profile?.adapter || "" });
  const response = await fetch(`/api/diagnostics?${query}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || "读取服务端诊断日志失败");
  const payload = diagnosticExportPayload(profile, body);
  const contents = JSON.stringify(payload, null, 2);
  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
  } else {
    const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { filename, count: payload.clientEntries.length + payload.serverEntries.length };
}
