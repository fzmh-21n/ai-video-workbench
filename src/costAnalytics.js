import { normalizeTaskResolution, recordedTaskResolution } from "./taskResolution.js";

export const COST_SETTINGS_KEY = "video-workbench-cost-settings-v1";

export function modelPriceKey(profileId, model) {
  return `${String(profileId || "").trim()}::${String(model || "").trim()}`;
}

export function loadCostSettings(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(COST_SETTINGS_KEY) || "{}");
    return migrateCostSettings(parsed);
  } catch {
    return {};
  }
}

export function saveCostSettings(settings, storage = localStorage) {
  storage.setItem(COST_SETTINGS_KEY, JSON.stringify(migrateCostSettings(settings)));
}

export function isResolutionPricedModel(model) {
  return model === "lg-sd2.5-v2";
}

const LG_RESOLUTION_DEFAULTS = { "480p": "3.5", "720p": "4.5" };
export const LG_COST_RESOLUTIONS = ["480p", "720p", "1080p", "4k"];

function resolutionPrices(entry) {
  const result = {};
  if (entry?.resolutionPrices && typeof entry.resolutionPrices === "object") {
    // Canonical keys win over old upper-case/numeric aliases.
    const pairs = Object.entries(entry.resolutionPrices);
    for (const [key, value] of [...pairs.filter(([key]) => key !== normalizeTaskResolution(key)), ...pairs.filter(([key]) => key === normalizeTaskResolution(key))]) {
      const resolution = normalizeTaskResolution(key);
      if (resolution) result[resolution] = value;
    }
  }
  return result;
}

export function modelResolutionPrices(model, entry = {}) {
  return { ...(isResolutionPricedModel(model) ? LG_RESOLUTION_DEFAULTS : {}), ...resolutionPrices(entry) };
}

// Additive, idempotent migration in the existing storage key. Keep old generic price/favorites.
// An explicitly blank override means "use generic price", not "restore the default".
export function migrateCostSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [key, entry];
    const model = key.slice(key.indexOf("::") + 2);
    return [key, isResolutionPricedModel(model) || entry.resolutionPrices
      ? { ...entry, resolutionPrices: modelResolutionPrices(model, entry) } : entry];
  }));
}

function priceNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function resolvedTaskPrice(task, settings = {}) {
  const entry = settings?.[modelPriceKey(task?.profileId, task?.model)] || {};
  const resolution = recordedTaskResolution(task);
  const prices = modelResolutionPrices(task?.model, entry);
  const specific = resolution ? priceNumber(prices[resolution]) : null;
  const generic = priceNumber(entry.unitPrice);
  return { resolution, unitPrice: specific ?? generic ?? 0, priced: specific !== null || generic !== null,
    source: specific !== null ? "resolution" : generic !== null ? "model" : "unpriced" };
}

export function withCostUnitPrice(settings, profileId, model, value, resolution = "") {
  const key = modelPriceKey(profileId, model);
  const entry = settings?.[key] || {};
  const normalized = normalizeTaskResolution(resolution);
  return { ...settings, [key]: normalized
    ? { ...entry, resolutionPrices: { ...modelResolutionPrices(model, entry), [normalized]: value } }
    : { ...entry, unitPrice: value } };
}

function taskTimestamp(task) {
  const completed = Date.parse(String(task?.completedAt || ""));
  if (Number.isFinite(completed)) return completed;
  const created = Number(task?.createdAtMs);
  return Number.isFinite(created) ? created : Date.parse(String(task?.createdAt || ""));
}

function dayStart(value) {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function weekStart(value) {
  const date = dayStart(value);
  const weekday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - weekday);
  return date;
}

function monthStart(value) {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addPeriod(date, period, amount) {
  const next = new Date(date);
  if (period === "day") next.setDate(next.getDate() + amount);
  else if (period === "week") next.setDate(next.getDate() + amount * 7);
  else next.setMonth(next.getMonth() + amount);
  return next;
}

function periodStart(value, period) {
  if (period === "week") return weekStart(value);
  if (period === "month") return monthStart(value);
  return dayStart(value);
}

function periodLabel(date, period) {
  if (period === "month") return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  if (period === "week") return `${date.getMonth() + 1}/${date.getDate()}周`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function taskEstimatedCost(task, settings) {
  if (task?.status !== "completed") return 0;
  return resolvedTaskPrice(task, settings).unitPrice;
}

export function costSeries(tasks, settings, period = "day", count = 14, now = Date.now()) {
  const safeCount = Math.max(1, Number(count) || 1);
  const current = periodStart(now, period);
  const buckets = Array.from({ length: safeCount }, (_value, index) => {
    const start = addPeriod(current, period, index - safeCount + 1);
    return {
      key: start.getTime(),
      start: start.getTime(),
      end: addPeriod(start, period, 1).getTime(),
      label: periodLabel(start, period),
      submitted: 0,
      generated: 0,
      failed: 0,
      cost: 0,
    };
  });
  for (const task of tasks || []) {
    const timestamp = taskTimestamp(task);
    if (!Number.isFinite(timestamp)) continue;
    const bucket = buckets.find((item) => timestamp >= item.start && timestamp < item.end);
    if (!bucket) continue;
    bucket.submitted += 1;
    if (task.status === "completed") {
      bucket.generated += 1;
      bucket.cost += taskEstimatedCost(task, settings);
    } else if (task.status === "failed") {
      bucket.failed += 1;
    }
  }
  return buckets.map((bucket) => ({ ...bucket, cost: Number(bucket.cost.toFixed(4)) }));
}

export function currentCostSummary(tasks, settings, period, now = Date.now()) {
  return costSeries(tasks, settings, period, 1, now)[0];
}

export function knownProviderModels(profiles, modelOptions, tasks) {
  const values = new Map();
  for (const profile of profiles || []) {
    const models = new Set([profile.model, ...(modelOptions?.[profile.id] || [])].filter(Boolean));
    for (const model of models) values.set(modelPriceKey(profile.id, model), {
      profileId: profile.id,
      providerName: profile.name,
      model,
      available: true,
    });
  }
  for (const task of tasks || []) {
    if (!task?.profileId || !task?.model) continue;
    const key = modelPriceKey(task.profileId, task.model);
    if (!values.has(key)) values.set(key, {
      profileId: task.profileId,
      providerName: task.providerName || "历史中转站",
      model: task.model,
      available: false,
    });
  }
  return [...values.values()].sort((left, right) => (
    left.providerName.localeCompare(right.providerName, "zh-CN")
    || left.model.localeCompare(right.model, "zh-CN", { numeric: true })
  ));
}

export function projectSuccessfulModels(tasks, settings, projectName) {
  const values = new Map();
  for (const task of tasks || []) {
    if (task?.status !== "completed" || (task.projectName || "未归类") !== projectName) continue;
    const settingKey = modelPriceKey(task.profileId, task.model);
    const price = resolvedTaskPrice(task, settings);
    const resolution = isResolutionPricedModel(task.model) ? price.resolution : "";
    const key = isResolutionPricedModel(task.model) ? `${settingKey}::${resolution || "unknown"}` : settingKey;
    if (!values.has(key)) values.set(key, {
      key, settingKey, resolution,
      profileId: task.profileId || "",
      providerName: task.providerName || "历史中转站",
      model: task.model || "未知模型",
      count: 0,
      unitPrice: 0,
      subtotal: 0,
    });
    const item = values.get(key);
    item.count += 1;
    item.unitPrice = price.unitPrice;
    item.subtotal += price.unitPrice;
  }
  return [...values.values()].map((item) => ({ ...item, subtotal: Number(item.subtotal.toFixed(4)) })).sort((left, right) => (
    left.providerName.localeCompare(right.providerName, "zh-CN")
    || left.model.localeCompare(right.model, "zh-CN", { numeric: true })
  ));
}
