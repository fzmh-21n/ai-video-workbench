// Only recorded submission parameters are evidence; never use the current UI/profile selection.
export function normalizeTaskResolution(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || text === "auto" || text === "adaptive") return "";
  if (/^(480|720|1080)p?$/.test(text)) return `${text.replace(/p$/, "")}p`;
  return text;
}

export function recordedTaskResolution(task) {
  return normalizeTaskResolution(task?.submittedResolution)
    || normalizeTaskResolution(task?.reuseSnapshot?.resolution)
    || normalizeTaskResolution(task?.resolution);
}
