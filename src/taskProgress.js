export function normalizedTaskProgress(status, value) {
  if (status === "completed") return 100;
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}
