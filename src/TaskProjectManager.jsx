import React, { useEffect, useMemo, useState } from "react";
import { allTasks, putTasks } from "./taskStore.js";
import {
  loadCostSettings,
  modelPriceKey,
  projectSuccessfulModels,
  saveCostSettings,
  taskEstimatedCost,
} from "./costAnalytics.js";
import { UNCLASSIFIED_PROJECT, tasksOnOrAfter } from "./taskProjects.js";

function money(value) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

function summarize(tasks, name, settings) {
  const matching = tasks.filter((task) => (task.projectName || UNCLASSIFIED_PROJECT) === name);
  return {
    total: matching.length,
    completed: matching.filter((task) => task.status === "completed").length,
    processing: matching.filter((task) => task.status === "queued" || task.status === "processing").length,
    failed: matching.filter((task) => task.status === "failed").length,
    cost: matching.reduce((total, task) => total + taskEstimatedCost(task, settings), 0),
  };
}

export default function TaskProjectManager({ activeProject, onClose, onCreate, onSelect, onTasksChanged, projects }) {
  const [tasks, setTasks] = useState([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [historyDate, setHistoryDate] = useState("");
  const [historyProject, setHistoryProject] = useState(activeProject);
  const [movingHistory, setMovingHistory] = useState(false);
  const [settings, setSettings] = useState(loadCostSettings);
  const [expandedModels, setExpandedModels] = useState([]);

  useEffect(() => {
    let cancelled = false;
    allTasks()
      .then((values) => { if (!cancelled) setTasks(values); })
      .catch((loadError) => { if (!cancelled) setError(loadError.message || "读取任务记录失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const names = useMemo(() => {
    const historical = tasks.map((task) => task.projectName || UNCLASSIFIED_PROJECT);
    return [...new Set([activeProject, ...projects, ...historical, UNCLASSIFIED_PROJECT].filter(Boolean))];
  }, [activeProject, projects, tasks]);
  const historyCutoff = historyDate
    ? (() => { const [year, month, day] = historyDate.split("-").map(Number); return new Date(year, month - 1, day).getTime(); })()
    : Number.NaN;
  const historyMatches = Number.isFinite(historyCutoff) ? tasksOnOrAfter(tasks, historyCutoff) : [];
  const historyChanges = historyMatches.filter((task) => (task.projectName || UNCLASSIFIED_PROJECT) !== historyProject);

  function createProject(event) {
    event.preventDefault();
    try {
      onCreate(name);
      setName("");
      setError("");
    } catch (createError) {
      setError(createError.message || "新建项目失败");
    }
  }

  async function moveHistory() {
    if (!historyDate) return setError("请选择开始日期");
    if (!historyProject) return setError("请选择目标项目");
    if (!historyChanges.length) return setError("这个日期范围内没有需要移动的任务");
    if (!window.confirm(`确定将 ${historyDate} 当天零点起的 ${historyMatches.length} 条任务全部归入“${historyProject}”吗？\n\n其中 ${historyChanges.length} 条会从原项目移出；任务不会复制，也不会重新提交。`)) return;
    setMovingHistory(true);
    setError("");
    try {
      const changedIds = new Set(historyChanges.map((task) => task.id));
      const changed = tasks.map((task) => changedIds.has(task.id) ? { ...task, projectName: historyProject } : task)
        .filter((task) => changedIds.has(task.id));
      await putTasks(changed);
      setTasks((current) => current.map((task) => changedIds.has(task.id) ? { ...task, projectName: historyProject } : task));
      onTasksChanged?.(changed.length, historyProject);
    } catch (moveError) {
      setError(moveError.message || "历史任务归类失败");
    } finally {
      setMovingHistory(false);
    }
  }

  function toggleModels(projectName) {
    setExpandedModels((current) => current.includes(projectName)
      ? current.filter((item) => item !== projectName)
      : [...current, projectName]);
  }

  function updatePrice(profileId, model, value) {
    const key = modelPriceKey(profileId, model);
    setSettings((current) => {
      const next = { ...current, [key]: { ...(current[key] || {}), unitPrice: value } };
      saveCostSettings(next);
      return next;
    });
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="task-project-dialog" role="dialog" aria-label="任务项目管理" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading"><div><span>PROJECTS</span><h2>任务项目管理</h2></div><button onClick={onClose}>×</button></div>
        <p className="task-project-intro">新建或切换项目后，之后的单条和批量视频任务都会归入当前项目。素材文件夹不会因此改变。</p>
        <form className="task-project-create" onSubmit={createProject}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="输入新剧本或项目名称" autoFocus />
          <button className="primary-button" type="submit">＋ 新建并使用</button>
        </form>
        {error && <p className="task-project-error">{error}</p>}
        <section className="task-project-history">
          <div><strong>按日期整理历史任务</strong><span>包含所选日期当天，从零点开始计算</span></div>
          <input aria-label="历史任务开始日期" type="date" value={historyDate} onChange={(event) => setHistoryDate(event.target.value)} />
          <select aria-label="历史任务目标项目" value={historyProject} onChange={(event) => setHistoryProject(event.target.value)}>{names.map((projectName) => <option key={projectName} value={projectName}>{projectName}</option>)}</select>
          <button className="secondary-button" disabled={!historyDate || !historyChanges.length || movingHistory} onClick={moveHistory}>{movingHistory ? "整理中…" : "归入目标项目"}</button>
          {historyDate && <p>日期范围内共 {historyMatches.length} 条，其中 {historyChanges.length} 条需要从原项目移动。</p>}
        </section>
        {loading ? <div className="cost-loading">正在读取项目任务…</div> : (
          <div className="task-project-list">
            {names.map((projectName) => {
              const summary = summarize(tasks, projectName, settings);
              const models = projectSuccessfulModels(tasks, settings, projectName);
              const active = projectName === activeProject;
              const expanded = expandedModels.includes(projectName);
              return (
                <article className={`task-project-row${active ? " active" : ""}`} key={projectName}>
                  <div><strong>{projectName}</strong>{active && <span>当前项目</span>}</div>
                  <p>共 {summary.total} 条 · 已生成 {summary.completed} · 生成中 {summary.processing} · 失败 {summary.failed}</p>
                  <b>预计成本 {money(summary.cost)}</b>
                  <div className="task-project-actions">
                    <button className="secondary-button" onClick={() => toggleModels(projectName)}>{expanded ? "收起模型明细" : `成功模型（${models.length}）`}</button>
                    <button className={active ? "secondary-button" : "primary-button"} disabled={active} onClick={() => onSelect(projectName)}>{active ? "正在使用" : "切换到此项目"}</button>
                  </div>
                  {expanded && <div className="task-project-models">
                    {models.length ? models.map((item) => (
                      <div className="task-project-model-row" key={item.key}>
                        <strong title={item.providerName}>{item.providerName}</strong>
                        <code title={item.model}>{item.model}</code>
                        <span>成功 {item.count} 条</span>
                        <label>
                          <span>每条</span>
                          <input aria-label={`${item.providerName} ${item.model} 每条金额`} type="number" min="0" step="0.01" value={settings[item.key]?.unitPrice ?? ""} onChange={(event) => updatePrice(item.profileId, item.model, event.target.value)} />
                          <b>元</b>
                        </label>
                        <b>小计 {money(item.subtotal)}</b>
                      </div>
                    )) : <p>这个项目还没有生成成功的模型。</p>}
                  </div>}
                </article>
              );
            })}
          </div>
        )}
        <p className="cost-footnote">预计成本只统计已生成任务。这里填写的模型单价会同步到“成本统计”，失败和生成中的任务不计费。</p>
      </section>
    </div>
  );
}
