import React, { useEffect, useMemo, useState } from "react";
import { allTasks } from "./taskStore.js";
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

export default function CostDashboard({ modelOptions, onClose, onSelectModel, profiles }) {
  const [tasks, setTasks] = useState([]);
  const [settings, setSettings] = useState(loadCostSettings);
  const [period, setPeriod] = useState("day");
  const [providerFilter, setProviderFilter] = useState("all");
  const [modelQuery, setModelQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    allTasks().then((values) => {
      if (!cancelled) setTasks(values);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

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
    && (!modelQuery.trim() || item.model.toLowerCase().includes(modelQuery.trim().toLowerCase()))
  )), [knownModels, providerFilter, modelQuery]);
  const favorites = knownModels.filter((item) => settings[modelPriceKey(item.profileId, item.model)]?.favorite);
  const series = costSeries(tasks, settings, period, PERIODS[period].count);
  const today = currentCostSummary(tasks, settings, "day");
  const week = currentCostSummary(tasks, settings, "week");
  const month = currentCostSummary(tasks, settings, "month");
  const maxGenerated = Math.max(1, ...series.map((item) => item.generated));
  const maxCost = Math.max(0.01, ...series.map((item) => item.cost));

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="cost-dialog" role="dialog" aria-label="成本统计" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading"><div><span>COST CENTER</span><h2>生成数量与成本统计</h2></div><button onClick={onClose}>×</button></div>
        {loading ? <div className="cost-loading">正在读取本机任务记录…</div> : <>
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
