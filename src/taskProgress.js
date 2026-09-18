export function normalizedTaskProgress(status, value) {
  if (status === "completed") return 100;
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const maximum = status === "failed" ? 100 : 99;
  return Math.max(0, Math.min(maximum, number));
}

export function normalizedTaskGroupProgress(tasks = []) {
  if (!tasks.length) return 0;
  const progress = Math.round(tasks.reduce(
    (total, task) => total + normalizedTaskProgress(task.status, task.progress),
    0,
  ) / tasks.length);
  const hasActiveTask = tasks.some((task) => !["completed", "failed"].includes(task.status));
  return hasActiveTask ? Math.min(99, progress) : progress;
}
