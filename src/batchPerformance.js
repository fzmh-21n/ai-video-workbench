import { normalizedTaskProgress } from "./taskProgress.js";

export const BATCH_PAGE_SIZE = 50;

export function batchItemPage(items, page = 1) {
  const totalPages = Math.max(1, Math.ceil(items.length / BATCH_PAGE_SIZE));
  const currentPage = Math.max(1, Math.min(totalPages, page));
  return {
    items: items.slice((currentPage - 1) * BATCH_PAGE_SIZE, currentPage * BATCH_PAGE_SIZE),
    page: currentPage,
    totalPages,
  };
}

export function needsBatchStatusSync(item) {
  return !!item.taskIds?.length && ["submitted", "generating", "submitting"].includes(item.status);
}

export function syncBatchTaskStates(items, storedTasks) {
  const storedById = new Map(storedTasks.map((task) => [task.id, task]));
  let changed = false;
  const updated = items.map((item) => {
    if (!needsBatchStatusSync(item)) return item;
    const tracked = item.taskIds.map((id) => storedById.get(id)).filter(Boolean);
    if (!tracked.length) return item;
    const progress = Math.round(tracked.reduce(
      (total, task) => total + normalizedTaskProgress(task.status, task.progress), 0,
    ) / tracked.length);
    let patch = { status: "generating", progress };
    if (tracked.some((task) => task.status === "completed" && task.reviewStatus !== "dissatisfied")) {
      patch = { status: "generated", progress: 100, error: "" };
    } else if (tracked.every((task) => task.status === "failed" || (task.status === "completed" && task.reviewStatus === "dissatisfied"))) {
      const failed = tracked.find((task) => task.status === "failed");
      patch = {
        status: "generation_failed", progress,
        error: tracked.some((task) => task.reviewStatus === "dissatisfied")
          ? "当前成功视频已标记为不可用，可以重新生成本节"
          : failed?.error || failed?.message || "中转站返回生成失败",
      };
    }
    if (Object.entries(patch).every(([key, value]) => item[key] === value)) return item;
    changed = true;
    return { ...item, ...patch };
  });
  return changed ? updated : items;
}
