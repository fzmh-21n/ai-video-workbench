// 短剧流量监控：纯函数（标题归一化、抖音榜单解析、项目匹配、汇总）。红果播放量由用户每月手动录入。
// 服务端调度器（serverDramaTraffic.mjs）和前端界面共用，便于单元测试。

export const UNCLASSIFIED_DRAMA_PROJECT = "未归类";
export const DOUYIN_BILLBOARD_BASE = "https://api.amemv.com/aweme/v1/series/billboard/";
// 不上榜的短剧：按用户贴的抖音短剧／合集链接，用公开详情接口读累计播放量（不需要登录）。
export const DOUYIN_SERIES_DETAIL = "https://api.amemv.com/aweme/v1/series/detail/";
export const DOUYIN_MIX_DETAIL = "https://api.amemv.com/aweme/v1/mix/detail/";

const PUNCTUATION = /[\s\u3000《》〈〉「」『』【】〔〕（）()\[\]{}<>"'“”‘’`·•・.,，。:：;；!！?？、\/\\|_\-—–~～…#＃*＊+＋=＝&＆@＠%％^＾$￥]/g;

/** 统一全角/半角、去掉书名号、空格和标点，英文转小写。 */
export function normalizeDramaTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(PUNCTUATION, "")
    .toLowerCase();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 解析抖音短剧榜单分类接口（billboard/tab/）。 */
export function parseDouyinBillboardTabs(json) {
  if (!json || typeof json !== "object") throw new Error("抖音榜单分类返回格式无效");
  if (Number(json.status_code || 0) !== 0) throw new Error(`抖音榜单分类返回错误：${json.status_msg || json.status_code}`);
  return (Array.isArray(json.billboard_type_list) ? json.billboard_type_list : [])
    .map((item) => ({ type: finiteNumber(item?.type), name: String(item?.name || "").trim() }))
    .filter((item) => item.type !== null);
}

/** 解析抖音短剧榜单接口（billboard/?billboard_type=&offset=&count=）。 */
export function parseDouyinBillboard(json, board = {}) {
  if (!json || typeof json !== "object") throw new Error("抖音榜单返回格式无效");
  if (Number(json.status_code || 0) !== 0) throw new Error(`抖音榜单返回错误：${json.status_msg || json.status_code}`);
  const entries = (Array.isArray(json.series_infos) ? json.series_infos : []).map((item) => {
    const title = String(item?.series_name || item?.real_name || "").trim();
    return {
      source: "douyin",
      seriesId: String(item?.series_id || ""),
      title,
      normalizedTitle: normalizeDramaTitle(title),
      playCount: finiteNumber(item?.stats?.play_vv),
      collectCount: finiteNumber(item?.stats?.collect_vv),
      episodes: finiteNumber(item?.stats?.total_episode),
      tags: (Array.isArray(item?.series_content_types_new) ? item.series_content_types_new : item?.series_content_types || [])
        .map((tag) => String(tag?.name || "").trim()).filter(Boolean),
      account: String(item?.author?.nickname || "").trim(),
      board: board.name || "",
      boardType: board.type ?? null,
    };
  }).filter((entry) => entry.title);
  return {
    entries,
    hasMore: Boolean(json.has_more),
    nextOffset: finiteNumber(json.offset),
  };
}

function bestEntry(entries, field) {
  return entries.reduce((best, entry) => (best === null || (entry[field] ?? -1) > (best[field] ?? -1) ? entry : best), null);
}

/** 用项目名（=短剧名）在抖音榜单里查找。同名多条时取播放量最大的一条。 */
export function matchDramaProject(projectName, douyinEntries = []) {
  const key = normalizeDramaTitle(projectName);
  if (!key) return null;
  return bestEntry(douyinEntries.filter((entry) => entry.normalizedTitle === key), "playCount");
}

export function isMonitorableProject(name) {
  const value = String(name || "").trim();
  return Boolean(value) && value !== UNCLASSIFIED_DRAMA_PROJECT && value !== "all";
}

/** 默认是否监控：除“未归类”外默认开启。 */
export function defaultMonitorEnabled(name) {
  return isMonitorableProject(name);
}

export function localDayKey(ms = Date.now()) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 合并新的历史点（同一天覆盖），并按日期排序、限制长度。 */
export function mergeDailyHistory(history, point, maxDays = 400) {
  const rows = (Array.isArray(history) ? history : []).filter((row) => row?.date && row.date !== point.date);
  rows.push(point);
  rows.sort((left, right) => left.date.localeCompare(right.date));
  return rows.slice(-maxDays);
}


function previousValueBefore(history, field, date) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const row = history[index];
    if (row?.date < date && Number.isFinite(row[field])) return row[field];
  }
  return null;
}

/**
 * 汇总播放量。
 * projects: [{ name, active, monitor, douyin: { playCount }, history: [{ date, playCount }] }]（服务端抖音监控结果）
 * hongguoRows: [{ projectName, month, playCount }]（手动录入的红果播放量，每个项目取最近一个月）
 * projectNames: 当前存在的项目名（红果手动值只统计这些项目）
 */
export function summarizeDramaPlays(projects = [], hongguoRows = [], projectNames = null) {
  const totals = {
    douyinPlays: 0, douyinDelta: 0, hasDouyinDelta: false, douyinFound: 0, monitored: 0,
    hongguoPlays: 0, hongguoDelta: 0, hasHongguoDelta: false, hongguoProjects: 0,
    totalPlays: 0,
  };
  for (const project of projects || []) {
    if (!project?.monitor || project.active === false) continue;
    totals.monitored += 1;
    const play = finiteNumber(project.douyin?.playCount);
    if (play === null) continue;
    totals.douyinPlays += play;
    totals.douyinFound += 1;
    const history = Array.isArray(project.history) ? project.history : [];
    const lastDate = history.length ? history[history.length - 1].date : "";
    const previous = lastDate ? previousValueBefore(history, "playCount", lastDate) : null;
    if (previous !== null) { totals.douyinDelta += play - previous; totals.hasDouyinDelta = true; }
  }
  const allowed = projectNames ? new Set(projectNames) : null;
  const byProject = new Map();
  for (const row of hongguoRows || []) {
    if (allowed && !allowed.has(row.projectName)) continue;
    const list = byProject.get(row.projectName) || [];
    list.push(row);
    byProject.set(row.projectName, list);
  }
  for (const rows of byProject.values()) {
    rows.sort((left, right) => left.month.localeCompare(right.month));
    const latest = rows[rows.length - 1];
    const previous = rows[rows.length - 2];
    totals.hongguoPlays += latest.playCount;
    totals.hongguoProjects += 1;
    if (previous) { totals.hongguoDelta += latest.playCount - previous.playCount; totals.hasHongguoDelta = true; }
  }
  totals.totalPlays = totals.douyinPlays + totals.hongguoPlays;
  return totals;
}

/** 全部监控项目抖音播放量按日期合计（总览迷你曲线）。 */
export function totalDouyinSeries(projects) {
  const byDate = new Map();
  for (const project of projects || []) {
    if (!project?.monitor || project.active === false) continue;
    for (const row of project.history || []) {
      if (!Number.isFinite(row?.playCount)) continue;
      byDate.set(row.date, (byDate.get(row.date) || 0) + row.playCount);
    }
  }
  return [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, value]) => ({ date, value }));
}

export function formatPlayCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const abs = Math.abs(number);
  if (abs >= 1e8) return `${(number / 1e8).toFixed(2).replace(/\.?0+$/, "")}亿`;
  if (abs >= 1e4) return `${(number / 1e4).toFixed(1).replace(/\.0$/, "")}万`;
  return String(Math.round(number));
}

/**
 * 解析用户贴进来的抖音短剧／合集链接或分享口令。
 * 支持 iesdouyin/douyin 的 playlet、series、mix、collection 地址、series_id/mix_id/object_id 参数、纯数字 ID，
 * 以及 v.douyin.com 短链（返回 kind:"short"，由服务端跟随跳转后再解析）。
 */
export function parseDouyinDramaLink(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const pick = (pattern, kind) => { const match = text.match(pattern); return match ? { kind, id: match[1] } : null; };
  const found = pick(/\/(?:share\/)?playlet\/(?:detail\/)?(\d{12,22})/i, "series")
    || pick(/\/series\/(?:detail\/)?(\d{12,22})/i, "series")
    || pick(/[?&]series_id=(\d{12,22})/i, "series")
    || pick(/\/(?:share\/)?mix\/(?:detail\/)?(\d{12,22})/i, "mix")
    || pick(/\/collection\/(\d{12,22})/i, "mix")
    || pick(/[?&]mix_id=(\d{12,22})/i, "mix")
    || pick(/[?&]object_id=(\d{12,22})/i, "series");
  if (found) return found;
  const short = text.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/i);
  if (short) return { kind: "short", url: short[0] };
  if (/^\d{12,22}$/.test(text)) return { kind: "series", id: text };
  return null;
}

/** 解析 series/detail 或 mix/detail 的返回，取标题和累计播放量。 */
export function parseDouyinDramaDetail(json) {
  if (!json || typeof json !== "object") throw new Error("抖音详情返回格式无效");
  if (Number(json.status_code || 0) !== 0) throw new Error(`抖音详情返回错误：${json.status_msg || json.status_code}`);
  const info = json.series_info || json.mix_info;
  if (!info || typeof info !== "object") throw new Error("抖音详情里没有短剧信息");
  const stats = info.stats || info.statis || {};
  const title = String(info.series_name || info.mix_name || "").replace(/^\s*短剧\s*[·・:：]\s*/, "").trim();
  const playCount = finiteNumber(stats.play_vv);
  if (!title || playCount === null) throw new Error("抖音详情里没有播放量");
  return {
    source: "douyin",
    seriesId: String(info.series_id || info.mix_id || ""),
    title,
    normalizedTitle: normalizeDramaTitle(title),
    playCount,
    collectCount: finiteNumber(stats.collect_vv),
    episodes: finiteNumber(stats.total_episode ?? stats.updated_to_episode),
    tags: [],
    account: String(info.author?.nickname || "").trim(),
    board: json.series_info ? "短剧链接" : "合集链接",
    boardType: null,
  };
}
