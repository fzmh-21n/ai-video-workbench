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
