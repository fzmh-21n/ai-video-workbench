export function uselessTaskBatches(tasks, projectName = "all") {
  const batches = new Map();
  for (const task of tasks || []) {
    if (!task.batchId || task.archivedAtMs) continue;
    if (!batches.has(task.batchId)) batches.set(task.batchId, { id: task.batchId, title: task.batchTitle || "批量任务", tasks: [] });
    batches.get(task.batchId).tasks.push(task);
  }
  return [...batches.values()].filter((batch) => batch.tasks.length
    && batch.tasks.every((task) => task.status === "failed")
    && (projectName === "all" || batch.tasks.every((task) => (task.projectName || "未归类") === projectName)));
}

export function archivedUselessTask(task, archivedAtMs = Date.now()) {
  const { prompt, reuseSnapshot, ...record } = task;
  return { ...record, archivedAtMs, updatedAtMs: archivedAtMs };
}
