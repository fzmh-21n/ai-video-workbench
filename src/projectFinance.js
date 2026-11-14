import { modelSubmissionStats } from "./submissionAnalytics.js";
import { modelPriceKey, taskEstimatedCost } from "./costAnalytics.js";

export const PROJECT_FINANCE_KEY = "video-workbench-project-finance-v1";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const ENTRY_KINDS = new Set(["cost", "income"]);
const INCOME_CHANNELS = new Set(["douyin", "baijiahao"]);

function text(value) {
  return String(value ?? "").trim();
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `finance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function amountToCents(value) {
  const raw = text(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error("金额必须是非负、最多两位小数的数字");
  const [whole, fraction = ""] = raw.split(".");
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("金额必须大于 0 且不能超过安全范围");
  return cents;
}

function centsFromNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  const cents = Math.round(number * 100);
  return Number.isSafeInteger(cents) ? cents : 0;
}

function validateMonth(value) {
  const month = text(value);
  if (!MONTH_PATTERN.test(month)) throw new Error("月份必须填写为 YYYY-MM");
  return month;
}

function normalizeEntry(entry, { allowGeneratedId = false } = {}) {
  if (!entry || typeof entry !== "object") throw new Error("项目账本记录格式无效");
  const id = text(entry.id);
  if (!id && !allowGeneratedId) throw new Error("项目账本记录缺少 ID");
  const projectName = text(entry.projectName);
  const title = text(entry.title || entry.name);
  const kind = text(entry.kind);
  if (!projectName) throw new Error("项目账本记录缺少项目名称");
  if (!ENTRY_KINDS.has(kind)) throw new Error("项目账本类型只能是 cost 或 income");
  if (!title) throw new Error("项目账本记录缺少名称");
  const incomeChannel = kind === "income" ? text(entry.incomeChannel || entry.channel) : "";
  if (kind === "income" && !INCOME_CHANNELS.has(incomeChannel)) throw new Error("收入来源只能是抖音或百家号");
  const month = validateMonth(entry.month);
  const amountCents = Number(entry.amountCents);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error("项目账本金額必须是正整数分");
  const createdAtMs = Number(entry.createdAtMs);
  const updatedAtMs = Number(entry.updatedAtMs);
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) throw new Error("项目账本记录创建时间无效");
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) throw new Error("项目账本记录更新时间无效");
  return {
    id: id || uuid(), projectName, kind, month, title, amountCents,
    note: text(entry.note), incomeChannel, createdAtMs, updatedAtMs,
  };
}

export function loadProjectFinance(storage = localStorage) {
  const raw = storage.getItem(PROJECT_FINANCE_KEY);
  if (raw === null || raw === "") return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("项目成本收益账本损坏，请先导出数据后再修复"); }
  if (!Array.isArray(parsed)) throw new Error("项目成本收益账本格式无效，请先导出数据后再修复");
  const entries = parsed.map((entry) => normalizeEntry(entry));
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("项目成本收益账本存在重复 ID");
  return entries;
}

export function saveProjectFinance(entries, storage = localStorage) {
  if (!Array.isArray(entries)) throw new Error("项目成本收益账本必须是数组");
  const normalized = entries.map((entry) => normalizeEntry(entry));
  if (new Set(normalized.map((entry) => entry.id)).size !== normalized.length) throw new Error("项目成本收益账本存在重复 ID");
  storage.setItem(PROJECT_FINANCE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function financeEntry(input, existing = null, now = Date.now()) {
  const source = input || {};
  const current = existing ? normalizeEntry(existing) : null;
  const createdAtMs = current?.createdAtMs || Number(source.createdAtMs) || Number(now);
  const updatedAtMs = Number(now);
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0 || !Number.isFinite(updatedAtMs) || updatedAtMs <= 0)
    throw new Error("项目账本时间无效");
  return normalizeEntry({
    id: current?.id || source.id || uuid(),
    projectName: source.projectName ?? current?.projectName,
    kind: source.kind ?? current?.kind,
    month: source.month ?? current?.month,
    title: source.title ?? source.name ?? current?.title,
    amountCents: source.amountCents !== undefined
      ? source.amountCents
      : source.amount !== undefined
        ? amountToCents(source.amount)
        : current?.amountCents,
    note: source.note ?? current?.note ?? "",
    incomeChannel: source.incomeChannel ?? source.channel ?? current?.incomeChannel ?? "",
    createdAtMs,
    updatedAtMs,
  });
}

export function upsertFinanceEntry(entries, entry) {
  const normalized = normalizeEntry(entry);
  const values = Array.isArray(entries) ? entries : [];
  const index = values.findIndex((item) => item?.id === normalized.id);
  if (index < 0) return [...values, normalized];
  return values.map((item, itemIndex) => itemIndex === index ? normalized : item);
}

export function removeFinanceEntry(entries, id) {
  const target = text(id);
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry?.id !== target);
}

export function financeMonthKey(date = Date.now()) {
  const value = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(value.getTime())) throw new Error("无法生成账本月份");
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

function taskMonth(record) {
  const completed = Date.parse(String(record?.completedAt || ""));
  if (Number.isFinite(completed)) return financeMonthKey(completed);
  const created = Number(record?.createdAtMs);
  return Number.isFinite(created) && created > 0 ? financeMonthKey(created) : "";
}

function projectMatches(projectName, target) {
  return target === "all" || (text(projectName) || "未归类") === target;
}

function settingHasPrice(settings, record) {
  const value = settings?.[modelPriceKey(record.profileId, record.model)]?.unitPrice;
  return value !== undefined && text(value) !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
}

export function projectFinanceSummary(tasks, settings, entries, { projectName = "all", month = "" } = {}) {
  const selectedMonth = month ? validateMonth(month) : "";
  let incomeCents = 0;
  let douyinIncomeCents = 0;
  let baijiahaoIncomeCents = 0;
  let manualCostCents = 0;
  for (const entry of entries || []) {
    const normalized = normalizeEntry(entry);
    if (!projectMatches(normalized.projectName, projectName) || (selectedMonth && normalized.month !== selectedMonth)) continue;
    if (normalized.kind === "income") {
      incomeCents += normalized.amountCents;
      if (normalized.incomeChannel === "douyin") douyinIncomeCents += normalized.amountCents;
      if (normalized.incomeChannel === "baijiahao") baijiahaoIncomeCents += normalized.amountCents;
    }
    else manualCostCents += normalized.amountCents;
  }

  let apiCostCents = 0;
  let unpricedTasks = 0;
  let undatedTasks = 0;
  const records = modelSubmissionStats(tasks || []).flatMap((group) => group.records || []);
  for (const record of records) {
    if (record.status !== "completed" || !projectMatches(record.projectName, projectName)) continue;
    const recordMonth = taskMonth(record);
    if (!recordMonth) {
      undatedTasks += 1;
      if (selectedMonth) continue;
    } else if (selectedMonth && recordMonth !== selectedMonth) continue;
    if (!settingHasPrice(settings, record)) {
      unpricedTasks += 1;
      continue;
    }
    apiCostCents += centsFromNumber(taskEstimatedCost(record, settings));
  }
  const totalCostCents = manualCostCents + apiCostCents;
  return {
    incomeCents,
    douyinIncomeCents,
    baijiahaoIncomeCents,
    manualCostCents,
    apiCostCents,
    totalCostCents,
    netCents: incomeCents - totalCostCents,
    unpricedTasks,
    undatedTasks,
  };
}

export function financeMonths(tasks, entries, projectName = "all") {
  const months = new Set();
  for (const entry of entries || []) {
    const normalized = normalizeEntry(entry);
    if (projectMatches(normalized.projectName, projectName)) months.add(normalized.month);
  }
  for (const record of modelSubmissionStats(tasks || []).flatMap((group) => group.records || [])) {
    if (record.status === "completed" && projectMatches(record.projectName, projectName)) {
      const month = taskMonth(record);
      if (month) months.add(month);
    }
  }
  return [...months].sort((left, right) => right.localeCompare(left));
}
