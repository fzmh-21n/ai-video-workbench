import React, { useEffect, useMemo, useState } from "react";
import { getSubmissionRecords } from "./taskStore.js";
import { modelSubmissionStats, submissionRecordsCsv } from "./submissionAnalytics.js";
import { downloadBlob } from "./downloadBlob.js";
import {
  costSeries,
  currentCostSummary,
  knownProviderModels,
  loadCostSettings,
  modelPriceKey,
  saveCostSettings,
} from "./costAnalytics.js";
import {
  financeEntry,
  financeMonthKey,
  financeMonths,
  loadProjectFinance,
  projectFinanceSummary,
  removeFinanceEntry,
  saveProjectFinance,
  upsertFinanceEntry,
  LUMP_SUM_PROJECT,
  financeLumpEntry,
  loadFinanceLumpSums,
  saveFinanceLumpSums,
  withFinanceLumpSum,
} from "./projectFinance.js";
import { buildRevenueChart } from "./financeChart.js";
import RevenueChart from "./RevenueChart.jsx";
import CostTrendChart from "./CostTrendChart.jsx";
import DramaTrafficPanel from "./DramaTrafficPanel.jsx";
import { formatPlayCount, summarizeDramaPlays } from "./dramaTraffic.js";
import { loadHongguoPlays } from "./projectFinance.js";

const PERIODS = {
  day: { label: "每天", count: 14 },
  week: { label: "每周", count: 12 },
  month: { label: "每月", count: 12 },
};

const COST_TABS = [["finance", "收支账本"], ["drama", "短剧流量"]];
const COST_MODULES = [["submissions", "模型提交台账"], ["favorites", "常用模型"], ["prices", "模型单价设置"]];

const SUBMISSION_COLUMNS = [
  { key: "accepted", label: "已受理", always: true },
  { key: "completed", label: "已生成" },
  { key: "failed", label: "生成失败" },
  { key: "processing", label: "处理中" },
  { key: "cancelled", label: "手动取消" },
  { key: "unknown", label: "状态未知" },
  { key: "additional", label: "同节追加" },
];

function money(value) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

function moneyCents(value) {
  return money(Number(value || 0) / 100);
}

export default function CostDashboard({ activeProfileId, modelOptions, onClose, onSelectModel, profiles, projectNames = [] }) {
  const [tasks, setTasks] = useState([]);
  const [financeTasks, setFinanceTasks] = useState([]);
  const [financeEntries, setFinanceEntries] = useState([]);
  const [settings, setSettings] = useState(loadCostSettings);
  const [period, setPeriod] = useState("day");
  const [providerFilter, setProviderFilter] = useState(activeProfileId || "all");
  const [modelQuery, setModelQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selectedKey, setSelectedKey] = useState("");
  const [detailPage, setDetailPage] = useState(1);
  const [financeMonth, setFinanceMonth] = useState(financeMonthKey());
  const [financeForm, setFinanceForm] = useState({
    projectName: "未归类", kind: "cost", incomeChannel: "douyin", month: financeMonthKey(), title: "", amount: "", note: "",
  });
  const [financeEditingId, setFinanceEditingId] = useState("");
  const [financeError, setFinanceError] = useState("");
  const [activeTab, setActiveTab] = useState("finance");
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [chartMode, setChartMode] = useState("month");
  const [chartRange, setChartRange] = useState("12");
  const [trafficServer, setTrafficServer] = useState(null);
  const [hongguoRows, setHongguoRows] = useState(() => { try { return loadHongguoPlays(); } catch { return []; } });
  const [openModules, setOpenModules] = useState([]);
  const toggleModule = (key) => setOpenModules((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const [lumpSums, setLumpSums] = useState({});
  const [lumpForm, setLumpForm] = useState({ income: "", cost: "", note: "" });
  const [lumpError, setLumpError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getSubmissionRecords(), Promise.resolve().then(() => loadProjectFinance())]).then(([values, entries]) => {
      if (!cancelled) { setTasks(values); setFinanceTasks(values); setFinanceEntries(entries); setLoadError(""); }
      if (!cancelled) {
        try {
          const lumps = loadFinanceLumpSums();
          const lump = lumps[LUMP_SUM_PROJECT];
          setLumpSums(lumps);
          setLumpForm({ income: lump ? (lump.incomeCents / 100).toFixed(2) : "", cost: lump ? (lump.costCents / 100).toFixed(2) : "", note: lump?.note || "" });
          setLumpError("");
        } catch (error) { setLumpError(error.message || "未归类历史汇总读取失败"); }
      }
    }).catch((error) => {
      if (!cancelled) setLoadError(error.message || "提交台账读取失败，请重试");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [refreshVersion]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/drama-traffic").then((response) => response.ok ? response.json() : null)
      .then((body) => { if (!cancelled && body) setTrafficServer(body); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [refreshVersion]);

  function updateSetting(profileId, model, patch) {
    const key = modelPriceKey(profileId, model);
    setSettings((current) => {
      const next = { ...current, [key]: { ...(current[key] || {}), ...patch } };
      saveCostSettings(next);
      return next;
    });
  }

  const knownModels = useMemo(
    () => knownProviderModels(profiles, modelOptions, tasks),
    [profiles, modelOptions, tasks],
  );
  const providers = useMemo(() => [...new Map(knownModels.map((item) => [item.profileId, item.providerName])).entries()], [knownModels]);
  const visibleModels = useMemo(() => knownModels.filter((item) => (
    (providerFilter === "all" || item.profileId === providerFilter)
    && (!modelQuery.trim() || modelDisplayName(item).toLowerCase().includes(modelQuery.trim().toLowerCase())
      || item.model.toLowerCase().includes(modelQuery.trim().toLowerCase()))
  )), [knownModels, providerFilter, modelQuery, profiles]);
  const favorites = knownModels.filter((item) => settings[modelPriceKey(item.profileId, item.model)]?.favorite);
  const costTasks = useMemo(() => modelSubmissionStats(tasks).flatMap((item) => item.records), [tasks]);
  const series = costSeries(costTasks, settings, period, PERIODS[period].count);
  const today = currentCostSummary(costTasks, settings, "day");
  const week = currentCostSummary(costTasks, settings, "week");
  const month = currentCostSummary(costTasks, settings, "month");
  const projects = useMemo(() => [...new Set(tasks.map((task) => task.projectName || "未归类"))]
    .concat(["未归类"], projectNames || [], financeEntries.map((entry) => entry.projectName))
    .filter(Boolean)
    .filter((name, index, values) => values.indexOf(name) === index)
    .sort((left, right) => left.localeCompare(right, "zh-CN")), [tasks, financeEntries, projectNames]);
  const submissionGroups = useMemo(() => modelSubmissionStats(tasks, {
    projectName: projectFilter, from: fromDate, to: toDate,
  }).filter((item) => (providerFilter === "all" || item.profileId === providerFilter)
    && (!modelQuery.trim() || modelDisplayName(item).toLowerCase().includes(modelQuery.trim().toLowerCase())
      || item.model.toLowerCase().includes(modelQuery.trim().toLowerCase()))),
  [tasks, projectFilter, fromDate, toDate, providerFilter, modelQuery, profiles]);
  const selectedGroup = submissionGroups.find((item) => item.key === selectedKey);
  const detailRecords = selectedGroup?.records || [];
  const detailPages = Math.max(1, Math.ceil(detailRecords.length / 50));
  const currentDetailPage = Math.min(detailPage, detailPages);
  const shownRecords = detailRecords.slice((currentDetailPage - 1) * 50, currentDetailPage * 50);
  const acceptedCount = submissionGroups.reduce((total, item) => total + item.accepted, 0);
  const financeSummary = projectFinanceSummary(financeTasks, settings, financeEntries, { projectName: projectFilter, month: financeMonth });
  const visibleFinanceEntries = financeEntries
    .filter((entry) => (projectFilter === "all" || entry.projectName === projectFilter) && entry.month === financeMonth)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  function modelDisplayName(item) {
    return profiles.find((profile) => profile.id === item.profileId)?.routeLabels?.[item.model] || item.model;
  }

  function resetFinanceForm(month = financeMonth) {
    setFinanceEditingId("");
    setFinanceForm({ projectName: projectFilter === "all" ? projects[0] || "未归类" : projectFilter, kind: "cost", incomeChannel: "douyin", month, title: "", amount: "", note: "" });
    setFinanceError("");
  }

  function submitFinanceEntry(event) {
    event.preventDefault();
    try {
      const existing = financeEditingId ? financeEntries.find((entry) => entry.id === financeEditingId) : null;
      const nextEntry = financeEntry(financeForm, existing);
      const next = upsertFinanceEntry(financeEntries, nextEntry);
      saveProjectFinance(next);
      setFinanceEntries(next);
      setFinanceMonth(nextEntry.month);
      resetFinanceForm(nextEntry.month);
    } catch (error) {
      setFinanceError(error.message || "保存项目账本失败");
    }
  }

  function editFinanceEntry(entry) {
    setFinanceEditingId(entry.id);
    setFinanceForm({ projectName: entry.projectName, kind: entry.kind, incomeChannel: entry.incomeChannel || "douyin", month: entry.month, title: entry.title, amount: (entry.amountCents / 100).toFixed(2), note: entry.note || "" });
    setFinanceError("");
  }

  function deleteFinanceEntry(entry) {
    if (!window.confirm(`确定删除“${entry.title}”这条${entry.kind === "income" ? "收入" : "成本"}记录吗？`)) return;
    try {
      const next = removeFinanceEntry(financeEntries, entry.id);
      saveProjectFinance(next);
      setFinanceEntries(next);
      if (financeEditingId === entry.id) resetFinanceForm();
    } catch (error) {
      setFinanceError(error.message || "删除项目账本失败");
    }
  }

  async function exportSubmissions() {
    try {
      const records = selectedGroup ? detailRecords : submissionGroups.flatMap((item) => item.records);
      await downloadBlob(new Blob([submissionRecordsCsv(records)], { type: "text/csv;charset=utf-8" }), "模型提交台账.csv");
    } catch (error) {
      setLoadError(error.message || "导出提交台账失败");
    }
  }

  const totalCostCents = financeSummary.manualCostCents + financeSummary.apiCostCents;
  const financeScope = `${financeMonth} · ${projectFilter === "all" ? "全部项目" : projectFilter}`;
  const visibleColumns = SUBMISSION_COLUMNS.filter((column) => column.always || showAllColumns
    || submissionGroups.some((item) => Number(item[column.key]) !== 0));
  const hiddenColumnCount = SUBMISSION_COLUMNS.length - visibleColumns.length;
  const refresh = () => setRefreshVersion((value) => value + 1);
  const todayMonth = financeMonthKey();
  const todayText = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-");
  const revenueChart = useMemo(() => {
    let count = 12;
    if (chartRange === "all") {
      const earliest = financeMonths(financeTasks, financeEntries, projectFilter).filter((month) => month <= todayMonth).at(-1);
      if (earliest) {
        const [fromYear, fromMonth] = earliest.split("-").map(Number);
        const [toYear, toMonth] = todayMonth.split("-").map(Number);
        count = Math.max(12, (toYear - fromYear) * 12 + toMonth - fromMonth + 1);
      }
    }
    return buildRevenueChart({ tasks: financeTasks, settings, entries: financeEntries, lumps: lumpSums, projectName: projectFilter, endMonth: todayMonth, count });
  }, [financeTasks, settings, financeEntries, lumpSums, projectFilter, todayMonth, chartRange]);
  const trafficProjects = projects.filter((name) => projectFilter === "all" || name === projectFilter);
  const trafficTotals = summarizeDramaPlays((trafficServer?.projects || []).filter((project) => project.active !== false && trafficProjects.includes(project.name)), hongguoRows, trafficProjects);
  const projectLabel = projectFilter === "all" ? "全部项目" : projectFilter;
  const totalsSplit = revenueChart.totals;
  const splitRows = (rows) => <div className="cost-kpi-split">{rows.filter(([, , cents, always]) => always || cents).map(([label, tone, cents]) => <span key={label}><i className={tone}>{label}</i><em>{moneyCents(cents)}</em></span>)}</div>;
  const showLumpForm = projectFilter === "all" || projectFilter === LUMP_SUM_PROJECT;

  function saveLumpSum(event) {
    event.preventDefault();
    try {
      const next = withFinanceLumpSum(lumpSums, LUMP_SUM_PROJECT, financeLumpEntry(lumpForm));
      setLumpSums(saveFinanceLumpSums(next));
      setLumpError("");
    } catch (error) { setLumpError(error.message || "保存未归类历史汇总失败"); }
  }

  function clearLumpSum() {
    if (!window.confirm("确定清除未归类的历史总收入和总成本吗？")) return;
    try {
      setLumpSums(saveFinanceLumpSums(withFinanceLumpSum(lumpSums, LUMP_SUM_PROJECT, null)));
      setLumpForm({ income: "", cost: "", note: "" });
      setLumpError("");
    } catch (error) { setLumpError(error.message || "清除未归类历史汇总失败"); }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="cost-dialog cost-center" role="dialog" aria-label="成本统计" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading"><div><span>COST CENTER</span><h2>提交台账与成本统计</h2></div><button onClick={onClose} aria-label="关闭">×</button></div>
        {loadError && <p className="cost-footnote cost-alert" role="alert">{loadError} <button onClick={refresh}>重新读取</button></p>}
        {loading ? <div className="cost-loading">正在读取本机任务记录…</div> : <>
          <section className="cost-overview" aria-label="总览">
            <div className="cost-section-head">
              <div><span className="cost-section-kicker">总览</span><h3>截至 {todayText} · 所有月份累计</h3></div>
              <div className="cost-section-tools">
                <label><span>项目范围</span><select aria-label="统计项目" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">全部项目</option>{projects.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
                <button className="cost-tabs-refresh" onClick={refresh} title="重新读取本机任务记录、账本和播放量">刷新统计</button>
              </div>
            </div>
            <div className="cost-kpis cost-overview-kpis">
              <div className="cost-kpi"><span>总收入</span><b>{moneyCents(revenueChart.totals.incomeCents)}</b>{splitRows([["抖音", "douyin", totalsSplit.douyinIncomeCents, true], ["百家号", "baijiahao", totalsSplit.baijiahaoIncomeCents, true], ["其他收入", "", totalsSplit.otherIncomeCents], ["未归类", "", totalsSplit.lumpIncomeCents]])}</div>
              <div className="cost-kpi"><span>总成本</span><b>{moneyCents(revenueChart.totals.costCents)}</b>{splitRows([["API 估算", "api", totalsSplit.apiCostCents, true], ["手动成本", "manual", totalsSplit.manualCostCents, true], ["未归类", "", totalsSplit.lumpCostCents]])}</div>
              <div className={`cost-kpi cost-kpi-main${revenueChart.totals.netCents < 0 ? " finance-negative" : ""}`}><span>净利润</span><b>{moneyCents(revenueChart.totals.netCents)}</b><small>总收入 − 总成本</small></div>
              <div className="cost-kpi"><span>短剧总流量</span><b>{formatPlayCount(trafficTotals.totalPlays)}</b><small>抖音 {formatPlayCount(trafficTotals.douyinPlays)} ＋ 红果 {formatPlayCount(trafficTotals.hongguoPlays)}</small></div>
            </div>

            <div className="revenue-card" aria-label="收益曲线">
              <div className="revenue-head">
                <div>
                  <h3>收益曲线 <small>{chartRange === "all" ? "全部月份" : "近 12 个月"} · 截至 {todayMonth} · 点击柱子查看该月明细</small></h3>
                  <div className="revenue-legend"><span className="income">收入</span><span className="cost">成本（手动＋API 估算）</span><span className="net">{chartMode === "month" ? "净收益" : "累计净收益"}</span></div>
                </div>
                <div className="revenue-side">
                  <div className="cost-period-switch">{[["12", "近12个月"], ["all", "全部月份"]].map(([value, label]) => <button key={value} className={chartRange === value ? "active" : ""} onClick={() => setChartRange(value)}>{label}</button>)}</div>
                  <div className="cost-period-switch">{[["month", "按月"], ["cumulative", "累计"]].map(([value, label]) => <button key={value} className={chartMode === value ? "active" : ""} onClick={() => setChartMode(value)}>{label}</button>)}</div>
                </div>
              </div>
              <RevenueChart points={chartMode === "month" ? revenueChart.months : revenueChart.cumulative} selectedKey={financeMonth} onSelect={(month) => { setFinanceMonth(month); document.getElementById("cost-monthly-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} />
              {revenueChart.lump && <p className="revenue-note">总收入、总成本{chartMode === "cumulative" ? "和累计曲线" : ""}已包含未归类历史汇总：收入 {moneyCents(revenueChart.lump.incomeCents)}、成本 {moneyCents(revenueChart.lump.costCents)}（不属于任何月份）。</p>}
            </div>
          </section>

          <section className="cost-monthly" id="cost-monthly-detail" aria-label="月度明细">
            <div className="cost-section-head">
              <div><span className="cost-section-kicker">月度明细</span><h3>{Number(financeMonth.slice(0, 4))}年{Number(financeMonth.slice(5))}月 · {projectLabel}</h3></div>
              <div className="cost-section-tools">
                <label><span>月份</span><input aria-label="统计月份" type="month" value={financeMonth} onChange={(event) => setFinanceMonth(event.target.value)} /></label>
                {financeMonth !== todayMonth && <button className="cost-link-button" onClick={() => setFinanceMonth(todayMonth)}>回到本月</button>}
              </div>
            </div>
            <div className="cost-kpis">
              <div className={`cost-kpi cost-kpi-main${financeSummary.netCents < 0 ? " finance-negative" : ""}`}><span>本月净收益</span><b>{moneyCents(financeSummary.netCents)}</b><small>{financeScope}</small></div>
              <div className="cost-kpi"><span>本月收入</span><b>{moneyCents(financeSummary.incomeCents)}</b><small>抖音＋百家号</small></div>
              <div className="cost-kpi"><span>本月成本</span><b>{moneyCents(totalCostCents)}</b><small>手动成本＋API 估算</small></div>
              <div className="cost-kpi"><span>实际提交成功</span><b>{acceptedCount}<em>次</em></b><small>提交台账当前筛选</small></div>
            </div>
          </section>

          <div className="cost-tabs" role="tablist" aria-label="成本统计分区">
            {COST_TABS.map(([value, label]) => <button key={value} role="tab" aria-selected={activeTab === value} className={activeTab === value ? "active" : ""} onClick={() => setActiveTab(value)}>{label}</button>)}
            <div className="cost-module-toggles" aria-label="更多模块">{COST_MODULES.map(([key, label]) => <button key={key} aria-expanded={openModules.includes(key)} className={openModules.includes(key) ? "active" : ""} onClick={() => toggleModule(key)}>{label}<i aria-hidden="true">{openModules.includes(key) ? "▴" : "▾"}</i></button>)}</div>
          </div>

          {openModules.includes("submissions") && <section className="cost-module submission-section" aria-label="模型提交台账">
            <div className="cost-filterbar">
              <label><span>中转站</span><select aria-label="提交台账中转站" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}><option value="all">全部中转站</option>{providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
              <label className="cost-filter-grow"><span>模型</span><input aria-label="提交台账模型" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型名称" /></label>
              <div className="cost-date-range"><span>提交日期</span><div><input aria-label="提交开始日期" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /><i>至</i><input aria-label="提交结束日期" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /><button className="cost-link-button" onClick={() => { setFromDate(""); setToDate(""); }}>全部时间</button></div></div>
            </div>
            {fromDate && toDate && fromDate > toDate && <p className="cost-hint" role="alert">开始日期不能晚于结束日期</p>}

            <div className="cost-table-toolbar">
              <h3>模型提交台账 <small>当前范围实际提交成功 <b>{acceptedCount}</b> 次</small></h3>
              <div>
                {(hiddenColumnCount > 0 || showAllColumns) && <label className="cost-check"><input type="checkbox" checked={showAllColumns} onChange={(event) => setShowAllColumns(event.target.checked)} />显示全部列{hiddenColumnCount > 0 ? `（${hiddenColumnCount} 列全为 0 已隐藏）` : ""}</label>}
                <details className="cost-info cost-info-right"><summary>说明</summary><div>
                  <p>实际提交成功＝已取得中转任务 ID。同一 ID 只记一次，新 ID 的重试另记一次；失败不会抹掉受理记录。手动找回且尚未核实的 ID 不计入。</p>
                  <p>“同节追加”包含主动重做、抽卡和自动重试，不等于重复扣费证据。退款均待账单核实；未拿到 ID 的拒绝／待确认提交不计入已受理。日期按本机提交／恢复记录，状态为本机最后记录。台账从现存记录回填；过去已彻底删除的历史可能不完整。此后删除任务仍保留轻量受理台账。</p>
                </div></details>
                <button disabled={!acceptedCount} onClick={exportSubmissions}>导出{selectedGroup ? "当前模型" : "全部筛选"}受理明细</button>
              </div>
            </div>
            <div className="submission-table-scroll"><table className="submission-table"><thead><tr><th>中转站／模型</th>{visibleColumns.map((column) => <th className="num" key={column.key}>{column.label}</th>)}<th className="action">task ID</th></tr></thead><tbody>{submissionGroups.map((item) => (
              <tr key={item.key} className={selectedKey === item.key ? "selected" : ""}><td title={modelDisplayName(item)}><strong>{item.providerName}</strong><span>{modelDisplayName(item).split(" · ")[0]}</span>{modelDisplayName(item).split(" · ")[0] !== item.model && <code>{item.model}</code>}</td>{visibleColumns.map((column) => <td key={column.key} className={`num${Number(item[column.key]) === 0 ? " is-zero" : ""}`}>{column.always ? <b>{item[column.key]}</b> : item[column.key]}</td>)}<td className="action"><button onClick={() => { setSelectedKey(selectedKey === item.key ? "" : item.key); setDetailPage(1); }}>{selectedKey === item.key ? "收起" : "查看"}</button></td></tr>
            ))}</tbody></table></div>
            {!submissionGroups.length && <p className="cost-empty">当前范围没有可核对的任务 ID 记录。</p>}
            {selectedGroup && <div className="submission-details"><h4>{selectedGroup.model} · task ID 明细</h4><div className="submission-table-scroll"><table className="submission-table"><thead><tr><th>提交时间</th><th>task ID</th><th>项目／章节</th><th>状态</th><th>同节追加</th></tr></thead><tbody>{shownRecords.map((record) => <tr key={record.identity}><td>{record.createdAtMs ? new Date(record.createdAtMs).toLocaleString("zh-CN", { hour12: false }) : "时间未知"}</td><td><code>{record.taskId}</code></td><td>{record.projectName}<br />{record.batchTitle}{record.batchSection ? ` · 第${record.batchSection}节` : ""}</td><td>{record.cancelledByUser ? "手动取消" : ({ completed: "已生成", failed: "生成失败", queued: "排队中", processing: "生成中" }[record.status] || "状态未知")}</td><td>{record.additional ? "是" : "否"}</td></tr>)}</tbody></table></div><div className="cost-pager"><button disabled={currentDetailPage === 1} onClick={() => setDetailPage(currentDetailPage - 1)}>上一页</button><span>第 {currentDetailPage}/{detailPages} 页 · 共 {detailRecords.length} 个 ID</span><button disabled={currentDetailPage === detailPages} onClick={() => setDetailPage(currentDetailPage + 1)}>下一页</button></div></div>}
          </section>}
          {openModules.includes("favorites") && <section className="cost-module" aria-label="常用模型">
            <div className="cost-table-toolbar cost-module-head"><h3>常用模型 <small>点击即可切换中转站和模型</small></h3></div>
            <div className="favorite-models">{favorites.length ? favorites.map((item) => <button key={modelPriceKey(item.profileId, item.model)} disabled={!item.available} onClick={() => onSelectModel(item.profileId, item.model)}><strong>{item.providerName}</strong><span>{item.model}</span></button>) : <p>还没有常用模型，请在下方点击星标添加。</p>}</div>

          </section>}
          {openModules.includes("prices") && <section className="cost-module" aria-label="模型单价设置">
            <div className="cost-table-toolbar cost-module-head"><h3>模型单价设置 <small>按每个成功视频计算，设置自动保存在本机</small></h3><div><details className="cost-info cost-info-right"><summary>说明</summary><div><p>预计成本只按“已完成任务 × 你填写的单价”计算。如果某家中转失败也扣费，请以中转账单为准。</p></div></details></div></div>
            <div className="cost-filterbar">
              <label><span>中转站</span><select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}><option value="all">全部中转站</option>{providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
              <label className="cost-filter-grow"><span>模型</span><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型名称" /></label>
            </div>
            <div className="cost-model-list">
              {visibleModels.map((item) => {
                const key = modelPriceKey(item.profileId, item.model);
                const setting = settings[key] || {};
                return <div className="cost-model-row" key={key}><button className={`favorite-star${setting.favorite ? " active" : ""}`} title="设为常用模型" onClick={() => updateSetting(item.profileId, item.model, { favorite: !setting.favorite })}>★</button><strong>{item.providerName}</strong><code>{item.model}</code><label><span>每条</span><input type="number" min="0" step="0.01" value={setting.unitPrice ?? ""} onChange={(event) => updateSetting(item.profileId, item.model, { unitPrice: event.target.value })} placeholder="0.00" /><b>元</b></label></div>;
              })}
            </div>
          </section>}

          {activeTab === "finance" && <div className="cost-pane" role="tabpanel" aria-label="收支账本">
            <div className="cost-filterbar cost-filterbar-end">
              <details className="cost-info"><summary>说明</summary><div><p>每个月单独录入一次平台结算，不会自动沿用上月收入。抖音、百家号收入都需要每月分别录入。</p><p>API 估算成本＝已完成任务 × 模型单价；净收益＝收入 − 手动成本 − API 估算成本。</p></div></details>
            </div>

            <div className="finance-breakdown">
              <div><h4>收入构成</h4><dl><div><dt>抖音结算收入</dt><dd>{moneyCents(financeSummary.douyinIncomeCents)}</dd></div><div><dt>百家号结算收入</dt><dd>{moneyCents(financeSummary.baijiahaoIncomeCents)}</dd></div></dl></div>
              <div><h4>成本构成</h4><dl><div><dt title="会员费、素材费等">手动成本</dt><dd>{moneyCents(financeSummary.manualCostCents)}</dd></div><div><dt title="已完成任务 × 模型单价">API 估算成本</dt><dd>{moneyCents(financeSummary.apiCostCents)}</dd></div></dl></div>
            </div>
            {(financeSummary.unpricedTasks || financeSummary.undatedTasks) > 0 && <p className="cost-hint">当前统计仍有 {financeSummary.unpricedTasks ? `${financeSummary.unpricedTasks} 条已完成任务未填写模型单价` : ""}{financeSummary.unpricedTasks && financeSummary.undatedTasks ? "；" : ""}{financeSummary.undatedTasks ? `${financeSummary.undatedTasks} 条任务没有可用日期，未计入指定月份` : ""}。</p>}

            <h4 className="cost-subtitle">API 生成成本 <small>按已完成任务 × 模型单价估算；月度合计已含在上方收益曲线的成本里</small></h4>
            <div className="cost-period-cards">
              {[["今天", today], ["本周", week], ["本月", month]].map(([label, value]) => (
                <div className="cost-kpi" key={label}><span>{label}预计成本</span><b>{money(value.cost)}</b><small>已生成 {value.generated} 条 · 提交 {value.submitted} 条 · 失败 {value.failed} 条</small></div>
              ))}
            </div>

            <div className="cost-table-toolbar cost-trend-toolbar"><h3>生成与成本趋势</h3><div><div className="cost-chart-legend"><span className="generated">生成条数</span><span className="cost">预计成本</span></div><div className="cost-period-switch">{Object.entries(PERIODS).map(([value, config]) => <button className={period === value ? "active" : ""} key={value} onClick={() => setPeriod(value)}>{config.label}</button>)}</div></div></div>
            <CostTrendChart series={series} />


            {showLumpForm && <>
              <h4 className="cost-subtitle">未归类历史汇总 <small>一次性填写，不属于任何月份；计入累计收益和收益曲线的“累计”视图</small></h4>
              <form className="finance-entry-form lump-form" onSubmit={saveLumpSum}>
                <label><span>历史总收入（元）</span><input inputMode="decimal" value={lumpForm.income} onChange={(event) => setLumpForm((current) => ({ ...current, income: event.target.value }))} placeholder="0.00" /></label>
                <label><span>历史总成本（元）</span><input inputMode="decimal" value={lumpForm.cost} onChange={(event) => setLumpForm((current) => ({ ...current, cost: event.target.value }))} placeholder="0.00" /></label>
                <label className="finance-note-field"><span>备注</span><input value={lumpForm.note} onChange={(event) => setLumpForm((current) => ({ ...current, note: event.target.value }))} placeholder="例如：《卸货区不许司机喝水》等早期项目记录丢失，统一归到未归类" /></label>
                <div className="finance-entry-actions"><button className="primary-button" type="submit">保存历史汇总</button>{lumpSums[LUMP_SUM_PROJECT] && <button type="button" onClick={clearLumpSum}>清除</button>}</div>
              </form>
              {lumpError && <p className="task-project-error" role="alert">{lumpError}</p>}
              {lumpSums[LUMP_SUM_PROJECT] && <p className="cost-hint lump-saved">已保存：收入 {moneyCents(lumpSums[LUMP_SUM_PROJECT].incomeCents)} · 成本 {moneyCents(lumpSums[LUMP_SUM_PROJECT].costCents)} · 净额 {moneyCents(lumpSums[LUMP_SUM_PROJECT].incomeCents - lumpSums[LUMP_SUM_PROJECT].costCents)}</p>}
            </>}

            <section className={`finance-entry-card${financeEditingId ? " editing" : ""}`} aria-label="录入收入／成本">
              <div className="finance-entry-card-head"><h4>{financeEditingId ? "修改记录" : "录入收入／成本"}</h4><small>{financeEditingId ? "修改后点「保存修改」" : "抖音、百家号收入和手动成本每月分别录入"}</small></div>
              <form className="finance-entry-form finance-entry-big" onSubmit={submitFinanceEntry}>
                <div className="finance-entry-row-top">
                  <div className="finance-field"><span>类型</span><div className="finance-segment" role="radiogroup" aria-label="类型">{[["income", "收入"], ["cost", "成本"]].map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={financeForm.kind === value} className={`${value}${financeForm.kind === value ? " active" : ""}`} onClick={() => setFinanceForm((current) => ({ ...current, kind: value }))}>{label}</button>)}</div></div>
                  {financeForm.kind === "income" && <div className="finance-field"><span>收入来源</span><div className="finance-segment" role="radiogroup" aria-label="收入来源">{[["douyin", "抖音"], ["baijiahao", "百家号"]].map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={financeForm.incomeChannel === value} className={financeForm.incomeChannel === value ? "active" : ""} onClick={() => setFinanceForm((current) => ({ ...current, incomeChannel: value }))}>{label}</button>)}</div></div>}
                </div>
                <div className="finance-entry-grid">
                  <label><span>项目</span><select value={financeForm.projectName} onChange={(event) => setFinanceForm((current) => ({ ...current, projectName: event.target.value }))}>{projects.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
                  <label><span>月份</span><input type="month" required value={financeForm.month} onChange={(event) => setFinanceForm((current) => ({ ...current, month: event.target.value }))} /></label>
                  <label className="finance-title-field"><span>名称</span><input required value={financeForm.title} onChange={(event) => setFinanceForm((current) => ({ ...current, title: event.target.value }))} placeholder={financeForm.kind === "income" ? "例如：11月抖音结算" : "例如：GPT会员"} /></label>
                  <label className="finance-amount-field"><span>金额（元）</span><div className="finance-amount-input"><i>¥</i><input required inputMode="decimal" value={financeForm.amount} onChange={(event) => setFinanceForm((current) => ({ ...current, amount: event.target.value }))} placeholder="0.00" /></div></label>
                  <label className="finance-note-field"><span>备注</span><input value={financeForm.note} onChange={(event) => setFinanceForm((current) => ({ ...current, note: event.target.value }))} placeholder="可选，例如结算周期、用途" /></label>
                </div>
                <div className="finance-entry-actions">{financeEditingId && <button type="button" className="finance-cancel-button" onClick={() => resetFinanceForm()}>取消编辑</button>}<button className="primary-button finance-submit-button" type="submit">{financeEditingId ? "保存修改" : financeForm.kind === "income" ? "＋ 添加收入记录" : "＋ 添加成本记录"}</button></div>
              </form>
            </section>
            {financeError && <p className="task-project-error" role="alert">{financeError}</p>}

            <h4 className="cost-subtitle">{financeMonth} 记录 <small>{visibleFinanceEntries.length} 条</small></h4>
            <div className="finance-entry-list">
              {visibleFinanceEntries.length ? visibleFinanceEntries.map((entry) => <div className="finance-entry-row" key={entry.id}><span className={entry.kind === "income" ? "finance-income" : "finance-cost"}>{entry.kind === "income" ? (entry.incomeChannel === "baijiahao" ? "百家号" : "抖音") : "成本"}</span><strong>{entry.title}</strong><small>{entry.projectName}{entry.note ? ` · ${entry.note}` : ""}</small><b>{entry.kind === "income" ? "+" : "−"}{moneyCents(entry.amountCents)}</b><button onClick={() => editFinanceEntry(entry)}>编辑</button><button className="danger-button" onClick={() => deleteFinanceEntry(entry)}>删除</button></div>) : <p className="cost-empty">本月还没有手动收入或成本记录。抖音、百家号收入都需要每月分别录入。</p>}
            </div>
          </div>}

          {activeTab === "drama" && <DramaTrafficPanel projects={projects} projectFilter={projectFilter} defaultMonth={financeMonth} onDataChange={(server, rows) => { if (server) setTrafficServer(server); setHongguoRows(rows); }} />}

        </>}
      </section>
    </div>
  );
}
