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

const PERIODS = {
  day: { label: "每天", count: 14 },
  week: { label: "每周", count: 12 },
  month: { label: "每月", count: 12 },
};

function money(value) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

export default function CostDashboard({ activeProfileId, modelOptions, onClose, onSelectModel, profiles }) {
  const [tasks, setTasks] = useState([]);
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getSubmissionRecords().then((values) => {
      if (!cancelled) { setTasks(values); setLoadError(""); }
    }).catch((error) => {
      if (!cancelled) setLoadError(error.message || "提交台账读取失败，请重试");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
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
  const maxGenerated = Math.max(1, ...series.map((item) => item.generated));
  const maxCost = Math.max(0.01, ...series.map((item) => item.cost));
  const projects = useMemo(() => [...new Set(tasks.map((task) => task.projectName || "未归类"))]
    .sort((left, right) => left.localeCompare(right, "zh-CN")), [tasks]);
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
  function modelDisplayName(item) {
    return profiles.find((profile) => profile.id === item.profileId)?.routeLabels?.[item.model] || item.model;
  }

  async function exportSubmissions() {
    try {
      const records = selectedGroup ? detailRecords : submissionGroups.flatMap((item) => item.records);
      await downloadBlob(new Blob([submissionRecordsCsv(records)], { type: "text/csv;charset=utf-8" }), "模型提交台账.csv");
    } catch (error) {
      setLoadError(error.message || "导出提交台账失败");
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="cost-dialog" role="dialog" aria-label="成本统计" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading"><div><span>COST CENTER</span><h2>提交台账与成本统计</h2></div><button onClick={onClose}>×</button></div>
        {loadError && <p className="cost-footnote" role="alert">{loadError} <button onClick={() => setRefreshVersion((value) => value + 1)}>重新读取</button></p>}
        {loading ? <div className="cost-loading">正在读取本机任务记录…</div> : <>
          <section className="cost-section submission-section">
            <div className="cost-section-title"><h3>模型提交台账</h3><button onClick={() => setRefreshVersion((value) => value + 1)}>刷新统计</button></div>
            <p className="submission-explanation">实际提交成功＝已取得中转任务 ID。同一 ID 只记一次，新 ID 的重试另记一次；失败不会抹掉受理记录。手动找回且尚未核实的 ID 不计入。</p>
            <div className="cost-model-filters"><select aria-label="提交台账中转站" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}><option value="all">全部中转站</option>{providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><input aria-label="提交台账模型" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型名称" /></div>
            <div className="submission-filters"><label>任务项目<select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">全部项目</option>{projects.map((name) => <option key={name}>{name}</option>)}</select></label><label>提交开始日期<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label><label>提交结束日期<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label><button onClick={() => { setFromDate(""); setToDate(""); }}>全部时间</button></div>
            {fromDate && toDate && fromDate > toDate && <p role="alert">开始日期不能晚于结束日期</p>}
            <div className="cost-section-title"><strong>当前范围实际提交成功 {acceptedCount} 次</strong><button disabled={!acceptedCount} onClick={exportSubmissions}>导出{selectedGroup ? "当前模型" : "全部筛选"}受理明细</button></div>
            <div className="submission-table-scroll"><table className="submission-table"><thead><tr><th>中转站／模型</th><th>已受理</th><th>已生成</th><th>生成失败</th><th>处理中</th><th>手动取消</th><th>状态未知</th><th>同节追加</th><th>task ID</th></tr></thead><tbody>{submissionGroups.map((item) => (
              <tr key={item.key}><td title={modelDisplayName(item)}><strong>{item.providerName}</strong><span>{modelDisplayName(item).split(" · ")[0]}</span><code>{item.model}</code></td><td><b>{item.accepted}</b></td><td>{item.completed}</td><td>{item.failed}</td><td>{item.processing}</td><td>{item.cancelled}</td><td>{item.unknown}</td><td>{item.additional}</td><td><button onClick={() => { setSelectedKey(selectedKey === item.key ? "" : item.key); setDetailPage(1); }}>{selectedKey === item.key ? "收起" : "查看"}</button></td></tr>
            ))}</tbody></table></div>
            {!submissionGroups.length && <p>当前范围没有可核对的任务 ID 记录。</p>}
            {selectedGroup && <div className="submission-details"><h4>{selectedGroup.model} · task ID 明细</h4><div className="submission-table-scroll"><table className="submission-table"><thead><tr><th>提交时间</th><th>task ID</th><th>项目／章节</th><th>状态</th><th>同节追加</th></tr></thead><tbody>{shownRecords.map((record) => <tr key={record.identity}><td>{record.createdAtMs ? new Date(record.createdAtMs).toLocaleString("zh-CN", { hour12: false }) : "时间未知"}</td><td><code>{record.taskId}</code></td><td>{record.projectName}<br />{record.batchTitle}{record.batchSection ? ` · 第${record.batchSection}节` : ""}</td><td>{record.cancelledByUser ? "手动取消" : ({ completed: "已生成", failed: "生成失败", queued: "排队中", processing: "生成中" }[record.status] || "状态未知")}</td><td>{record.additional ? "是" : "否"}</td></tr>)}</tbody></table></div><div className="cost-section-title"><button disabled={currentDetailPage === 1} onClick={() => setDetailPage(currentDetailPage - 1)}>上一页</button><span>第 {currentDetailPage}/{detailPages} 页 · 共 {detailRecords.length} 个 ID</span><button disabled={currentDetailPage === detailPages} onClick={() => setDetailPage(currentDetailPage + 1)}>下一页</button></div></div>}
            <p className="submission-explanation">“同节追加”包含主动重做、抽卡和自动重试，不等于重复扣费证据。退款均待账单核实；未拿到 ID 的拒绝／待确认提交不计入已受理。日期按本机提交／恢复记录，状态为本机最后记录。台账从现存记录回填；过去已彻底删除的历史可能不完整。此后删除任务仍保留轻量受理台账。</p>
          </section>
          <div className="cost-summary-grid">
            {[["今天", today], ["本周", week], ["本月", month]].map(([label, value]) => (
              <div className="cost-summary-card" key={label}><strong>{label}</strong><b>{money(value.cost)}</b><span>已生成 {value.generated} 条 · 提交 {value.submitted} 条 · 失败 {value.failed} 条</span></div>
            ))}
          </div>

          <section className="cost-section">
            <div className="cost-section-title"><h3>成本趋势</h3><div className="cost-period-switch">{Object.entries(PERIODS).map(([value, config]) => <button className={period === value ? "active" : ""} key={value} onClick={() => setPeriod(value)}>{config.label}</button>)}</div></div>
            <div className="cost-chart-legend"><span className="generated">生成条数</span><span className="cost">预计成本</span></div>
            <div className="cost-chart">
              {series.map((item) => (
                <div className="cost-chart-row" key={item.key}>
                  <span>{item.label}</span>
                  <div><i className="generated" style={{ width: `${item.generated / maxGenerated * 100}%` }} /><em>{item.generated}条</em></div>
                  <div><i className="cost" style={{ width: `${item.cost / maxCost * 100}%` }} /><em>{money(item.cost)}</em></div>
                </div>
              ))}
            </div>
          </section>

          <section className="cost-section">
            <div className="cost-section-title"><h3>常用模型</h3><span>点击即可切换中转站和模型</span></div>
            <div className="favorite-models">{favorites.length ? favorites.map((item) => <button key={modelPriceKey(item.profileId, item.model)} disabled={!item.available} onClick={() => onSelectModel(item.profileId, item.model)}><strong>{item.providerName}</strong><span>{item.model}</span></button>) : <p>还没有常用模型，请在下方点击星标添加。</p>}</div>
          </section>

          <section className="cost-section">
            <div className="cost-section-title"><h3>模型单价设置</h3><span>按每个成功视频计算，设置自动保存在本机</span></div>
            <div className="cost-model-filters"><select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}><option value="all">全部中转站</option>{providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型名称" /></div>
            <div className="cost-model-list">
              {visibleModels.map((item) => {
                const key = modelPriceKey(item.profileId, item.model);
                const setting = settings[key] || {};
                return <div className="cost-model-row" key={key}><button className={`favorite-star${setting.favorite ? " active" : ""}`} title="设为常用模型" onClick={() => updateSetting(item.profileId, item.model, { favorite: !setting.favorite })}>★</button><strong>{item.providerName}</strong><code>{item.model}</code><label><span>每条</span><input type="number" min="0" step="0.01" value={setting.unitPrice ?? ""} onChange={(event) => updateSetting(item.profileId, item.model, { unitPrice: event.target.value })} placeholder="0.00" /><b>元</b></label></div>;
              })}
            </div>
          </section>
          <p className="cost-footnote">说明：预计成本只按“已完成任务 × 你填写的单价”计算。如果某家中转失败也扣费，请以中转账单为准。</p>
        </>}
      </section>
    </div>
  );
}
