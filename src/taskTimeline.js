function timestamp(value) {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatTaskTime(value, fallbackMs = 0) {
  if (value && typeof value === "string" && !timestamp(value)) return value;
  const time = timestamp(value) || timestamp(fallbackMs);
  return time ? new Date(time).toLocaleString("zh-CN", { hour12: false }) : "—";
}

export function taskTimeline(task) {
  return {
    submitted: formatTaskTime(task?.createdAt, task?.createdAtMs),
    generated: task?.status === "completed"
      ? formatTaskTime(task?.completedAt, task?.completedAtMs)
      : "—",
  };
}

export function batchTimeline(tasks = []) {
  const submittedTimes = tasks.map((task) => timestamp(task?.createdAt) || timestamp(task?.createdAtMs)).filter(Boolean);
  const allCompleted = tasks.length > 0 && tasks.every((task) => task?.status === "completed");
  const completedTimes = allCompleted
    ? tasks.map((task) => timestamp(task?.completedAt) || timestamp(task?.completedAtMs)).filter(Boolean)
    : [];
  return {
    submitted: submittedTimes.length ? formatTaskTime(Math.min(...submittedTimes)) : "—",
    generated: allCompleted && completedTimes.length === tasks.length
      ? formatTaskTime(Math.max(...completedTimes))
      : "—",
  };
}
