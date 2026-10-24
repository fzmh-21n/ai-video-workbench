import { batchItemsForSource, batchSourceNames, splitBatchPrompts } from "./batchPrompts.js";

const filenameOrder = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export async function importBatchTextFiles(fileList, importId) {
  const files = fileList?.text ? [fileList] : Array.from(fileList || []);
  const ordered = files.map((file, index) => ({ file, index }))
    .sort((left, right) => filenameOrder.compare(left.file.name, right.file.name) || left.index - right.index);
  const additions = [];
  const sourceNames = [];
  const failures = [];
  for (const { file, index } of ordered) {
    try {
      const parsed = splitBatchPrompts(await file.text());
      if (!parsed.length) throw new Error("没有识别到分节标记，请检查 TXT 格式");
      additions.push(...parsed.map((item, sectionIndex) => ({
        ...item,
        id: `${item.id}-${importId}-${index}-${sectionIndex}`,
        sourceName: file.name,
        expanded: sectionIndex === 0,
      })));
      sourceNames.push(file.name);
    } catch (error) {
      failures.push({ name: file.name, error: error.message || "读取文件失败" });
    }
  }
  return { additions, sourceNames, failures };
}

export function completedBatchSource(items) {
  return items.length > 0 && items.every((item) => item.status === "generated"
    && (item.downloaded || item.manuallyMarkedDownloaded));
}

export function removeCompletedBatchTextState(state, sourceName, uploadKey) {
  const removed = batchItemsForSource(state.items, sourceName);
  if (!completedBatchSource(removed)) return null;
  const removedIds = new Set(removed.map((item) => item.id));
  const items = state.items.filter((item) => !removedIds.has(item.id));
  const removedKeys = new Set(removed.flatMap((item) => (item.references || []).map((reference) => uploadKey(item, reference))));
  const retainedKeys = new Set(items.flatMap((item) => (item.references || []).map((reference) => uploadKey(item, reference))));
  return {
    items,
    sourceName: !items.length ? "" : state.sourceName === sourceName ? batchSourceNames(items).at(-1) || "" : state.sourceName,
    selectedItemIds: state.selectedItemIds.filter((id) => !removedIds.has(id)),
    uploaded: Object.fromEntries(Object.entries(state.uploaded).filter(([key]) => !removedKeys.has(key) || retainedKeys.has(key))),
    overnightPlan: state.overnightPlan ? {
      ...state.overnightPlan,
      itemIds: state.overnightPlan.itemIds.filter((id) => !removedIds.has(id)),
      baselineTaskIds: Object.fromEntries(Object.entries(state.overnightPlan.baselineTaskIds || {}).filter(([id]) => !removedIds.has(id))),
    } : null,
  };
}
