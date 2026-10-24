import { modelPriceKey } from "./costAnalytics.js";

function decodedJob(id) {
  try {
    const payload = String(id || "").split(".")[0];
    const text = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const job = JSON.parse(new TextDecoder().decode(Uint8Array.from(text, (value) => value.charCodeAt(0))));
    return job?.taskId && job?.baseUrl && job?.adapter ? job : null;
  } catch {
    return null;
  }
}

function timestamp(task) {
  const direct = Number(task.createdAtMs);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(String(task.createdAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function terminal(task) {
  return task.cancelledByUser || ["completed", "failed"].includes(task.status);
}

function normalizedRecord(task) {
  if (!task?.id || task.submissionVerified === false) return null;
  const job = decodedJob(task.id);
  const taskId = String(task.upstreamTaskId || job?.taskId || task.id);
  const baseUrl = String(job?.baseUrl || task.baseUrl || "").replace(/\/+$/, "");
  return {
    identity: JSON.stringify([job?.adapter || task.adapter || "", baseUrl || task.profileId || "", taskId]),
    taskId,
    profileId: String(task.profileId || ""),
    providerName: String(task.providerName || "历史中转站"),
    model: String(job?.model || task.model || "未知模型"),
    projectName: String(task.projectName || "未归类"),
    batchTitle: String(task.batchTitle || "").trim().replace(/\.txt$/i, ""),
    batchSection: Number(task.batchSection) || 0,
    createdAtMs: timestamp(task),
    completedAt: task.completedAt,
    updatedAtMs: Number(task.updatedAtMs) || 0,
    status: String(task.status || "unknown"),
    cancelledByUser: Boolean(task.cancelledByUser),
    explicitRetry: Boolean(task.retryOfTaskId || Number(task.retryAttempt) > 0),
    error: String(task.error || "").slice(0, 500),
  };
}

function dateBoundary(value, end = false) {
  if (!value) return end ? Infinity : -Infinity;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  const [, year, month, day] = match.map(Number);
  return new Date(year, month - 1, day + (end ? 1 : 0)).getTime();
}

export function modelSubmissionStats(tasks, { projectName = "all", from = "", to = "" } = {}) {
  const unique = new Map();
  for (const task of tasks || []) {
    const record = normalizedRecord(task);
    if (!record) continue;
    const old = unique.get(record.identity);
    const createdAtMs = old?.createdAtMs
      ? Math.min(old.createdAtMs, record.createdAtMs || old.createdAtMs) : record.createdAtMs;
    if (!old || (record.updatedAtMs > old.updatedAtMs)
      || (record.updatedAtMs === old.updatedAtMs && terminal(record) && !terminal(old))) {
      unique.set(record.identity, { ...record, createdAtMs });
    } else if (createdAtMs !== old.createdAtMs) unique.set(record.identity, { ...old, createdAtMs });
  }
  const seenSections = new Set();
  const groups = new Map();
  const start = dateBoundary(from);
  const end = dateBoundary(to, true);
  const ordered = [...unique.values()].sort((left, right) => left.createdAtMs - right.createdAtMs
    || left.identity.localeCompare(right.identity));
  for (const record of ordered) {
    const sectionKey = record.batchTitle && record.batchSection > 0
      ? JSON.stringify([record.projectName, record.batchTitle, record.batchSection]) : "";
    const additional = record.explicitRetry || Boolean(sectionKey && seenSections.has(sectionKey));
    if (sectionKey) seenSections.add(sectionKey);
    if (projectName !== "all" && record.projectName !== projectName) continue;
    if ((from || to) && !record.createdAtMs) continue;
    if (!(record.createdAtMs >= start && record.createdAtMs < end)) continue;
    const key = modelPriceKey(record.profileId, record.model);
    if (!groups.has(key)) groups.set(key, {
      key, profileId: record.profileId, providerName: record.providerName, model: record.model,
      accepted: 0, completed: 0, failed: 0, processing: 0, cancelled: 0, unknown: 0, additional: 0, records: [],
    });
    const group = groups.get(key);
    group.accepted += 1;
    if (record.cancelledByUser) group.cancelled += 1;
    else if (record.status === "completed") group.completed += 1;
    else if (record.status === "failed") group.failed += 1;
    else if (["queued", "processing"].includes(record.status)) group.processing += 1;
    else group.unknown += 1;
    if (additional) group.additional += 1;
    group.records.push({ ...record, additional });
  }
  return [...groups.values()].sort((left, right) => left.providerName.localeCompare(right.providerName, "zh-CN")
    || left.model.localeCompare(right.model, "zh-CN", { numeric: true }));
}

export function submissionRecordsCsv(records) {
  const cell = (value) => {
    const text = String(value ?? "");
    const safe = /^[\s\uFEFF]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = [["中转站", "模型", "上游task ID", "项目", "章节文件", "节号", "本机提交或恢复记录时间", "状态", "同节追加", "退款"]];
  for (const record of records || []) rows.push([
    record.providerName, record.model, record.taskId, record.projectName, record.batchTitle, record.batchSection || "",
    record.createdAtMs ? new Date(record.createdAtMs).toLocaleString("zh-CN", { hour12: false }) : "时间未知",
    record.cancelledByUser ? "手动取消（不代表退款）" : record.status,
    record.additional ? "是（含主动重做/抽卡）" : "否", "未核实",
  ]);
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}
