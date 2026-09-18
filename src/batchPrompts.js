const SECTION_MARKER = /^(?:(\d+)\.[^\S\r\n]*[（(]([^\r\n]*?)[）)][^\S\r\n]*|剧情[^\S\r\n]*[\[【][^\S\r\n]*(\d+)[^\S\r\n]*[\]】][^\S\r\n]*(?:[：:][^\S\r\n]*([^\r\n]*?))?[^\S\r\n]*)$/gm;
const OUTPUT_WRAPPER = /^\s*_::~(?:OUTPUT_START|OUTPUT_END|FIELD)::~_\s*$/gm;
const DECORATIVE_SECTION_BANNER = /^\s*[=═]{5,}\s*\r?\n\s*剧情\s*[\[【]\s*\d+\s*[\]】]\s*[：:]?\s*\r?\n\s*[=═]{5,}\s*$/gm;

export function splitBatchPrompts(text) {
  const source = String(text || "")
    .replace(/^\uFEFF/, "")
    // 合集文件可能先用“==== / 剧情[n] / ====”做目录横幅，随后在
    // OUTPUT_START 内再次写真正章节标题。横幅不属于提示词，先移除以免重复拆节。
    .replace(DECORATIVE_SECTION_BANNER, "")
    .trim();
  if (!source) return [];
  const markers = [...source.matchAll(SECTION_MARKER)];
  const candidates = markers.map((marker, index) => {
    const start = marker.index;
    const end = markers[index + 1]?.index ?? source.length;
    const section = Number(marker[1] || marker[3]);
    const title = marker[2]?.trim() || marker[4]?.trim() || `剧情[${section}]`;
    return {
      id: `section-${section}-${index}`,
      section,
      title,
      prompt: source.slice(start, end).replace(OUTPUT_WRAPPER, "").trim(),
      references: [],
      missingImages: [],
      status: "unmatched",
      error: "",
      expanded: index === 0,
      overrideEnabled: false,
      overrides: {},
      _sourceIndex: index,
    };
  });
  // 某些合集会同时写“章节目录横幅”和真正的剧情标题。即使横幅样式
  // 尚未被识别，也只保留同一章节号中内容最完整的一项，避免整批翻倍。
  const bySection = new Map();
  for (const item of candidates) {
    const current = bySection.get(item.section);
    if (!current || item.prompt.length > current.prompt.length) bySection.set(item.section, item);
  }
  return [...bySection.values()]
    .sort((left, right) => left._sourceIndex - right._sourceIndex)
    .map(({ _sourceIndex, ...item }, index) => ({ ...item, id: `section-${item.section}-${index}`, expanded: index === 0 }));
}

export function batchSerializable(items) {
  return (items || []).map((item) => ({
    ...item,
    references: (item.references || []).filter((reference) => !reference.file).map((reference) => ({
      ...reference,
      file: undefined,
      preview: undefined,
    })),
  }));
}

function escapedReferenceToken(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function removeBatchReferenceKind(item, kind) {
  const removed = (item?.references || []).filter((reference) => reference.kind === kind);
  if (!removed.length) return item;
  let prompt = String(item.prompt || "");
  for (const reference of removed) {
    if (reference.alias) {
      prompt = prompt.replace(new RegExp(`@${escapedReferenceToken(reference.alias)}=`, "g"), "");
    }
    if (reference.tag) {
      const replacement = reference.alias || String(reference.name || "").replace(/\.[^.]+$/, "");
      prompt = prompt.replace(new RegExp(escapedReferenceToken(reference.tag), "gi"), replacement);
    }
  }
  return {
    ...item,
    prompt,
    references: (item.references || []).filter((reference) => reference.kind !== kind),
  };
}

export function clearBatchReferences(item) {
  return ["image", "audio", "video"].reduce(
    (result, kind) => removeBatchReferenceKind(result, kind),
    item,
  );
}

export function overnightBatchReport(items, plan) {
  const ids = new Set(plan?.itemIds || []);
  const selected = (items || []).filter((item) => ids.has(item.id));
  const acceptedTaskIds = selected.flatMap((item) => {
    const baseline = new Set(plan?.baselineTaskIds?.[item.id] || []);
    return (item.taskIds || []).filter((taskId) => !baseline.has(taskId));
  });
  const missingRows = Math.max(0, ids.size - selected.length);
  const awaitingReceipt = selected.filter((item) => {
    const baseline = new Set(plan?.baselineTaskIds?.[item.id] || []);
    return !(item.taskIds || []).some((taskId) => !baseline.has(taskId));
  }).length + missingRows;
  const generating = selected.filter((item) => ["submitting", "submitted", "generating"].includes(item.status)).length;
  const generated = selected.filter((item) => item.status === "generated").length;
  const failed = selected.filter((item) => ["failed", "generation_failed", "submission_unknown", "not_submitted"].includes(item.status)).length;
  return {
    itemCount: ids.size,
    acceptedTaskCount: acceptedTaskIds.length,
    awaitingReceipt,
    generating,
    generated,
    failed,
    safeToShutdown: ids.size > 0 && awaitingReceipt === 0 && !selected.some((item) => item.status === "submitting" || item.status === "submission_unknown"),
  };
}

const BUSY_OR_DONE = new Set(["submitting", "submitted", "generating", "generated", "submission_unknown"]);

export function canBatchMatch(item) {
  return !BUSY_OR_DONE.has(item?.status);
}

export function canBatchSubmit(item) {
  return ["matched", "failed", "generation_failed", "not_submitted"].includes(item?.status);
}

export function canBatchResubmit(item) {
  return item?.status === "generated";
}

export function beginBatchSubmission(item, profile, attemptedAt = Date.now()) {
  return {
    ...item,
    status: "submitting",
    error: "",
    taskIds: [],
    downloaded: false,
    downloadedCount: 0,
    manuallyMarkedGenerated: false,
    manuallyMarkedDownloaded: false,
    manualCompletionSnapshot: undefined,
    lastSubmission: {
      profileId: String(profile?.id || ""),
      providerName: String(profile?.name || ""),
      model: String(profile?.model || ""),
      attemptedAt,
    },
  };
}

export function failBatchSubmission(item, error, profile, failedAt = Date.now()) {
  const lastSubmission = {
    ...(item?.lastSubmission || {}),
    profileId: String(profile?.id || item?.lastSubmission?.profileId || ""),
    providerName: String(profile?.name || item?.lastSubmission?.providerName || ""),
    model: String(profile?.model || item?.lastSubmission?.model || ""),
    failedAt,
    statusCode: Number(error?.status || 0),
    taskCreated: false,
  };
  return {
    ...item,
    status: error?.submissionUnknown ? "submission_unknown" : "failed",
    error: error?.message || "提交失败",
    taskIds: [],
    expanded: true,
    lastSubmission,
  };
}

export function recoverInterruptedBatchItems(items = []) {
  return items.map((item) => {
    if (item?.status !== "submitting") return item;
    if (item.taskIds?.length) return { ...item, status: "generating" };
    return {
      ...item,
      status: "not_submitted",
      progress: 0,
      error: "上次提交在取得任务 ID 前中断，本节尚未创建任务，可以重新提交",
      expanded: true,
    };
  });
}

export function reconciledBatchTerminalState(item, relatedTasks = [], hasDownloadCandidate = false) {
  if (item?.manuallyMarkedGenerated) return { status: "generated", progress: 100, error: "" };
  if (hasDownloadCandidate) return { status: "generated", progress: 100, error: "" };
  const failed = relatedTasks.find((task) => task.status === "failed");
  const unusable = relatedTasks.find((task) => task.status === "completed" && task.reviewStatus === "dissatisfied");
  const allTerminalAndUnusable = relatedTasks.length > 0 && relatedTasks.every((task) => (
    task.status === "failed" || (task.status === "completed" && task.reviewStatus === "dissatisfied")
  ));
  if (allTerminalAndUnusable && unusable) {
    return {
      status: "generation_failed",
      progress: 100,
      error: "当前成功视频已标记为不可用，可以重新生成本节",
    };
  }
  if (relatedTasks.length && relatedTasks.every((task) => task.status === "failed")) {
    return {
      status: "generation_failed",
      progress: 100,
      error: failed?.error || failed?.message || "中转站返回生成失败",
    };
  }
  if (!item.taskIds?.length || relatedTasks.length) return null;
  if (["submitting", "submitted", "generating"].includes(item.status)) {
    return {
      status: "generation_failed",
      progress: 100,
      error: "本节保存的任务记录已不存在，无法继续查询，请重新生成",
    };
  }
  if (item.status === "generated") {
    return {
      status: "generation_failed",
      progress: 100,
      error: "本节保存的任务与当前章节内容或参考素材不一致，请重新生成",
    };
  }
  return null;
}

export function manuallyCompleteBatchItem(item, downloaded = false) {
  const snapshot = item.manualCompletionSnapshot || {
    status: item.status,
    progress: item.progress,
    error: item.error,
    downloaded: Boolean(item.downloaded),
    downloadedCount: Number(item.downloadedCount || 0),
  };
  const markedDownloaded = downloaded || Boolean(item.manuallyMarkedDownloaded);
  return {
    ...item,
    status: "generated",
    progress: 100,
    error: "",
    manuallyMarkedGenerated: true,
    manuallyMarkedDownloaded: markedDownloaded,
    downloaded: markedDownloaded || Boolean(item.downloaded),
    downloadedCount: markedDownloaded || item.downloaded ? 1 : 0,
    manualCompletionSnapshot: snapshot,
  };
}

export function clearManualBatchDownload(item) {
  const originallyDownloaded = Boolean(item.manualCompletionSnapshot?.downloaded);
  return {
    ...item,
    manuallyMarkedDownloaded: false,
    downloaded: originallyDownloaded,
    downloadedCount: originallyDownloaded ? Math.max(1, Number(item.manualCompletionSnapshot?.downloadedCount || 0)) : 0,
  };
}

export function clearManualBatchCompletion(item) {
  const snapshot = item.manualCompletionSnapshot;
  if (!snapshot) return {
    ...item,
    manuallyMarkedGenerated: false,
    manuallyMarkedDownloaded: false,
  };
  const restored = {
    ...item,
    ...snapshot,
    manuallyMarkedGenerated: false,
    manuallyMarkedDownloaded: false,
  };
  delete restored.manualCompletionSnapshot;
  return restored;
}

export function batchStatusGroup(status) {
  if (["submitting", "submitted", "generating"].includes(status)) return "generating";
  if (["failed", "generation_failed", "submission_unknown"].includes(status)) return "failed";
  if (["pending", "not_submitted"].includes(status) || !status) return "pending";
  return status;
}

export function filterBatchItems(items, filter) {
  if (!filter || filter === "all") return [...(items || [])];
  return (items || []).filter((item) => batchStatusGroup(item?.status) === filter);
}

export function batchSubmissionPlan(mode, concurrency) {
  if (mode === "strict_order") return { concurrency: 1, staggerMs: 0 };
  if (mode === "limited_rush") return { concurrency: 5, staggerMs: 50 };
  return {
    concurrency: Math.max(1, Math.min(20, Number(concurrency) || 1)),
    staggerMs: 350,
  };
}

export function deterministicBatchStopReason(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || "").trim();
  const code = String(error?.code || "").trim();
  if (status === 401) return message || "API Key 无效或未授权";
  if (status === 402) return message || "账户余额或积分不足";
  if (/积分不足|余额不足|余额不够|额度不足|账户欠费|账号欠费|insufficient\s+(?:balance|credit|credits|quota)/i.test(message)) {
    return message || "账户余额、积分或额度不足";
  }
  if (/api\s*key|密钥|鉴权|认证|无权限|权限|unauthori[sz]ed|forbidden|invalid[_\s-]*(?:key|token)|token\s+(?:invalid|expired)/i.test(`${code} ${message}`)
    && /无效|错误|失效|过期|未授权|缺失|invalid|expired|unauthori[sz]ed|forbidden/i.test(`${code} ${message}`)) {
    return message || "API Key 无效或鉴权失败";
  }
  return "";
}

export async function runWithConcurrency(values, concurrency, worker) {
  const queue = [...values];
  const limit = Math.max(1, Math.min(20, Number(concurrency) || 1));
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const value = queue.shift();
      await worker(value);
    }
  });
  await Promise.all(runners);
}

export function orderedBatchItems(values) {
  return [...(values || [])].sort((left, right) => (
    Number(left?.section || 0) - Number(right?.section || 0)
  ));
}

export function providerBatchSubmissionPlan(profile, mode, concurrency) {
  if (profile?.adapter === "fmgo" && /^ss-v2(?:-fast)?$/i.test(String(profile?.model || ""))) {
    return {
      concurrency: 1,
      staggerMs: 5000,
      groupSize: 30,
      cooldownMs: 5 * 60 * 1000,
      providerLimited: true,
    };
  }
  return batchSubmissionPlan(mode, concurrency);
}

export function batchSourceNames(values, fallback = "") {
  const names = (values || []).map((item) => String(item?.sourceName || "").trim()).filter(Boolean);
  if (!names.length && String(fallback || "").trim()) names.push(String(fallback).trim());
  return [...new Set(names)];
}

export function batchItemChapterLabel(sourceName) {
  const source = String(sourceName || "");
  const arabic = source.match(/第\s*0*(\d+)\s*章/i) || source.match(/^\s*0*(\d+)\s*[_-]/);
  if (arabic) return `第${Number(arabic[1])}章`;
  const chinese = source.match(/第\s*([零〇一二两三四五六七八九十百]+)\s*章/);
  return chinese ? `第${chinese[1]}章` : "";
}

export function batchItemsForSource(items, sourceName) {
  const target = String(sourceName || "").trim();
  return (items || []).filter((item) => String(item?.sourceName || "").trim() === target);
}

export async function runOrderedStaggered(values, concurrency, staggerMs, worker, options = {}) {
  const queue = orderedBatchItems(values);
  const limit = Math.max(1, Math.min(20, Number(concurrency) || 1));
  const gap = Math.max(0, Math.min(5000, Number(staggerMs) || 0));
  const active = new Set();
  let lastStartedAt = 0;
  let started = 0;
  let groupWeight = 0;
  let completedGroups = 0;
  const groupSize = Math.max(0, Number(options.groupSize) || 0);
  const cooldownMs = Math.max(0, Number(options.cooldownMs) || 0);
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  for (let index = 0; index < queue.length; index += 1) {
    while (active.size >= limit) await Promise.race(active);
    if (options.shouldStop?.()) break;

    const itemWeight = Math.max(1, Number(options.weightOf?.(queue[index])) || 1);
    if (groupSize && groupWeight && groupWeight + itemWeight > groupSize) {
      completedGroups += 1;
      options.onGroupCooldown?.({ completedGroups, submitted: started, cooldownMs });
      if (cooldownMs) await sleep(cooldownMs);
      groupWeight = 0;
      lastStartedAt = 0;
      if (options.shouldStop?.()) break;
    }

    const waitMs = lastStartedAt ? lastStartedAt + gap - Date.now() : 0;
    if (waitMs > 0) await sleep(waitMs);
    if (options.shouldStop?.()) break;

    lastStartedAt = Date.now();
    started += 1;
    groupWeight += itemWeight;
    let pending;
    pending = Promise.resolve().then(() => worker(queue[index], index)).finally(() => active.delete(pending));
    active.add(pending);
  }

  await Promise.all(active);
  return { started, skipped: queue.length - started };
}

const RECOVERED_TASK_ID = /(?:wr_[0-9a-f-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function parseRecoveredTaskIds(text) {
  const entries = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(RECOVERED_TASK_ID);
    if (!match || seen.has(match[0].toLowerCase())) continue;
    seen.add(match[0].toLowerCase());
    const prefix = line.slice(0, match.index);
    const section = prefix.match(/(?:第\s*)?(\d+)\s*(?:节)?\s*[:：=,，\-]?\s*$/)?.[1];
    entries.push({ taskId: match[0], section: section ? Number(section) : null });
  }
  return entries;
}
