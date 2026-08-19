const SECTION_MARKER = /^(?:(\d+)\.\s*[（(]([^\r\n]*?)[）)]\s*|剧情\s*[\[【]\s*(\d+)\s*[\]】]\s*[：:]?\s*)$/gm;
const OUTPUT_WRAPPER = /^\s*_::~(?:OUTPUT_START|OUTPUT_END|FIELD)::~_\s*$/gm;
const DECORATIVE_SECTION_BANNER = /^\s*={5,}\s*\r?\n\s*剧情\s*[\[【]\s*\d+\s*[\]】]\s*[：:]?\s*\r?\n\s*={5,}\s*$/gm;

export function splitBatchPrompts(text) {
  const source = String(text || "")
    .replace(/^\uFEFF/, "")
    // 合集文件可能先用“==== / 剧情[n] / ====”做目录横幅，随后在
    // OUTPUT_START 内再次写真正章节标题。横幅不属于提示词，先移除以免重复拆节。
    .replace(DECORATIVE_SECTION_BANNER, "")
    .trim();
  if (!source) return [];
  const markers = [...source.matchAll(SECTION_MARKER)];
  return markers.map((marker, index) => {
    const start = marker.index;
    const end = markers[index + 1]?.index ?? source.length;
    const section = Number(marker[1] || marker[3]);
    const title = marker[2]?.trim() || `剧情[${section}]`;
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
    };
  });
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

const BUSY_OR_DONE = new Set(["submitting", "submitted", "generating", "generated", "submission_unknown"]);

export function canBatchMatch(item) {
  return !BUSY_OR_DONE.has(item?.status);
}

export function canBatchSubmit(item) {
  return ["matched", "failed", "generation_failed", "not_submitted"].includes(item?.status);
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

export async function runOrderedStaggered(values, concurrency, staggerMs, worker, options = {}) {
  const queue = orderedBatchItems(values);
  const limit = Math.max(1, Math.min(20, Number(concurrency) || 1));
  const gap = Math.max(0, Math.min(5000, Number(staggerMs) || 0));
  const active = new Set();
  let lastStartedAt = 0;
  let started = 0;

  for (let index = 0; index < queue.length; index += 1) {
    while (active.size >= limit) await Promise.race(active);
    if (options.shouldStop?.()) break;

    const waitMs = lastStartedAt ? lastStartedAt + gap - Date.now() : 0;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (options.shouldStop?.()) break;

    lastStartedAt = Date.now();
    started += 1;
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
