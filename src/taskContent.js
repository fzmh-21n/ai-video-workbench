const VIDEO_CONTENT_UNSUPPORTED = new Set([
  "canseedream",
  "meaicc",
  "ziyuai",
  "globalaiopc",
  "clmm",
  "pidoi",
]);

export function directTaskContentPaths(adapter, taskId) {
  const encodedTaskId = encodeURIComponent(String(taskId || ""));
  if (!encodedTaskId) return [];
  if (adapter === "fmgo") {
    return [
      `/v1/tasks/${encodedTaskId}/file`,
      `/v1/videos/${encodedTaskId}/content`,
    ];
  }
  if (VIDEO_CONTENT_UNSUPPORTED.has(adapter)) return [];
  return [`/v1/videos/${encodedTaskId}/content`];
}

export function requiresOriginalTaskKey(adapter) {
  return adapter !== "fmgo";
}

export function taskContentRequestUrl(task) {
  const base = `/api/tasks/${encodeURIComponent(String(task?.id || ""))}/content`;
  const source = String(task?.sourceVideoUrl || "").trim();
  return source ? `${base}?source=${encodeURIComponent(source)}` : base;
}
