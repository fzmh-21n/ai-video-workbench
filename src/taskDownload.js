function numeric(value, fallback = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function chapterNumber(task) {
  const source = String(task?.batchTitle || task?.sourceName || "");
  const arabic = source.match(/(?:第\s*)?(\d+)\s*章/i) || source.match(/^\s*(\d+)\s*[_-]/);
  if (arabic) return Number(arabic[1]);
  const chinese = source.match(/第\s*([零〇一二两三四五六七八九十百]+)\s*章/);
  if (!chinese) return Number.MAX_SAFE_INTEGER;
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let current = 0;
  for (const character of chinese[1]) {
    if (character === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else if (character === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else {
      current = digits[character] ?? current;
    }
  }
  return total + current;
}

function sectionNumber(task) {
  const direct = Number(task?.batchSection);
  if (Number.isFinite(direct)) return direct;
  const match = String(task?.title || "").match(/^第\s*(\d+)\s*节/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function orderedDownloadTasks(tasks) {
  return [...(tasks || [])].sort((left, right) => (
    chapterNumber(left) - chapterNumber(right)
    || numeric(left?.batchSection) - numeric(right?.batchSection)
    || numeric(left?.batchOrder) - numeric(right?.batchOrder)
    || numeric(left?.submissionSequence) - numeric(right?.submissionSequence)
    || numeric(left?.createdAtMs) - numeric(right?.createdAtMs)
    || String(left?.title || "").localeCompare(String(right?.title || ""), "zh-CN", { numeric: true })
  ));
}

export function downloadTaskBuckets(tasks, { includeDownloaded = false } = {}) {
  const available = (tasks || []).filter((task) => task.status === "completed" && task.id);
  return {
    pending: orderedDownloadTasks(available.filter((task) => includeDownloaded || !task.downloadedAtMs)),
    alreadyDownloaded: includeDownloaded ? [] : available.filter((task) => task.downloadedAtMs),
    unavailable: (tasks || []).filter((task) => task.status !== "completed" || !task.id),
  };
}

function normalizedBatchTitle(value) {
  return String(value || "").trim().replace(/\.txt$/i, "");
}

export function batchItemDownloadCandidates(item, storedTasks) {
  const byId = new Map((storedTasks || []).map((task) => [task.id, task]));
  const tracked = (item?.taskIds || []).map((id) => byId.get(id)).filter(Boolean);
  const reference = [...tracked].sort((left, right) => numeric(right?.createdAtMs, 0) - numeric(left?.createdAtMs, 0))[0];
  const title = normalizedBatchTitle(item?.sourceName || reference?.batchTitle);
  const section = numeric(item?.section);
  const projectName = String(reference?.projectName || "");
  const matching = (storedTasks || []).filter((task) => (
    task?.status === "completed"
    && numeric(task?.batchSection) === section
    && normalizedBatchTitle(task?.batchTitle) === title
    && (!projectName || String(task?.projectName || "") === projectName)
  ));
  return [...new Map([...tracked.filter((task) => task.status === "completed"), ...matching]
    .map((task) => [task.id, task])).values()]
    .sort((left, right) => (
      Number(Boolean(right?.downloadedAtMs)) - Number(Boolean(left?.downloadedAtMs))
      || Number(Boolean(right?.sourceVideoUrl)) - Number(Boolean(left?.sourceVideoUrl))
      || numeric(right?.createdAtMs, 0) - numeric(left?.createdAtMs, 0)
    ));
}

export function preferredBatchDownloadTasks(items, storedTasks) {
  return (items || []).flatMap((item) => {
    const candidates = batchItemDownloadCandidates(item, storedTasks);
    if (!candidates.length) return [];
    return [{ ...candidates[0], downloadAlternatives: candidates.slice(1) }];
  });
}

export function orderedDownloadFilename(task, index, total) {
  const width = Math.max(3, String(Math.max(1, Number(total) || 1)).length);
  const order = String(index + 1).padStart(width, "0");
  const rawTitle = String(task?.title || `视频-${order}`).replace(/\.mp4$/i, "");
  const chapter = chapterNumber(task);
  if (Number.isFinite(chapter) && chapter !== Number.MAX_SAFE_INTEGER) {
    const chapterLabel = `${String(chapter).padStart(2, "0")}章`;
    const section = sectionNumber(task);
    const suffix = rawTitle.replace(/^第\s*\d+\s*节[-_\s]*/, "");
    const chapterTitle = Number.isFinite(section) && section !== Number.MAX_SAFE_INTEGER
      ? `第${String(section).padStart(2, "0")}节${suffix ? `-${suffix}` : ""}`
      : rawTitle;
    return `${chapterLabel}-${chapterTitle.replace(/[\\/:*?"<>|]/g, "_")}.mp4`;
  }
  const paddedTitle = rawTitle.replace(/^第\s*(\d+)\s*节/, (_match, section) => (
    `第${String(Number(section)).padStart(3, "0")}节`
  ));
  const safeTitle = paddedTitle.replace(/[\\/:*?"<>|]/g, "_");
  return `${order}-${safeTitle}.mp4`;
}
