import React, { useEffect, useMemo, useRef, useState } from "react";
import { batchSerializable, runWithConcurrency, splitBatchPrompts } from "./batchPrompts.js";
import { internalizeProjectAliases, planProjectReferences } from "./projectReferences.js";
import { allTasks, putTasks } from "./taskStore.js";
import { pollDelayForAdapter } from "./providerCatalog.js";
import { normalizedTaskProgress } from "./taskProgress.js";

const STORAGE_KEY = "video-workbench-batch-v1";
const CONCURRENCY_OPTIONS = [1, 2, 3, 5, 10, 20];
const KINDS = ["image", "audio", "video"];
const LABELS = { image: "图片", audio: "音频", video: "视频" };
const STATUS_LABELS = {
  pending: "待匹配",
  matched: "已匹配",
  submitting: "提交中",
  submitted: "生成中",
  generating: "生成中",
  generated: "已生成",
  failed: "提交失败",
  generation_failed: "生成失败",
};

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function reindex(items) {
  const counts = { image: 0, audio: 0, video: 0 };
  return items.map((item) => {
    counts[item.kind] += 1;
    const label = item.kind[0].toUpperCase() + item.kind.slice(1);
    return { ...item, tag: `@${label}${counts[item.kind]}` };
  });
}

function countsFor(references) {
  return references.reduce((counts, item) => ({ ...counts, [item.kind]: counts[item.kind] + 1 }), {
    image: 0,
    audio: 0,
    video: 0,
  });
}

function likelyAssetName(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^\d+[_-]/.test(text)) return true;
  return text.length <= 50 && !/[。！？；]/.test(text);
}

function persistedState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return parsed && Array.isArray(parsed.items) ? parsed : null;
  } catch {
    return null;
  }
}

export default function BatchPanel({
  activeProfile,
  apiKey,
  autoReference,
  capability,
  duration,
  fixedContent,
  headers,
  notice,
  onNotice,
  onProjectFolder,
  onTasksAdded,
  projectAssets,
  projectName,
  quantity,
  ratio,
  readMediaDuration,
  resolution,
  seed,
  setDuration,
  setFixedContent,
  setQuantity,
  setRatio,
  setResolution,
  setSeed,
  setSyncAudio,
  syncAudio,
}) {
  const restored = useMemo(persistedState, []);
  const [items, setItems] = useState(restored?.items || []);
  const [sourceName, setSourceName] = useState(restored?.sourceName || "");
  const [concurrency, setConcurrency] = useState(restored?.concurrency || 3);
  const [allowMissingImages, setAllowMissingImages] = useState(false);
  const [uploaded, setUploaded] = useState(restored?.uploaded || {});
  const [uploadedProfileId, setUploadedProfileId] = useState(restored?.uploadedProfileId || "");
  const [busy, setBusy] = useState("");
  const textInput = useRef(null);
  const recoveredBatchRef = useRef("");

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      items: batchSerializable(items),
      sourceName,
      concurrency,
      uploaded,
      uploadedProfileId,
    }));
  }, [items, sourceName, concurrency, uploaded, uploadedProfileId]);

  useEffect(() => {
    if (uploadedProfileId && uploadedProfileId !== activeProfile.id) {
      setUploaded({});
      setUploadedProfileId("");
    }
  }, [activeProfile.id]);

  useEffect(() => {
    const tracked = items.flatMap((item) => (item.taskIds || []).map((taskId, index) => ({
      taskId,
      section: item.section,
      order: Number(item.section) * 10 + index,
    })));
    if (!tracked.length) return undefined;
    const recoveryKey = tracked.map((item) => item.taskId).sort().join("|");
    if (recoveredBatchRef.current === recoveryKey) return undefined;
    recoveredBatchRef.current = recoveryKey;
    let cancelled = false;
    let finished = false;
    (async () => {
      try {
        const stored = await allTasks();
        if (cancelled) return;
        const byId = new Map(stored.map((task) => [task.id, task]));
        const ungrouped = tracked.filter((entry) => byId.get(entry.taskId) && !byId.get(entry.taskId).batchId);
        if (!ungrouped.length) {
          finished = true;
          return;
        }
        const batchId = `batch-recovered-${ungrouped[0].taskId}`;
        const batchTitle = sourceName ? sourceName.replace(/\.txt$/i, "") : "已归组批量任务";
        await putTasks(ungrouped.map((entry) => ({
          ...byId.get(entry.taskId),
          batchId,
          batchTitle,
          batchSection: entry.section,
          batchOrder: entry.order,
        })));
        finished = true;
        if (!cancelled) {
          onTasksAdded();
          onNotice(`已自动把本次 ${ungrouped.length} 条旧任务归入同一个批次`);
        }
      } catch {
        // 旧任务补归组失败时不影响生成与查询，稍后重新进入批量页可再次尝试。
        recoveredBatchRef.current = "";
      }
    })();
    return () => {
      cancelled = true;
      if (!finished && recoveredBatchRef.current === recoveryKey) recoveredBatchRef.current = "";
    };
  }, [items, sourceName]);

  useEffect(() => {
    const hasTrackedTasks = items.some((item) => item.taskIds?.length && ["submitted", "generating", "submitting"].includes(item.status));
    if (!hasTrackedTasks) return undefined;
    let cancelled = false;
    async function syncGeneratedStatuses() {
      try {
        const stored = await allTasks();
        if (cancelled) return;
        const byId = new Map(stored.map((task) => [task.id, task]));
        setItems((values) => values.map((item) => {
          if (!item.taskIds?.length || !["submitted", "generating", "submitting"].includes(item.status)) return item;
          const tracked = item.taskIds.map((id) => byId.get(id)).filter(Boolean);
          if (!tracked.length) return item;
          const progress = Math.round(tracked.reduce(
            (total, task) => total + normalizedTaskProgress(task.status, task.progress),
            0,
          ) / tracked.length);
          if (tracked.every((task) => task.status === "completed")) {
            return { ...item, status: "generated", progress: 100, error: "" };
          }
          if (tracked.every((task) => ["completed", "failed"].includes(task.status)) && tracked.some((task) => task.status === "failed")) {
            const failed = tracked.find((task) => task.status === "failed");
            return { ...item, status: "generation_failed", progress, error: failed?.error || failed?.message || "中转站返回生成失败" };
          }
          return { ...item, status: "generating", progress };
        }));
      } catch {
        // 任务列表暂时不可读时保留现有状态，下一轮继续同步。
      }
    }
    syncGeneratedStatuses();
    const interval = window.setInterval(syncGeneratedStatuses, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [items.some((item) => item.taskIds?.length && ["submitted", "generating", "submitting"].includes(item.status))]);

  const summary = useMemo(() => items.reduce((value, item) => {
    value[item.status] = (value[item.status] || 0) + 1;
    return value;
  }, {}), [items]);

  async function importText(file) {
    if (!file) return;
    const parsed = splitBatchPrompts(await file.text());
    if (!parsed.length) {
      onNotice("没有识别到“数字.（标题）”格式的章节，请检查 TXT 文件");
      return;
    }
    if (items.length && !window.confirm(`当前已有 ${items.length} 节批量内容，确定用新 TXT 替换吗？`)) return;
    setItems(parsed);
    setSourceName(file.name);
    setUploaded({});
    setUploadedProfileId("");
    onNotice(`批量 TXT 已导入：识别到 ${parsed.length} 节（第 ${parsed[0].section}–${parsed.at(-1).section} 节）`);
  }

  function clearBatch() {
    if (!items.length) return;
    if (!window.confirm(`确定清空当前批量内容吗？\n\n将清除 ${items.length} 节提示词、匹配结果、提交状态和预上传缓存。固定内容、公共参数、并发档位及项目文件夹会保留。`)) return;
    setItems([]);
    setSourceName("");
    setUploaded({});
    setUploadedProfileId("");
    if (textInput.current) textInput.current.value = "";
    onNotice("批量内容已清空，可以导入下一段 TXT；固定内容、公共参数和当前项目均已保留");
  }

  async function matchItem(item) {
    const plan = planProjectReferences(item.prompt, projectAssets);
    const automaticAssets = [...new Map(plan.matches.map((match) => [match.asset.key, match.asset])).values()];
    const durations = await Promise.all(automaticAssets.map((asset) => readMediaDuration(asset.file, asset.kind)));
    const durationByKey = new Map(automaticAssets.map((asset, index) => [asset.key, durations[index]]));
    const manual = (item.references || []).filter((reference) => reference.source === "manual");
    const automatic = automaticAssets.map((asset) => ({
      id: uid("batch-ref"),
      source: "automatic",
      projectAssetKey: asset.key,
      kind: asset.kind,
      name: asset.file.name,
      alias: asset.stem,
      durationSeconds: durationByKey.get(asset.key) || null,
      subType: "reference",
    }));
    return {
      ...item,
      prompt: plan.annotatedPrompt,
      references: reindex([...automatic, ...manual]),
      missingImages: plan.missing
        .filter((missing) => missing.kind === "image" && likelyAssetName(missing.requested))
        .map((missing) => missing.requested),
      status: "matched",
      error: "",
    };
  }

  async function matchOne(id) {
    if (!projectAssets.length) return onNotice("请先选择项目文件夹");
    setBusy(`match:${id}`);
    const current = items.find((item) => item.id === id);
    try {
      const matched = await matchItem(current);
      setItems((values) => values.map((item) => item.id === id ? matched : item));
      onNotice(`第 ${matched.section} 节匹配完成：${matched.references.length} 个素材`);
    } finally {
      setBusy("");
    }
  }

  async function matchAll() {
    if (!projectAssets.length) return onNotice("请先选择项目文件夹");
    if (!items.length) return onNotice("请先导入批量 TXT");
    setBusy("matching");
    try {
      const matched = [];
      for (const item of items) matched.push(await matchItem(item));
      setItems(matched);
      const refs = matched.reduce((total, item) => total + item.references.length, 0);
      onNotice(`全部一键参考完成：${matched.length} 节，共匹配 ${refs} 个素材；缺少音频已自动忽略`);
    } finally {
      setBusy("");
    }
  }

  async function addManualFiles(id, fileList) {
    const files = Array.from(fileList || []);
    const additions = [];
    for (const file of files) {
      const name = file.name.toLowerCase();
      const kind = file.type.startsWith("image/") ? "image"
        : file.type.startsWith("audio/") ? "audio"
          : file.type.startsWith("video/") || /\.(mov|mp4)$/.test(name) ? "video" : "";
      if (!kind) continue;
      additions.push({
        id: uid("manual-ref"), source: "manual", kind, file, name: file.name,
        durationSeconds: await readMediaDuration(file, kind), subType: "reference",
      });
    }
    setItems((values) => values.map((item) => item.id === id
      ? { ...item, references: reindex([...(item.references || []), ...additions]) }
      : item));
  }

  function resolveFile(reference) {
    if (reference.file) return reference.file;
    return projectAssets.find((asset) => asset.key === reference.projectAssetKey)?.file || null;
  }

  function uploadKey(item, reference) {
    return reference.projectAssetKey || `manual:${item.id}:${reference.id}`;
  }

  async function preuploadAll() {
    if (!apiKey) return onNotice("请先配置当前中转站的 API Key");
    const unique = new Map();
    for (const item of items) {
      for (const reference of item.references || []) {
        const key = uploadKey(item, reference);
        const file = resolveFile(reference);
        if (file && (!uploaded[key] || Number(uploaded[key].expiresAt) <= Date.now())) {
          unique.set(key, { item, reference, file });
        }
      }
    }
    if (!unique.size) return onNotice("没有需要预上传的本地素材；可能尚未匹配，或全部已经预上传");
    setBusy("uploading");
    try {
      const entries = [...unique.entries()];
      const nextUploaded = { ...uploaded };
      for (let offset = 0; offset < entries.length; offset += 50) {
        const chunk = entries.slice(offset, offset + 50);
        const form = new FormData();
        const meta = chunk.map(([key, value], fileIndex) => {
          form.append("references", value.file, value.file.name);
          return {
            projectAssetKey: key,
            tag: key,
            kind: value.reference.kind,
            name: value.reference.name,
            durationSeconds: value.reference.durationSeconds || null,
            fileIndex,
          };
        });
        form.set("referenceMeta", JSON.stringify(meta));
        const response = await fetch("/api/materials", { method: "POST", headers, body: form });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || "素材预上传失败");
        for (const material of body.materials || []) {
          nextUploaded[material.key] = { url: material.url, expiresAt: body.expiresAt };
        }
        onNotice(`正在预上传素材：${Math.min(offset + chunk.length, entries.length)}/${entries.length}`);
      }
      setUploaded(nextUploaded);
      setUploadedProfileId(activeProfile.id);
      onNotice(`预上传完成：${entries.length} 个唯一素材。相同素材在不同章节中会复用；建议50分钟内提交`);
    } catch (error) {
      onNotice(error.message || "预上传失败");
    } finally {
      setBusy("");
    }
  }

  function parametersFor(item) {
    const override = item.overrideEnabled ? item.overrides || {} : {};
    return {
      duration: override.duration ?? duration,
      resolution: override.resolution ?? resolution,
      ratio: override.ratio ?? ratio,
      seed: override.seed ?? seed,
      syncAudio: override.syncAudio ?? syncAudio,
      quantity: override.quantity ?? quantity,
    };
  }

  function issueFor(item) {
    const counts = countsFor(item.references || []);
    const exceeded = KINDS.filter((kind) => counts[kind] > (capability[`${kind}s`] || 0));
    if (exceeded.length) return exceeded.map((kind) => `${LABELS[kind]} ${counts[kind]}/${capability[`${kind}s`] || 0}`).join("、");
    if (item.missingImages?.length && !allowMissingImages) return `缺少图片：${item.missingImages.join("、")}`;
    return "";
  }

  async function submitOne(item, batchId) {
    const params = parametersFor(item);
    const references = reindex(item.references || []);
    const translated = internalizeProjectAliases(item.prompt.trim(), references);
    const submittedPrompt = [fixedContent.trim(), translated].filter(Boolean).join("\n\n");
    const form = new FormData();
    form.set("prompt", submittedPrompt);
    form.set("duration", String(params.duration));
    form.set("resolution", params.resolution);
    form.set("aspectRatio", params.ratio);
    form.set("seed", params.seed || "");
    form.set("quantity", String(params.quantity));
    form.set("syncAudio", String(params.syncAudio));
    form.set("autoReference", String(autoReference));
    let fileIndex = 0;
    const referenceMeta = references.map((reference) => {
      const cached = uploaded[uploadKey(item, reference)];
      const file = cached?.url ? null : resolveFile(reference);
      const meta = {
        tag: reference.tag,
        kind: reference.kind,
        name: reference.name,
        subType: reference.subType || "reference",
        durationSeconds: reference.durationSeconds || null,
        url: cached?.url || "",
        fileIndex: file ? fileIndex++ : null,
      };
      if (file) form.append("references", file, file.name);
      return meta;
    });
    form.set("referenceMeta", JSON.stringify(referenceMeta));
    const response = await fetch("/api/tasks", { method: "POST", headers, body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || "任务提交失败");
    const created = Array.isArray(body.tasks) ? body.tasks : [body];
    const createdAtMs = Date.now();
    const records = created.map((task, index) => ({
      ...task,
      profileId: activeProfile.id,
      providerName: activeProfile.name,
      model: activeProfile.model,
      title: `第${String(item.section).padStart(2, "0")}节-${activeProfile.model}${created.length > 1 ? `-${index + 1}` : ""}`,
      prompt: submittedPrompt,
      projectName: projectName || "未归类",
      batchId,
      batchTitle: sourceName ? sourceName.replace(/\.txt$/i, "") : `批量任务 ${new Date(createdAtMs).toLocaleString("zh-CN")}`,
      batchSection: item.section,
      batchOrder: Number(item.section) * 10 + index,
      createdAtMs: createdAtMs + index,
      nextPollAt: createdAtMs + pollDelayForAdapter(activeProfile.adapter),
    }));
    await putTasks(records);
    return records;
  }

  async function submitSelected(selectedItems, confirmAll = false) {
    if (!apiKey) return onNotice("请先配置当前中转站的 API Key");
    const candidates = selectedItems.filter((item) => !["submitted", "submitting", "generating", "generated"].includes(item.status));
    const blocked = candidates.filter(issueFor);
    const ready = candidates.filter((item) => !issueFor(item));
    if (!ready.length) return onNotice(blocked.length ? "没有可提交章节，请先处理标红问题" : "没有待提交章节");
    const totalTasks = ready.reduce((total, item) => total + Number(parametersFor(item).quantity || 1), 0);
    if (confirmAll && !window.confirm(`准备提交 ${ready.length} 节，共创建 ${totalTasks} 条任务。\n中转站：${activeProfile.name}\n模型：${activeProfile.model}\n同时提交：${concurrency} 节\n\n确认开始吗？`)) return;
    setBusy("submitting");
    setItems((values) => values.map((item) => ready.some((candidate) => candidate.id === item.id)
      ? { ...item, status: "submitting", error: "" }
      : item));
    let successes = 0;
    let failures = 0;
    const batchId = uid("batch");
    await runWithConcurrency(ready, concurrency, async (item) => {
      try {
        const records = await submitOne(item, batchId);
        successes += 1;
        setItems((values) => values.map((value) => value.id === item.id
          ? {
              ...value,
              status: records.every((record) => record.status === "completed") ? "generated" : "generating",
              progress: records.every((record) => record.status === "completed") ? 100 : Math.round(records.reduce(
                (total, record) => total + normalizedTaskProgress(record.status, record.progress),
                0,
              ) / records.length),
              error: "",
              taskIds: records.map((record) => record.id),
              expanded: false,
            }
          : value));
      } catch (error) {
        failures += 1;
        setItems((values) => values.map((value) => value.id === item.id
          ? { ...value, status: "failed", error: error.message || "提交失败", expanded: true }
          : value));
      }
    });
    setBusy("");
    onTasksAdded();
    onNotice(`批量提交完成：成功 ${successes} 节，失败 ${failures} 节${blocked.length ? `，另有 ${blocked.length} 节因缺图或素材超限未提交` : ""}`);
  }

  function updateItem(id, patch) {
    setItems((values) => values.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  const validUploaded = Object.values(uploaded).filter((value) => Number(value.expiresAt) > Date.now()).length;

  return (
    <div className="batch-panel">
      <div className="project-bar">
        <div><strong>{projectName ? `当前项目：${projectName}` : "当前未选择项目文件夹"}</strong><span>批量匹配只读取文件名；预上传或提交时才发送素材</span></div>
        <div>
          <label className="secondary-button file-button">选择项目文件夹<input type="file" multiple hidden webkitdirectory="" directory="" onChange={(event) => { onProjectFolder(event.target.files); event.target.value = ""; }} /></label>
          <button className="secondary-button" onClick={() => textInput.current?.click()}>导入批量 TXT</button>
          <button className="secondary-button batch-clear-button" disabled={!items.length || !!busy} onClick={clearBatch}>一键清空</button>
          <input ref={textInput} type="file" hidden accept="text/plain,.txt" onChange={(event) => { importText(event.target.files?.[0]); event.target.value = ""; }} />
        </div>
      </div>

      <label className="field-label fixed-label">固定内容<span>提交每一节时自动放在最前方</span></label>
      <textarea className="fixed-content" value={fixedContent} onChange={(event) => setFixedContent(event.target.value)} />

      <div className="batch-toolbar">
        <div><strong>{sourceName || "尚未导入 TXT"}</strong><span>{items.length} 节 · 已匹配 {summary.matched || 0} · 生成中 {(summary.generating || 0) + (summary.submitted || 0) + (summary.submitting || 0)} · 已生成 {summary.generated || 0} · 失败 {(summary.failed || 0) + (summary.generation_failed || 0)}</span></div>
        <button disabled={!!busy || !items.length} onClick={matchAll}>{busy === "matching" ? "匹配中…" : "全部一键参考"}</button>
        <button disabled={!!busy || !items.length} onClick={preuploadAll}>{busy === "uploading" ? "上传中…" : `预上传全部素材${validUploaded ? `（${validUploaded}）` : ""}`}</button>
        <label><span>同时提交</span><select value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>{CONCURRENCY_OPTIONS.map((value) => <option key={value} value={value}>{value} 条</option>)}</select></label>
        <button className="primary-button" disabled={!!busy || !items.length} onClick={() => submitSelected(items, true)}>{busy === "submitting" ? "批量提交中…" : "一键并发提交"}</button>
      </div>

      <div className="settings-grid batch-common-settings">
        <label><span>公共时长</span><select value={duration} onChange={(event) => setDuration(event.target.value === "auto" ? "auto" : Number(event.target.value))}>{capability.durations.map((value) => <option key={value} value={value}>{value === "auto" ? "自动" : `${value} 秒`}</option>)}</select></label>
        <label><span>公共清晰度</span><select value={resolution} onChange={(event) => setResolution(event.target.value)}>{capability.resolutions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>公共比例</span><select value={ratio} onChange={(event) => setRatio(event.target.value)}>{capability.ratios.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>生成数量</span><select value={quantity} onChange={(event) => setQuantity(Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>随机种子</span><input value={seed} onChange={(event) => setSeed(event.target.value)} disabled={!capability.seed} /></label>
      </div>
        <label className="check-row"><input type="checkbox" checked={syncAudio} disabled={capability.syncAudioFixed} onChange={(event) => setSyncAudio(event.target.checked)} />生成同步音频</label>
      <label className="check-row warning-check"><input type="checkbox" checked={allowMissingImages} onChange={(event) => setAllowMissingImages(event.target.checked)} />仍然提交缺少图片的章节</label>
      <div className="notice" role="status">ⓘ {onNotice && notice}</div>

      <div className="batch-list">
        {items.map((item) => {
          const counts = countsFor(item.references || []);
          const issue = issueFor(item);
          return (
            <article className={`batch-card ${issue ? "has-issue" : ""}`} key={item.id}>
              <button className="batch-card-head" onClick={() => updateItem(item.id, { expanded: !item.expanded })}>
                <strong>第{item.section}节｜{item.title}</strong>
                <span className="batch-card-summary">
                  <span>图{counts.image} · 音{counts.audio} · 视{counts.video}</span>
                  <span className={`batch-status batch-status-${item.status || "pending"}`}>{STATUS_LABELS[item.status] || "待匹配"}</span>
                </span>
              </button>
              {["submitted", "submitting", "generating"].includes(item.status) && (
                <div className="batch-item-progress">
                  <div className="progress-track"><span style={{ width: `${Number(item.progress) || 0}%` }} /></div>
                  <b>{Number(item.progress) || 0}%</b>
                </div>
              )}
              {issue && <div className="batch-issue">{issue}</div>}
              {item.error && <div className="batch-error">{item.error}</div>}
              {item.expanded && (
                <div className="batch-card-body">
                  <textarea value={item.prompt} onChange={(event) => updateItem(item.id, { prompt: event.target.value })} />
                  <div className="batch-reference-list">{(item.references || []).map((reference) => <span key={reference.id} className={reference.kind}>{reference.tag} {reference.name}{reference.source === "manual" ? "（手动）" : ""}</span>)}</div>
                  <div className="batch-card-actions">
                    <button disabled={!!busy} onClick={() => matchOne(item.id)}>本节一键参考</button>
                    <label className="secondary-button file-button">手动添加素材<input type="file" multiple hidden accept="image/*,audio/*,video/*,.mov,.mp4" onChange={(event) => { addManualFiles(item.id, event.target.files); event.target.value = ""; }} /></label>
                    <button disabled={!!busy || !!issue} onClick={() => submitSelected([item])}>开始生成本节</button>
                    <label className="override-toggle"><input type="checkbox" checked={item.overrideEnabled} onChange={(event) => updateItem(item.id, { overrideEnabled: event.target.checked })} />本节单独设置</label>
                  </div>
                  {item.overrideEnabled && (
                    <div className="batch-overrides">
                      <select value={item.overrides.duration ?? duration} onChange={(event) => updateItem(item.id, { overrides: { ...item.overrides, duration: Number(event.target.value) } })}>{capability.durations.filter((value) => typeof value === "number").map((value) => <option key={value}>{value}</option>)}</select>
                      <select value={item.overrides.resolution ?? resolution} onChange={(event) => updateItem(item.id, { overrides: { ...item.overrides, resolution: event.target.value } })}>{capability.resolutions.map((value) => <option key={value}>{value}</option>)}</select>
                      <select value={item.overrides.ratio ?? ratio} onChange={(event) => updateItem(item.id, { overrides: { ...item.overrides, ratio: event.target.value } })}>{capability.ratios.map((value) => <option key={value}>{value}</option>)}</select>
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
