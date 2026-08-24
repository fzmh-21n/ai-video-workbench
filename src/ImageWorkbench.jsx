import React, { useEffect, useMemo, useRef, useState } from "react";

import { readCredentials, saveCredentials } from "./credentialStore.js";
import {
  CANSEEDREAM_IMAGE_SIZE_LABELS,
  IMAGE_PROVIDER_PROFILES,
  imageModelCapability,
  imageModelLabel,
  imageModelsFor,
} from "./imageCatalog.js";
import { completedImageReferenceIds, imageDownloadFilename, imagePromptWithFixedContent, imageTaskEntries } from "./imageBatch.js";
import { normalizedTaskProgress } from "./taskProgress.js";

const ACTIVE_PROVIDER_KEY = "image-workbench-active-provider-v1";
const MODELS_KEY = "image-workbench-models-v1";
const TASKS_KEY = "image-workbench-tasks-v1";
const FIXED_CONTENT_KEY = "image-workbench-fixed-content-v1";
const WORK_MODE_KEY = "image-workbench-mode-v1";
const BATCH_IMAGE_LIMIT = 50;

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}

function statusLabel(status) {
  return { queued: "排队中", processing: "生成中", completed: "已完成", failed: "失败" }[status] || status;
}

function profileHeaders(profile, key, model) {
  return {
    "x-api-base-url": profile.baseUrl,
    "x-api-key": key,
    "x-api-model": encodeURIComponent(model),
    "x-api-adapter": profile.adapter,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export default function ImageWorkbench({ onVideoMode, onLogout }) {
  const [activeId, setActiveId] = useState(() => localStorage.getItem(ACTIVE_PROVIDER_KEY) || IMAGE_PROVIDER_PROFILES[0].id);
  const [models, setModels] = useState(() => loadJson(MODELS_KEY, {}));
  const activeProfile = IMAGE_PROVIDER_PROFILES.find((profile) => profile.id === activeId) || IMAGE_PROVIDER_PROFILES[0];
  const model = models[activeProfile.id] || activeProfile.model;
  const capability = imageModelCapability(activeProfile.adapter, model);
  const [apiKey, setApiKey] = useState(() => readCredentials(activeProfile.id).apiKey);
  const [rememberKey, setRememberKey] = useState(() => readCredentials(activeProfile.id).remember);
  const [workMode, setWorkMode] = useState(() => localStorage.getItem(WORK_MODE_KEY) === "batch" ? "batch" : "single");
  const [fixedContent, setFixedContent] = useState(() => localStorage.getItem(FIXED_CONTENT_KEY) || "");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [size, setSize] = useState("auto");
  const [quality, setQuality] = useState("auto");
  const [references, setReferences] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [tasks, setTasks] = useState(() => loadJson(TASKS_KEY, []));
  const tasksRef = useRef(tasks);
  const [submitting, setSubmitting] = useState(false);
  const [downloadingBatchId, setDownloadingBatchId] = useState(null);
  const [notice, setNotice] = useState("");
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [expandedBatchId, setExpandedBatchId] = useState(null);
  const [imageBlob, setImageBlob] = useState(null);
  const referencesRef = useRef(references);
  const imageBlobRef = useRef(imageBlob);
  const fileInput = useRef(null);

  useEffect(() => {
    localStorage.setItem(ACTIVE_PROVIDER_KEY, activeProfile.id);
    const credentials = readCredentials(activeProfile.id);
    setApiKey(credentials.apiKey);
    setRememberKey(credentials.remember);
  }, [activeProfile.id]);

  useEffect(() => {
    localStorage.setItem(MODELS_KEY, JSON.stringify(models));
  }, [models]);

  useEffect(() => { localStorage.setItem(WORK_MODE_KEY, workMode); }, [workMode]);
  useEffect(() => { localStorage.setItem(FIXED_CONTENT_KEY, fixedContent); }, [fixedContent]);

  useEffect(() => {
    if (activeProfile.adapter === "fmgo") {
      setAspectRatio((current) => capability.ratios.includes(current) ? current : "16:9");
    } else if (capability.kind === "nano") {
      setSize((current) => capability.resolutions.includes(current) ? current : capability.resolutions[0]);
      setAspectRatio((current) => capability.ratios.includes(current) ? current : capability.defaultRatio);
      setQuality("auto");
    } else {
      setSize((current) => capability.sizes.includes(current) ? current : "auto");
    }
  }, [activeProfile.adapter, model]);

  useEffect(() => {
    tasksRef.current = tasks;
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => { referencesRef.current = references; }, [references]);
  useEffect(() => { imageBlobRef.current = imageBlob; }, [imageBlob]);
  useEffect(() => () => {
    for (const item of referencesRef.current) URL.revokeObjectURL(item.preview);
    if (imageBlobRef.current?.url) URL.revokeObjectURL(imageBlobRef.current.url);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function pollTasks() {
      const activeTasks = tasksRef.current.filter((task) => ["queued", "processing"].includes(task.status));
      if (!activeTasks.length) return;
      const updates = await Promise.all(activeTasks.map(async (task) => {
        const profile = IMAGE_PROVIDER_PROFILES.find((item) => item.id === task.providerId);
        const key = profile ? readCredentials(profile.id).apiKey : "";
        if (!profile || !key) return null;
        try {
          const response = await fetch(`/api/image-tasks/${encodeURIComponent(task.id)}`, {
            headers: profileHeaders(profile, key, task.model),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.message || "查询图片任务失败");
          return { id: task.id, ...body };
        } catch (error) {
          return { id: task.id, pollError: error.message || "查询图片任务失败" };
        }
      }));
      if (cancelled) return;
      setTasks((current) => current.map((task) => {
        const update = updates.find((item) => item?.id === task.id);
        return update ? { ...task, ...update } : task;
      }));
    }
    pollTasks();
    const timer = window.setInterval(pollTasks, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const modelOptions = useMemo(() => imageModelsFor(activeProfile.adapter), [activeProfile.adapter]);
  const referenceLimit = workMode === "batch" ? BATCH_IMAGE_LIMIT : capability.references;
  const completedReferenceIds = completedImageReferenceIds(references, tasks);
  const taskEntries = imageTaskEntries(tasks);

  function saveCurrentCredentials(nextKey, nextRemember) {
    setApiKey(nextKey);
    setRememberKey(nextRemember);
    saveCredentials(activeProfile.id, { apiKey: nextKey, remember: nextRemember });
  }

  function addReferences(files) {
    const images = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
    const remaining = Math.max(0, referenceLimit - references.length);
    const accepted = images.slice(0, remaining).map((file) => ({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      preview: URL.createObjectURL(file),
    }));
    if (images.length > remaining) setNotice(workMode === "batch" ? `每批最多处理 ${BATCH_IMAGE_LIMIT} 张图片` : `当前图片模型最多参考 ${capability.references} 张图片`);
    setReferences((current) => [...current, ...accepted]);
  }

  function removeReference(id) {
    setReferences((current) => current.filter((item) => {
      if (item.id === id) URL.revokeObjectURL(item.preview);
      return item.id !== id;
    }));
  }

  function clearCompletedReferences() {
    if (!completedReferenceIds.size) return setNotice("当前没有已经生成完成、可以清空的原图");
    setReferences((current) => current.filter((item) => {
      if (completedReferenceIds.has(item.id)) URL.revokeObjectURL(item.preview);
      return !completedReferenceIds.has(item.id);
    }));
    setNotice(`已清空 ${completedReferenceIds.size} 张处理完成的原图；提示词和固定内容均已保留`);
  }

  function insertReference(index) {
    const tag = workMode === "batch" ? "@Image1" : `@Image${index + 1}`;
    setPrompt((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}${tag}`);
  }

  function changeModel(nextModel) {
    const nextCapability = imageModelCapability(activeProfile.adapter, nextModel);
    setModels((current) => ({ ...current, [activeProfile.id]: nextModel }));
    if (nextCapability.kind === "nano") {
      setSize(nextCapability.resolutions[0]);
      setAspectRatio(nextCapability.defaultRatio);
      setQuality("auto");
    } else if (activeProfile.adapter === "canseedream") {
      setSize("auto");
      setAspectRatio("1:1");
    }
  }

  function dropReferences(event) {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer.files?.length) addReferences(event.dataTransfer.files);
  }

  async function submitImage() {
    if (!apiKey.trim()) return setNotice("请先填写当前图片中转站的 API Key");
    if (!prompt.trim()) return setNotice("请填写图片提示词");
    if (workMode === "batch" && !references.length) return setNotice("请先添加需要批量处理的原图");
    if (workMode === "single" && references.length > capability.references) return setNotice(`当前图片模型最多参考 ${capability.references} 张图片`);
    setSubmitting(true);
    setNotice("");
    try {
      const submittedPrompt = imagePromptWithFixedContent(fixedContent, prompt);
      const batchId = workMode === "batch" ? `image-batch-${Date.now()}` : null;
      const items = workMode === "batch" ? references : [null];
      const results = await mapWithConcurrency(items, 3, async (source, index) => {
        try {
          const form = new FormData();
          form.set("prompt", submittedPrompt);
          form.set("aspectRatio", aspectRatio);
          form.set("size", size);
          form.set("quality", quality);
          const requestReferences = source ? [source] : references;
          for (const item of requestReferences) form.append("references", item.file, item.name);
          const response = await fetch("/api/image-tasks", {
            method: "POST",
            headers: profileHeaders(activeProfile, apiKey.trim(), model),
            body: form,
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.message || "图片任务提交失败");
          return (body.tasks || []).map((task) => ({
            ...task,
            title: source?.name || prompt.trim().slice(0, 24) || model,
            sourceName: source?.name || null,
            batchId,
            batchIndex: source ? index + 1 : null,
            sourceReferenceId: source?.id || null,
            prompt: submittedPrompt,
            model,
            providerId: activeProfile.id,
            providerName: activeProfile.name,
          }));
        } catch (error) {
          return { error: error.message || "图片任务提交失败", sourceName: source?.name || "单条任务" };
        }
      });
      const created = results.flatMap((result) => Array.isArray(result) ? result : []);
      const failures = results.filter((result) => !Array.isArray(result));
      if (created.length) setTasks((current) => [...created, ...current]);
      if (!created.length) throw new Error(failures[0]?.error || "图片任务提交失败");
      setNotice(workMode === "batch"
        ? `批量图片已提交 ${created.length} 张${failures.length ? `，失败 ${failures.length} 张` : ""}；最多同时提交 3 张以避免中转限流`
        : `图片任务已提交：${activeProfile.name} · ${model}`);
    } catch (error) {
      setNotice(error.message || "图片任务提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function fetchImageBlob(task) {
    const profile = IMAGE_PROVIDER_PROFILES.find((item) => item.id === task.providerId);
    const key = profile ? readCredentials(profile.id).apiKey : "";
    if (!profile || !key) throw new Error("请先填写该任务所属中转站的图片 API Key");
    const response = await fetch(task.imageUrl, { headers: profileHeaders(profile, key, task.model) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || "读取图片失败");
    }
    return response.blob();
  }

  async function loadImage(task) {
    try {
      const blob = await fetchImageBlob(task);
      if (imageBlob?.url) URL.revokeObjectURL(imageBlob.url);
      setImageBlob({ taskId: task.id, url: URL.createObjectURL(blob), type: blob.type || "image/png", blob });
    } catch (error) {
      setNotice(error.message || "读取图片失败");
    }
  }

  function triggerImageDownload(task, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = imageDownloadFilename(task, blob.type || "image/png");
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function downloadTaskImage(task) {
    try {
      const blob = imageBlob?.taskId === task.id && imageBlob.blob ? imageBlob.blob : await fetchImageBlob(task);
      triggerImageDownload(task, blob);
    } catch (error) {
      setNotice(error.message || "下载图片失败");
    }
  }

  async function downloadBatchImages(batchId, batchTasks) {
    const completed = batchTasks.filter((task) => task.status === "completed" && task.imageUrl);
    if (!completed.length) return setNotice("这一批目前没有可以下载的已完成图片");
    setDownloadingBatchId(batchId);
    let downloaded = 0;
    let unavailable = 0;
    try {
      for (const task of completed) {
        try {
          triggerImageDownload(task, await fetchImageBlob(task));
          downloaded += 1;
          await new Promise((resolve) => window.setTimeout(resolve, 150));
        } catch {
          unavailable += 1;
        }
        setNotice(`本批下载处理中：${downloaded + unavailable}/${completed.length} · 已下载 ${downloaded} · 不可用 ${unavailable}`);
      }
    } finally {
      setDownloadingBatchId(null);
    }
    setNotice(`本批下载完成：已开始下载 ${downloaded} 张${unavailable ? `，不可用 ${unavailable} 张` : ""}`);
  }

  function deleteTask(task) {
    if (imageBlob?.taskId === task.id) {
      URL.revokeObjectURL(imageBlob.url);
      setImageBlob(null);
    }
    setTasks((current) => current.filter((item) => item.id !== task.id));
  }

  function renderTaskCard(task, isBatchChild = false) {
    const expanded = expandedTaskId === task.id;
    const progress = normalizedTaskProgress(task.status, task.progress);
    return <article className={`task-card ${isBatchChild ? "batch-child-task" : ""} ${expanded ? "expanded" : ""}`} key={task.id} onClick={() => setExpandedTaskId(expanded ? null : task.id)}>
      <div className="task-topline"><code>#{task.title}</code><div><span className={`task-status ${task.status}`}>● {statusLabel(task.status)}</span><button className="delete-button" onClick={(event) => { event.stopPropagation(); deleteTask(task); }}>删除</button></div></div>
      <div className="progress-row"><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><b>{progress}%</b></div>
      <p>中转站：{task.providerName} · 模型：{task.model}</p>
      <p>创建：{task.createdAt || "—"}{task.completedAt ? ` · 完成：${task.completedAt}` : ""}</p>
      {task.error && <p className="task-error">错误：{task.error}</p>}
      {task.pollError && <p className="task-network-warning">查询提示：{task.pollError}</p>}
      {expanded && <div className="task-details" onClick={(event) => event.stopPropagation()}>
        {task.status === "completed" ? <>{imageBlob?.taskId === task.id ? <img className="image-result" src={imageBlob.url} alt="生成结果" /> : <button className="secondary-button" onClick={() => loadImage(task)}>加载图片</button>}<button className="download-button" onClick={() => downloadTaskImage(task)}>下载图片{task.sourceName ? `（${task.sourceName}）` : ""}</button></> : <p>{task.status === "failed" ? "该图片任务生成失败" : "图片生成完成后可在这里预览"}</p>}
        <details><summary>查看提示词</summary><pre>{task.prompt}</pre></details>
      </div>}
    </article>;
  }

  return (
    <main className="workspace-shell image-workbench">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">图</span>
          <div><h1>AI 图片生成工作台</h1><p>支持文生图和多参考图生成，图片顺序对应 @Image1、@Image2</p></div>
        </div>
        <div className="provider-switcher">
          <button className="secondary-button" onClick={onVideoMode}>视频生成</button>
          <label><span>当前中转站</span><select value={activeProfile.id} onChange={(event) => setActiveId(event.target.value)}>{IMAGE_PROVIDER_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
          <span className={`connection-pill ${apiKey ? "ready" : ""}`}>{apiKey ? model : "等待图片 API 配置"}</span>
          <button className="logout-button" onClick={onLogout}>退出登录</button>
        </div>
      </header>

      <div className="workspace-grid">
        <section className="panel generation-panel">
          <div className="panel-heading"><h2>图片生成参数</h2><span className="idle-pill">● IMAGE</span></div>
          <div className="work-mode-switch" role="tablist" aria-label="图片工作模式">
            <button className={workMode === "single" ? "active" : ""} onClick={() => setWorkMode("single")}>单条生成</button>
            <button className={workMode === "batch" ? "active" : ""} onClick={() => setWorkMode("batch")}>批量处理</button>
          </div>
          <div className="panel-body">
            <div className="image-provider-config">
              <label><span>图片模型</span><select value={model} onChange={(event) => changeModel(event.target.value)}>{modelOptions.map((item) => <option key={item} value={item}>{imageModelLabel(activeProfile.adapter, item)}</option>)}</select></label>
              <label><span>图片 API Key</span><input type="password" value={apiKey} placeholder={activeProfile.adapter === "canseedream" ? "sk_img_..." : "sk-..."} onChange={(event) => saveCurrentCredentials(event.target.value, rememberKey)} /></label>
              <label className="remember-key-row"><input type="checkbox" checked={rememberKey} onChange={(event) => saveCurrentCredentials(apiKey, event.target.checked)} /><span>在这台浏览器记住图片 Key</span></label>
            </div>

            <label className="field-label fixed-label" htmlFor="image-fixed-content">
              固定内容
              <span>每次图片请求自动追加在提示词最前方；只在手动修改时变化</span>
            </label>
            <textarea className="fixed-content" id="image-fixed-content" value={fixedContent} onChange={(event) => setFixedContent(event.target.value)} placeholder="例如：统一画风、人物一致性、构图和清晰度要求" />
            <div className="fixed-content-count">固定内容 {fixedContent.length} 字</div>

            <label className="field-label" htmlFor="image-prompt">图片提示词 Prompt</label>
            <textarea id="image-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={workMode === "batch" ? "每张原图都会作为该任务的 @Image1，填写共同处理要求" : "描述要生成的画面；有参考图时可使用 @Image1、@Image2"} />
            <div className="character-count">{prompt.length} 字</div>

            <div className="section-heading"><div><h3>{workMode === "batch" ? "待处理原图" : "参考图片"}</h3><p>{workMode === "batch" ? "每张原图分别创建一个任务，并在下载时保持原文件名" : "不上传为文生图；上传后按顺序作为参考图"}</p></div><span>{references.length}/{referenceLimit}</span></div>
            <div className="reference-toolbar">{workMode === "batch" && <button disabled={!completedReferenceIds.size} onClick={clearCompletedReferences}>清空已处理（{completedReferenceIds.size}）</button>}<button onClick={() => fileInput.current?.click()}>＋ {workMode === "batch" ? "添加待处理图片" : "添加参考图"}</button><input ref={fileInput} hidden multiple type="file" accept="image/*" onChange={(event) => { addReferences(event.target.files); event.target.value = ""; }} /></div>
            <div
              className={`reference-zone image-reference-zone ${dragActive ? "drag-active" : ""}`}
              onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragActive(true); }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false); }}
              onDrop={dropReferences}
            >
              {!references.length && <div className="empty-reference"><strong>{workMode === "batch" ? "把需要批量处理的原图拖到这里" : "把参考图片拖到这里"}</strong><span>也可以点击上方添加图片；支持 PNG、JPG、WebP 等常用图片格式</span></div>}
              {references.map((item, index) => <article className="reference-card" key={item.id}><button className="tag" onClick={() => insertReference(index)}>{workMode === "batch" ? "@Image1" : `@Image${index + 1}`}</button><button className="remove" onClick={() => removeReference(item.id)}>×</button><div className="reference-preview"><img src={item.preview} alt="" /></div><strong title={item.name}>{item.name}</strong></article>)}
            </div>

            <div className="settings-grid image-settings-grid">
              {activeProfile.adapter === "fmgo"
                ? <label><span>画面比例</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>{capability.ratios.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                : capability.kind === "nano"
                  ? <><label><span>分辨率</span><select value={size} onChange={(event) => setSize(event.target.value)}>{capability.resolutions.map((value) => <option key={value} value={value}>{capability.resolutionLabels[value]}</option>)}</select></label><label><span>画面比例</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>{capability.ratios.map((value) => <option key={value} value={value}>{value}</option>)}</select></label></>
                  : <><label><span>图片尺寸</span><select value={size} onChange={(event) => setSize(event.target.value)}>{capability.sizes.map((value) => <option key={value} value={value}>{CANSEEDREAM_IMAGE_SIZE_LABELS[value] || value}</option>)}</select></label><label><span>图片质量</span><select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="auto">正常</option><option value="medium">优秀</option></select></label></>}
              <label><span>输出规格</span><input readOnly value={activeProfile.adapter === "fmgo" ? capability.imageSize : size} /></label>
            </div>
            {notice && <div className="notice">ⓘ {notice}</div>}
            <div className="submit-row"><button className="primary-button" disabled={submitting} onClick={submitImage}>{submitting ? "提交中…" : workMode === "batch" ? `一键批量生成（${references.length}）` : "开始生成图片"}</button></div>
          </div>
        </section>

        <aside className="panel task-panel">
          <div className="panel-heading"><h2>我的图片任务</h2><span>{tasks.length} 条</span></div>
          <div className="task-list">
            {!tasks.length && <div className="empty-tasks"><span>图</span><h3>还没有图片任务</h3><p>生成记录只保存文字和任务编号，不保存图片文件。</p></div>}
            {taskEntries.map((entry) => {
              if (entry.type === "task") return renderTaskCard(entry.task);
              const expanded = expandedBatchId === entry.id;
              const completed = entry.tasks.filter((task) => task.status === "completed").length;
              const failed = entry.tasks.filter((task) => task.status === "failed").length;
              const active = entry.tasks.length - completed - failed;
              const downloadable = entry.tasks.filter((task) => task.status === "completed" && task.imageUrl).length;
              const progress = entry.tasks.length
                ? Math.round(entry.tasks.reduce((sum, task) => sum + normalizedTaskProgress(task.status, task.progress), 0) / entry.tasks.length)
                : 0;
              return <section className="batch-task-group" key={entry.id}>
                <div className="batch-task-group-head" onClick={() => setExpandedBatchId(expanded ? null : entry.id)}>
                  <div className="batch-task-group-summary"><strong>{expanded ? "▾" : "▸"} 批量图片任务 | {entry.tasks[0]?.createdAt || entry.id}</strong><span>共 {entry.tasks.length} 张 · 已完成 {completed} · 生成中 {active} · 失败 {failed}</span></div>
                  <div className="batch-task-actions"><button className="batch-download-button" disabled={!downloadable || downloadingBatchId === entry.id} onClick={(event) => { event.stopPropagation(); downloadBatchImages(entry.id, entry.tasks); }}>{downloadingBatchId === entry.id ? "下载中…" : `一键下载（${downloadable}）`}</button></div>
                </div>
                <div className="batch-group-progress"><div className="progress-row"><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><b>{progress}%</b></div></div>
                {expanded && <div className="batch-task-children">{entry.tasks.map((task) => renderTaskCard(task, true))}</div>}
              </section>;
            })}
          </div>
        </aside>
      </div>
    </main>
  );
}
