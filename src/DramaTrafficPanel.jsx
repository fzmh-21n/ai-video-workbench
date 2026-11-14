import React, { useEffect, useMemo, useState } from "react";
import { formatPlayCount, summarizeDramaPlays, totalDouyinSeries } from "./dramaTraffic.js";
import {
  latestHongguoPlay,
  loadHongguoPlays,
  parsePlayCountInput,
  removeHongguoPlay,
  saveHongguoPlays,
  upsertHongguoPlay,
} from "./projectFinance.js";

const STATUS_TEXT = {
  found: "已上榜",
  not_found: "未上榜/未找到",
  failed: "未取到",
  pending: "等待首次更新",
  disabled: "未监控",
};

async function readJson(response) {
  let body = {};
  try { body = await response.json(); } catch { /* 非 JSON */ }
  if (!response.ok) throw new Error(body.message || `本机服务返回 HTTP ${response.status}`);
  return body;
}

function timeText(ms) {
  return ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

function deltaText(value, show) {
  if (!show) return "";
  if (!value) return "持平";
  return `${value > 0 ? "+" : "−"}${formatPlayCount(Math.abs(value))}`;
}

function Sparkline({ values, width = 120, height = 30 }) {
  if (values.length < 2) return <span className="drama-spark-empty">{values.length ? "仅 1 天" : "—"}</span>;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1) * (width - 4) + 2).toFixed(1)},${(height - 3 - (value - min) / range * (height - 6)).toFixed(1)}`).join(" ");
  return <svg className="drama-spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true"><polyline points={points} /></svg>;
}

export default function DramaTrafficPanel({ projects, projectFilter, defaultMonth }) {
  const [server, setServer] = useState(null);
  const [serverError, setServerError] = useState("");
  const [hongguoRows, setHongguoRows] = useState(() => { try { return loadHongguoPlays(); } catch { return []; } });
  const [hongguoError, setHongguoError] = useState("");
  const monitorableProjects = useMemo(() => projects.filter((name) => name && name !== "all"), [projects]);
  const [form, setForm] = useState({ projectName: "", month: defaultMonth, playCount: "" });
  const projectKey = monitorableProjects.join("\n");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/drama-traffic/projects", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projects: monitorableProjects }) })
      .then(readJson)
      .then((body) => { if (!cancelled) { setServer(body); setServerError(""); } })
      .catch((error) => { if (!cancelled) setServerError(error.message || "无法连接本机服务"); });
    return () => { cancelled = true; };
  }, [projectKey]);

  useEffect(() => {
    if (!server?.running) return undefined;
    const timer = setInterval(() => {
      fetch("/api/drama-traffic").then(readJson).then(setServer).catch((error) => setServerError(error.message));
    }, 3000);
    return () => clearInterval(timer);
  }, [server?.running]);

  useEffect(() => {
    if (!form.projectName && monitorableProjects.length) setForm((current) => ({ ...current, projectName: projectFilter !== "all" ? projectFilter : monitorableProjects.find((name) => name !== "未归类") || monitorableProjects[0] }));
  }, [projectKey]);

  const serverProjects = useMemo(() => new Map((server?.projects || []).map((project) => [project.name, project])), [server]);
  const activeServerProjects = (server?.projects || []).filter((project) => project.active !== false && monitorableProjects.includes(project.name));
  const totals = summarizeDramaPlays(activeServerProjects, hongguoRows, monitorableProjects);
  const totalSeries = totalDouyinSeries(activeServerProjects).slice(-30).map((row) => row.value);
  const rows = monitorableProjects.filter((name) => projectFilter === "all" || name === projectFilter);
  const formHistory = latestHongguoPlay(hongguoRows, form.projectName).history;

  async function refreshNow() {
    try {
      setServer(await readJson(await fetch("/api/drama-traffic/refresh", { method: "POST" })));
      setServerError("");
    } catch (error) { setServerError(error.message); }
  }

  async function toggleMonitor(name, monitor) {
    try {
      setServer(await readJson(await fetch("/api/drama-traffic/monitor", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, monitor }) })));
      setServerError("");
    } catch (error) { setServerError(error.message); }
  }

  function persistHongguo(next) {
    saveHongguoPlays(next);
    setHongguoRows(next);
    setHongguoError("");
  }

  function submitHongguo(event) {
    event.preventDefault();
    try {
      persistHongguo(upsertHongguoPlay(hongguoRows, { projectName: form.projectName, month: form.month, playCount: parsePlayCountInput(form.playCount) }));
      setForm((current) => ({ ...current, playCount: "" }));
    } catch (error) { setHongguoError(error.message || "保存红果播放量失败"); }
  }

  function deleteHongguo(row) {
    if (!window.confirm(`确定删除“${row.projectName}”${row.month} 的红果播放量吗？`)) return;
    try { persistHongguo(removeHongguoPlay(hongguoRows, row.projectName, row.month)); }
    catch (error) { setHongguoError(error.message || "删除红果播放量失败"); }
  }

  const lastRun = server?.lastRun;
  const runText = server?.running ? "正在从抖音短剧榜单更新…"
    : lastRun?.finishedAt ? `上次更新 ${timeText(lastRun.finishedAt)}${lastRun.status === "failed" ? "（抖音榜单未取到）" : lastRun.status === "partial" ? "（部分榜单未取到）" : ""}` : "还没有更新过";

  return (
    <div className="cost-pane drama-pane" role="tabpanel" aria-label="短剧流量">
      <div className="cost-kpis drama-kpis">
        <div className="cost-kpi cost-kpi-main"><span>合计播放量</span><b>{formatPlayCount(totals.totalPlays)}</b><small>全部项目 · 抖音＋红果</small></div>
        <div className="cost-kpi"><span>抖音播放量 <em className="drama-tag">自动</em></span><b>{formatPlayCount(totals.douyinPlays)}</b><small>{totals.hasDouyinDelta ? `较前一日 ${deltaText(totals.douyinDelta, true)}` : `${totals.douyinFound}/${totals.monitored} 部已上榜`}</small><Sparkline values={totalSeries} width={150} height={26} /></div>
        <div className="cost-kpi"><span>红果播放量 <em className="drama-tag">手动</em></span><b>{formatPlayCount(totals.hongguoPlays)}</b><small>{totals.hasHongguoDelta ? `较上次录入 ${deltaText(totals.hongguoDelta, true)}` : `${totals.hongguoProjects} 个项目已录入（各取最近月份）`}</small></div>
      </div>

      <div className="cost-table-toolbar">
        <h3>每部短剧 <small>{runText}{server?.nextRunAt && !server?.running ? ` · 下次自动更新 ${timeText(server.nextRunAt)}` : ""}</small></h3>
        <div>
          <details className="cost-info cost-info-right"><summary>说明</summary><div>
            <p>短剧上架后，把项目名改成和抖音上一致的短剧名。工作台后台每 24 小时用项目名去抖音短剧榜单（全部分类）匹配一次累计播放量，并按天保存历史。匹配时会忽略书名号、空格、标点和全半角差异。</p>
            <p>只有出现在抖音短剧榜单上的剧才能取到数据；没上榜时显示“未上榜/未找到”，并保留上一次的数字。“未归类”和不想跟踪的项目可以取消勾选“监控”。工作台服务需要保持运行，打开过一次成本统计后，项目列表才会同步到后台。</p>
            <p>红果播放量请每月手动录入一次最终播放量；合计里每个项目取最近一次录入的月份。</p>
          </div></details>
          <button onClick={refreshNow} disabled={Boolean(server?.running) || Boolean(serverError && !server)}>{server?.running ? "更新中…" : "立即刷新"}</button>
        </div>
      </div>
      {serverError && <p className="cost-hint" role="alert">抖音播放量服务：{serverError}（红果播放量仍可手动录入）</p>}

      <div className="submission-table-scroll"><table className="submission-table drama-table"><thead><tr>
        <th>项目／短剧名</th><th className="action">监控</th><th className="num">抖音播放量</th><th>近 30 天</th><th className="num">较前一日</th><th className="num">红果播放量</th><th>状态</th>
      </tr></thead><tbody>{rows.map((name) => {
        const project = serverProjects.get(name);
        const history = project?.history || [];
        const last = history[history.length - 1];
        const previous = history[history.length - 2];
        const delta = last && previous ? last.playCount - previous.playCount : null;
        const hongguo = latestHongguoPlay(hongguoRows, name).latest;
        const status = project ? (project.monitor ? project.status : "disabled") : "pending";
        return <tr key={name}>
          <td><span>{name}</span>{project?.douyin?.account && <code>{project.douyin.account} · {project.douyin.board}</code>}</td>
          <td className="action"><input type="checkbox" aria-label={`监控 ${name}`} disabled={!project} checked={Boolean(project?.monitor)} onChange={(event) => toggleMonitor(name, event.target.checked)} /></td>
          <td className={`num${project?.douyin?.playCount ? "" : " is-zero"}`}>{formatPlayCount(project?.douyin?.playCount)}</td>
          <td><Sparkline values={history.slice(-30).map((row) => row.playCount)} /></td>
          <td className={`num${delta ? "" : " is-zero"}`}>{delta === null ? "—" : deltaText(delta, true)}</td>
          <td className={`num${hongguo ? "" : " is-zero"}`}><button className="cost-link-button" title="录入红果播放量" onClick={() => setForm((current) => ({ ...current, projectName: name }))}>{hongguo ? formatPlayCount(hongguo.playCount) : "录入"}</button>{hongguo && <small className="drama-month">{hongguo.month}</small>}</td>
          <td><span className={`drama-status drama-status-${status}`}>{STATUS_TEXT[status] || status}</span><small className="drama-checked">{project?.lastCheckedAt ? timeText(project.lastCheckedAt) : ""}</small></td>
        </tr>;
      })}</tbody></table></div>
      {!rows.length && <p className="cost-empty">还没有项目。</p>}

      <h4 className="cost-subtitle">录入红果播放量 <small>每个项目每月一次，填最终播放量；同月再次保存会覆盖</small></h4>
      <form className="finance-entry-form" onSubmit={submitHongguo}>
        <label><span>项目</span><select value={form.projectName} onChange={(event) => setForm((current) => ({ ...current, projectName: event.target.value }))}>{monitorableProjects.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label><span>月份</span><input type="month" required value={form.month} onChange={(event) => setForm((current) => ({ ...current, month: event.target.value }))} /></label>
        <label><span>红果播放量</span><input required value={form.playCount} onChange={(event) => setForm((current) => ({ ...current, playCount: event.target.value }))} placeholder="例如 356.8万" /></label>
        <div className="finance-entry-actions"><button className="primary-button" type="submit" disabled={!form.projectName}>保存红果播放量</button></div>
      </form>
      {hongguoError && <p className="task-project-error" role="alert">{hongguoError}</p>}
      {formHistory.length > 0 && <div className="drama-hongguo-history">{formHistory.slice().reverse().map((row) => (
        <span key={row.month}>{row.month} <b>{formatPlayCount(row.playCount)}</b><button className="cost-link-button" onClick={() => deleteHongguo(row)} aria-label={`删除 ${row.month}`}>删除</button></span>
      ))}</div>}
    </div>
  );
}
