// 短剧抖音播放量监控：每 24 小时按项目名（=短剧名）去抖音短剧榜单匹配一次，并保存每日历史。
// 红果播放量由用户在成本统计里每月手动录入，不在这里抓取。
import express from "express";
import path from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  DOUYIN_BILLBOARD_BASE,
  defaultMonitorEnabled,
  localDayKey,
  matchDramaProject,
  mergeDailyHistory,
  parseDouyinBillboard,
  parseDouyinBillboardTabs,
} from "./src/dramaTraffic.js";

export const DRAMA_TRAFFIC_FILE = "drama-traffic.json";
export const DRAMA_TRAFFIC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILED_RETRY_MS = 2 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 30 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60 * 1000;
const MAX_PAGES_PER_BOARD = 10;
const PAGE_SIZE = 15;
const MAX_PROJECTS = 500;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FALLBACK_BOARDS = [{ type: 1001, name: "热播榜" }];

function emptyState() {
  return { version: 1, projects: {}, lastRun: null, lastEntries: [] };
}

function readState(file) {
  if (!existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.projects !== "object") return emptyState();
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

function writeState(file, state) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 1));
  renameSync(temp, file);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDramaTrafficService({
  dataDir,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  intervalMs = DRAMA_TRAFFIC_INTERVAL_MS,
  pageDelayMs = 800,
  retryDelayMs = 2000,
  timeoutMs = 15000,
  logger = console,
} = {}) {
  const file = path.join(dataDir, DRAMA_TRAFFIC_FILE);
  let state = readState(file);
  let running = null;
  const timers = [];

  const save = () => writeState(file, state);

  async function fetchJson(url) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json,text/plain,*/*" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt === 0) await sleep(retryDelayMs);
      }
    }
    throw lastError;
  }

  async function fetchDouyinEntries() {
    let boards = FALLBACK_BOARDS;
    const problems = [];
    try {
      const tabs = parseDouyinBillboardTabs(await fetchJson(`${DOUYIN_BILLBOARD_BASE}tab/`));
      if (tabs.length) boards = tabs;
    } catch (error) {
      problems.push(`榜单分类读取失败（${error.message}），只查热播榜`);
    }
    const entries = [];
    let okBoards = 0;
    for (const board of boards) {
      let offset = 0;
      let boardOk = false;
      for (let page = 0; page < MAX_PAGES_PER_BOARD; page += 1) {
        await sleep(pageDelayMs);
        try {
          const url = `${DOUYIN_BILLBOARD_BASE}?billboard_type=${encodeURIComponent(board.type)}&offset=${offset}&count=${PAGE_SIZE}`;
          const result = parseDouyinBillboard(await fetchJson(url), board);
          boardOk = true;
          entries.push(...result.entries);
          if (!result.hasMore || !result.entries.length || result.nextOffset === null || result.nextOffset <= offset) break;
          offset = result.nextOffset;
        } catch (error) {
          problems.push(`${board.name || board.type} 第 ${page + 1} 页失败：${error.message}`);
          break;
        }
      }
      if (boardOk) okBoards += 1;
    }
    return { entries, boards: boards.length, okBoards, problems };
  }

  function applyEntries(entries, { dayKey, checkedAt, fetchFailed, message = "" }) {
    for (const [name, project] of Object.entries(state.projects)) {
      if (!project.active || !project.monitor) continue;
      const match = fetchFailed ? null : matchDramaProject(name, entries);
      project.lastCheckedAt = checkedAt;
      if (match) {
        project.status = "found";
        project.message = "";
        project.lastFoundAt = checkedAt;
        project.douyin = {
          playCount: match.playCount, collectCount: match.collectCount, seriesId: match.seriesId, title: match.title,
          account: match.account, tags: match.tags, board: match.board, episodes: match.episodes,
        };
        if (Number.isFinite(match.playCount)) project.history = mergeDailyHistory(project.history, { date: dayKey, playCount: match.playCount });
      } else if (fetchFailed) {
        project.status = "failed";
        project.message = message || "抖音榜单未取到，保留上次数据";
      } else {
        project.status = "not_found";
        project.message = "未在抖音短剧榜单中找到同名短剧，保留上次数据";
      }
    }
  }

  async function runRefresh(reason) {
    const startedAt = now();
    state.lastRun = { ...(state.lastRun || {}), startedAt, reason, status: "running" };
    let result;
    try {
      result = await fetchDouyinEntries();
    } catch (error) {
      result = { entries: [], boards: 0, okBoards: 0, problems: [error.message] };
    }
    const fetchFailed = result.okBoards === 0;
    const message = result.problems.slice(0, 5).join("；");
    applyEntries(result.entries, { dayKey: localDayKey(startedAt), checkedAt: now(), fetchFailed, message });
    if (!fetchFailed) state.lastEntries = result.entries.map(({ title, normalizedTitle, playCount, collectCount, seriesId, account, tags, board, episodes }) => ({ title, normalizedTitle, playCount, collectCount, seriesId, account, tags, board, episodes }));
    state.lastRun = {
      startedAt, finishedAt: now(), reason,
      status: fetchFailed ? "failed" : (result.problems.length ? "partial" : "ok"),
      boards: result.boards, okBoards: result.okBoards, entries: result.entries.length, message,
    };
    save();
    if (fetchFailed) logger?.warn?.(`[drama-traffic] 抖音榜单未取到：${message}`);
    return snapshot();
  }

  function refresh(reason = "manual") {
    if (!running) running = runRefresh(reason).finally(() => { running = null; });
    return running;
  }

  function nextRunAt() {
    const last = state.lastRun;
    if (!last?.startedAt) return now();
    return last.startedAt + (last.status === "failed" ? FAILED_RETRY_MS : intervalMs);
  }

  function isDue() {
    const hasMonitored = Object.values(state.projects).some((project) => project.active && project.monitor);
    return hasMonitored && !running && now() >= nextRunAt();
  }

  function snapshot() {
    return {
      running: Boolean(running),
      lastRun: state.lastRun,
      nextRunAt: nextRunAt(),
      intervalHours: Math.round(intervalMs / 3600000),
      projects: Object.entries(state.projects).map(([name, project]) => ({ name, ...project })),
    };
  }

  function syncProjects(names) {
    if (!Array.isArray(names)) throw Object.assign(new Error("projects 必须是项目名称数组"), { status: 400 });
    const clean = [...new Set(names.map((name) => String(name ?? "").trim()).filter((name) => name && name.length <= 120))].slice(0, MAX_PROJECTS);
    const present = new Set(clean);
    const added = [];
    for (const name of clean) {
      if (!state.projects[name]) {
        const monitor = defaultMonitorEnabled(name);
        state.projects[name] = { monitor, active: true, status: monitor ? "pending" : "disabled", message: "", douyin: null, history: [], lastCheckedAt: 0, lastFoundAt: 0 };
        added.push(name);
      } else state.projects[name].active = true;
    }
    for (const [name, project] of Object.entries(state.projects)) if (!present.has(name)) project.active = false;
    // 新项目先用上一次抓到的榜单立即匹配一次，不额外请求抖音。
    if (added.length && state.lastEntries?.length && state.lastRun?.finishedAt) {
      const subset = Object.fromEntries(added.map((name) => [name, state.projects[name]]));
      const all = state.projects;
      state.projects = subset;
      applyEntries(state.lastEntries, { dayKey: localDayKey(state.lastRun.startedAt), checkedAt: state.lastRun.finishedAt, fetchFailed: false });
      state.projects = { ...all, ...subset };
    }
    save();
    return snapshot();
  }

  function setMonitor(name, monitor) {
    const key = String(name ?? "").trim();
    if (!state.projects[key]) throw Object.assign(new Error("项目不存在，请先刷新项目列表"), { status: 404 });
    state.projects[key].monitor = Boolean(monitor);
    if (!monitor) { state.projects[key].status = "disabled"; state.projects[key].message = "已关闭监控"; }
    else if (state.projects[key].status === "disabled") state.projects[key].status = "pending";
    save();
    return snapshot();
  }

  function start() {
    const check = () => { if (isDue()) refresh("schedule").catch((error) => logger?.warn?.(`[drama-traffic] ${error.message}`)); };
    const first = setTimeout(check, FIRST_CHECK_DELAY_MS);
    const repeat = setInterval(check, CHECK_EVERY_MS);
    first.unref?.(); repeat.unref?.();
    timers.push(first, repeat);
  }

  function stop() {
    for (const timer of timers.splice(0)) { clearTimeout(timer); clearInterval(timer); }
  }

  return { snapshot, syncProjects, setMonitor, refresh, isDue, nextRunAt, start, stop, get file() { return file; } };
}

export function dramaTrafficRouter(service) {
  const router = express.Router();
  router.get("/", (_req, res) => res.json(service.snapshot()));
  router.put("/projects", (req, res, next) => {
    try { res.json(service.syncProjects(req.body?.projects)); } catch (error) { next(error); }
  });
  router.put("/monitor", (req, res, next) => {
    try { res.json(service.setMonitor(req.body?.name, req.body?.monitor)); } catch (error) { next(error); }
  });
  router.post("/refresh", (_req, res) => {
    service.refresh("manual").catch(() => {});
    res.status(202).json(service.snapshot());
  });
  return router;
}
