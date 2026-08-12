const SECTION_MARKER = /^(\d+)\.\s*[（(]([^\r\n]*?)[）)]\s*$/gm;

export function splitBatchPrompts(text) {
  const source = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!source) return [];
  const markers = [...source.matchAll(SECTION_MARKER)];
  return markers.map((marker, index) => {
    const start = marker.index;
    const end = markers[index + 1]?.index ?? source.length;
    const section = Number(marker[1]);
    const title = marker[2].trim();
    return {
      id: `section-${section}-${index}`,
      section,
      title,
      prompt: source.slice(start, end).trim(),
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
  return ["matched", "failed", "generation_failed"].includes(item?.status);
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

export async function runOrderedStaggered(values, concurrency, staggerMs, worker) {
  const queue = orderedBatchItems(values);
  const limit = Math.max(1, Math.min(20, Number(concurrency) || 1));
  const gap = Math.max(0, Math.min(5000, Number(staggerMs) || 0));
  const startedAt = Date.now();
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      const waitMs = startedAt + index * gap - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      await worker(queue[index], index);
    }
  });
  await Promise.all(runners);
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
