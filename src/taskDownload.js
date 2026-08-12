function numeric(value, fallback = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function orderedDownloadTasks(tasks) {
  return [...(tasks || [])].sort((left, right) => (
    numeric(left?.batchSection) - numeric(right?.batchSection)
    || numeric(left?.batchOrder) - numeric(right?.batchOrder)
    || numeric(left?.submissionSequence) - numeric(right?.submissionSequence)
    || numeric(left?.createdAtMs) - numeric(right?.createdAtMs)
    || String(left?.title || "").localeCompare(String(right?.title || ""), "zh-CN", { numeric: true })
  ));
}

export function orderedDownloadFilename(task, index, total) {
  const width = Math.max(3, String(Math.max(1, Number(total) || 1)).length);
  const order = String(index + 1).padStart(width, "0");
  const rawTitle = String(task?.title || `视频-${order}`).replace(/\.mp4$/i, "");
  const paddedTitle = rawTitle.replace(/^第\s*(\d+)\s*节/, (_match, section) => (
    `第${String(Number(section)).padStart(3, "0")}节`
  ));
  const safeTitle = paddedTitle.replace(/[\\/:*?"<>|]/g, "_");
  return `${order}-${safeTitle}.mp4`;
}
