import React, { useEffect, useMemo, useRef, useState } from "react";

import { readCredentials, saveCredentials } from "./credentialStore.js";
import {
  CANSEEDREAM_IMAGE_SIZE_LABELS,
  IMAGE_PROVIDER_PROFILES,
  QIQI_IMAGE_SIZE_LABELS,
  imageModelCapability,
  imageModelLabel,
  imageModelsFor,
} from "./imageCatalog.js";
import { completedImageReferenceIds, imageDownloadFilename, imagePromptWithFixedContent, imageTaskEntries } from "./imageBatch.js";
import { parseImagePromptJson, imageJsonGenerationItem, completedImagePromptIds } from "./imageJsonImport.js";
import { normalizedTaskProgress } from "./taskProgress.js";
import {
  IMAGE_DELETED_TASK_IDS_KEY,
  loadDeletedIds,
  rememberDeletedIds,
  withoutDeletedIds,
} from "./deletionStore.js";

import { IMAGE_ADAPTERS, imageProfileHeaders as profileHeaders, imageProviderRoutes, imageProviderSnapshot,
  imageTaskProvider, loadImageProviders, normalizeImageProvider, saveImageProviders } from "./imageProviderSettings.js";

import { fetchImageModelCatalog, imageModelScope, imageSelectableModels, readImageModelCatalogs,
  imageCatalogMatches, imageModelFingerprint, saveImageModelCatalog, imageModelCatalogStatus } from "./imageModelDiscovery.js";

const ACTIVE_PROVIDER_KEY = "image-workbench-active-provider-v1";
const MODELS_KEY = "image-workbench-models-v1";
const TASKS_KEY = "image-workbench-tasks-v1";
const FIXED_CONTENT_KEY = "image-workbench-fixed-content-v1";
const WORK_MODE_KEY = "image-workbench-mode-v1";
const JSON_PROMPTS_KEY = "image-workbench-json-prompts-v1";
const BATCH_IMAGE_LIMIT = 50;

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}

function statusLabel(status) {
  return { queued: "排队中", processing: "生成中", completed: "已完成", failed: "失败" }[status] || status;
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

export default function ImageWorkbench({ onVideoMode, onFaceMode, onTextMode, onLogout }) {
  const [providers, setProviders] = useState(loadImageProviders);
  const providersRef = useRef(providers);
  const [providerDraft, setProviderDraft] = useState(null);
  const [providerError, setProviderError] = useState("");
  const [providerDraftKey, setProviderDraftKey] = useState("");
  const [providerDraftRemember, setProviderDraftRemember] = useState(false);
  const [modelTesting, setModelTesting] = useState(false);
  const [modelTestStatus, setModelTestStatus] = useState("");
  const [imageCatalogs, setImageCatalogs] = useState({});
  const imageCatalogScopesRef = useRef({});
  const modelReadRevisionRef = useRef(0);
  const modelReadAbortRef = useRef(null);
  const modelReadScopeRef = useRef("");
  const [activeId, setActiveId] = useState(() => localStorage.getItem(ACTIVE_PROVIDER_KEY) || IMAGE_PROVIDER_PROFILES[0].id);
  const [models, setModels] = useState(() => loadJson(MODELS_KEY, {}));
  const activeProfile = providers.find((profile) => profile.id === activeId) || providers[0];
  const model = models[activeProfile.id] || activeProfile.model;
  const capability = imageModelCapability(activeProfile.adapter, model);
  const [apiKey, setApiKey] = useState(() => readCredentials(activeProfile.id).apiKey);
  const [rememberKey, setRememberKey] = useState(() => readCredentials(activeProfile.id).remember);
  const [workMode, setWorkMode] = useState(() => ["batch", "json"].includes(localStorage.getItem(WORK_MODE_KEY)) ? localStorage.getItem(WORK_MODE_KEY) : "single");
  const [jsonPrompts, setJsonPrompts] = useState(() => loadJson(JSON_PROMPTS_KEY, []));
  const [importingJson, setImportingJson] = useState(false);
  const [fixedContent, setFixedContent] = useState(() => localStorage.getItem(FIXED_CONTENT_KEY) || "");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [size, setSize] = useState("auto");
  const [quality, setQuality] = useState("auto");
  const [references, setReferences] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const deletedTaskIdsRef = useRef(new Set(loadDeletedIds(IMAGE_DELETED_TASK_IDS_KEY)));
  const [tasks, setTasks] = useState(() => withoutDeletedIds(loadJson(TASKS_KEY, []), [...deletedTaskIdsRef.current]));
  const tasksRef = useRef(tasks);
  const imagePollingRef = useRef(false);
  const imagePollCursorRef = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  const [downloadingBatchId, setDownloadingBatchId] = useState(null);
  const [notice, setNotice] = useState("");
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [expandedBatchId, setExpandedBatchId] = useState(null);
  const [imageBlob, setImageBlob] = useState(null);
  const referencesRef = useRef(references);
  const imageBlobRef = useRef(imageBlob);
  const fileInput = useRef(null);
  const jsonInput = useRef(null);
  modelReadScopeRef.current = JSON.stringify([activeProfile.id, imageModelScope(providerDraft, providerDraftKey)]);
  const activeCatalog = imageCatalogScopesRef.current[activeProfile.id] === imageModelScope(activeProfile, apiKey) ? imageCatalogs[activeProfile.id] : undefined;
  const draftCatalog = providerDraft && imageCatalogScopesRef.current[providerDraft.id] === imageModelScope(providerDraft, providerDraftKey) ? imageCatalogs[providerDraft.id] : undefined;
  const draftModelOptions = providerDraft ? imageSelectableModels(providerDraft, draftCatalog, providerDraft.model) : [];

  useEffect(() => {
    modelReadRevisionRef.current += 1;
    modelReadAbortRef.current?.abort();
    setModelTesting(false);
    setModelTestStatus("");
    return () => { modelReadRevisionRef.current += 1; modelReadAbortRef.current?.abort(); };
  }, [activeProfile.id, providerDraft?.id, providerDraft?.baseUrl, providerDraft?.adapter, providerDraftKey]);

  useEffect(() => {
    let cancelled = false;
    const scope = imageModelScope(activeProfile, apiKey);
    if (apiKey.trim()) imageModelFingerprint(apiKey).then((fingerprint) => {
      const entry = readImageModelCatalogs()[activeProfile.id];
      if (!cancelled && imageCatalogMatches(entry, activeProfile, fingerprint)) {
        imageCatalogScopesRef.current[activeProfile.id] = scope;
        setImageCatalogs((current) => ({ ...current, [activeProfile.id]: entry }));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeProfile.id, activeProfile.baseUrl, activeProfile.adapter, apiKey]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_PROVIDER_KEY, activeProfile.id);
    const credentials = readCredentials(activeProfile.id);
    setApiKey(credentials.apiKey);
    setRememberKey(credentials.remember);
  }, [activeProfile.id]);

  useEffect(() => {
    providersRef.current = providers;
    saveImageProviders(providers);
  }, [providers]);

  useEffect(() => {
    localStorage.setItem(MODELS_KEY, JSON.stringify(models));
  }, [models]);

  useEffect(() => { localStorage.setItem(WORK_MODE_KEY, workMode); }, [workMode]);
  useEffect(() => { localStorage.setItem(JSON_PROMPTS_KEY, JSON.stringify(jsonPrompts)); }, [jsonPrompts]);
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

  useEffect(() => {
    if (!apiKey.trim()) return undefined;
    let cancelled = false;
    fetch("/api/image-tasks/recent", {
      headers: profileHeaders(activeProfile, apiKey.trim(), model),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || "图片任务同步失败");
        return Array.isArray(body.tasks) ? body.tasks : [];
      })
      .then((recovered) => {
        if (cancelled || !recovered.length) return;
        setTasks((current) => {
          const known = new Set(current.map((task) => task.id));
          const missing = recovered
            .filter((task) => !deletedTaskIdsRef.current.has(String(task?.id || "")))
            .filter((task) => task?.id && !known.has(task.id))
            .map((task) => ({
              ...task,
              providerId: activeProfile.id,
              providerName: activeProfile.name,
              providerSnapshot: imageProviderSnapshot(activeProfile),
            }));
          return missing.length ? [...missing, ...current] : current;
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeProfile.id, activeProfile.baseUrl, activeProfile.adapter, apiKey, model]);

  useEffect(() => { referencesRef.current = references; }, [references]);
  useEffect(() => { imageBlobRef.current = imageBlob; }, [imageBlob]);
  useEffect(() => () => {
    for (const item of referencesRef.current) URL.revokeObjectURL(item.preview);
    if (imageBlobRef.current?.url) URL.revokeObjectURL(imageBlobRef.current.url);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function pollTasks() {
      if (imagePollingRef.current) return;
      imagePollingRef.current = true;
      try {
        const activeTasks = tasksRef.current.filter((task) => ["queued", "processing"].includes(task.status));
        if (!activeTasks.length) return;
        const start = imagePollCursorRef.current % activeTasks.length;
        const pending = Array.from({ length: Math.min(10, activeTasks.length) }, (_, index) => activeTasks[(start + index) % activeTasks.length]);
        imagePollCursorRef.current = (start + pending.length) % activeTasks.length;
        const updates = await Promise.all(pending.map(async (task) => {
          const profile = imageTaskProvider(task, providersRef.current);
          const key = profile ? readCredentials(profile.id).apiKey : "";
          if (!profile || !key) return null;
          try {
            const response = await fetch(`/api/image-tasks/${encodeURIComponent(task.id)}`, {
              signal: AbortSignal.timeout(60_000),
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
        const updatesById = new Map(updates.filter(Boolean).map((update) => [update.id, update]));
        if (!updatesById.size) return;
        setTasks((current) => current.map((task) => {
          const update = updatesById.get(task.id);
          return update ? { ...task, ...update } : task;
        }));
      } finally {
        imagePollingRef.current = false;
      }
    }
    pollTasks();
    const timer = window.setInterval(pollTasks, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const modelOptions = useMemo(() => imageSelectableModels(activeProfile, activeCatalog, model), [activeProfile, activeCatalog, model]);
  const referenceLimit = workMode === "batch" ? BATCH_IMAGE_LIMIT : capability.references;
  const completedReferenceIds = completedImageReferenceIds(references, tasks);
  const taskEntries = imageTaskEntries(tasks);
  const completedJsonIds = completedImagePromptIds(jsonPrompts, tasks, fixedContent);
  const completedJsonCount = jsonPrompts.filter((item) => completedJsonIds.has(item.id)).length;
  const jsonClearBlocked = submitting || importingJson || tasks.some((task) => ["queued", "processing"].includes(task.status));

  function editImageProvider(profile = activeProfile) {
    setProviderError("");
    setModelTestStatus("");
    setProviderDraftKey(apiKey);
    setProviderDraftRemember(rememberKey);
    setProviderDraft({ ...profile, model: models[profile.id] || profile.model });
  }

  function saveImageProvider() {
    if (submitting || !providerDraft) return;
    try {
      const saved = normalizeImageProvider(providerDraft);
      const next = providers.some((profile) => profile.id === saved.id)
        ? providers.map((profile) => profile.id === saved.id ? saved : profile) : [...providers, saved];
      saveImageProviders(next);
      providersRef.current = next;
      setProviders(next);
      setModels((current) => ({ ...current, [saved.id]: saved.model }));
      saveCredentials(saved.id, { apiKey: providerDraftKey, remember: providerDraftRemember });
      if (saved.id === activeProfile.id) { setApiKey(providerDraftKey); setRememberKey(providerDraftRemember); }
      setActiveId(saved.id);
      setProviderDraft(null);
      setNotice(`已保存 ${saved.name} 的图片中转配置；新任务使用新地址，已有任务保留提交时的地址`);
    } catch (error) { setProviderError(error.message || "图片中转配置保存失败"); }
  }

  async function testImageProvider() {
    if (!providerDraft || submitting) return;
    const revision = ++modelReadRevisionRef.current;
    const scope = modelReadScopeRef.current;
    modelReadAbortRef.current?.abort();
    const controller = new AbortController();
    modelReadAbortRef.current = controller;
    setModelTesting(true);
    setModelTestStatus("正在测试并读取图片模型目录…（不提交生成任务）");
    try {
      const prepared = normalizeImageProvider(providerDraft);
      const result = await fetchImageModelCatalog(prepared, providerDraftKey, { signal: controller.signal });
      if (revision !== modelReadRevisionRef.current || scope !== modelReadScopeRef.current) return;
      const catalog = saveImageModelCatalog(prepared, result.keyFingerprint, result);
      imageCatalogScopesRef.current[prepared.id] = imageModelScope(prepared, providerDraftKey);
      setImageCatalogs((current) => ({ ...current, [prepared.id]: catalog }));
      // Deliberately preserve the user's selected/manual model and unsaved configuration.
      setModelTestStatus(imageModelCatalogStatus(result, catalog.retained));
    } catch (error) {
      if (revision !== modelReadRevisionRef.current || scope !== modelReadScopeRef.current) return;
      const message = String(error?.message || "模型目录读取失败，原模型已保留");
      setModelTestStatus(providerDraftKey ? message.split(providerDraftKey).join("[已隐藏]") : message);
    } finally {
      if (revision === modelReadRevisionRef.current && scope === modelReadScopeRef.current) setModelTesting(false);
    }
  }

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

  async function importJsonFiles(files) {
    if (!files?.length) return;
    setImportingJson(true);
    try {
      const imported = [];
      for (const file of files) {
        imported.push(...parseImagePromptJson(await file.text(), file.name).map((item) => ({ ...item, id: crypto.randomUUID() })));
      }
      setJsonPrompts((current) => [...current, ...imported]);
      setNotice(`已导入 ${imported.length} 条角色/场景描述，每条提示词可单独修改；尚未提交生成`);
    } catch (error) {
      setNotice(error.message || "JSON 导入失败；原有列表已保留");
    } finally {
      setImportingJson(false);
    }
  }

  function updateJsonPrompt(id, changes) {
    setJsonPrompts((current) => current.map((item) => item.id === id ? { ...item, ...changes } : item));
  }

  function clearCompletedJsonPrompts() {
    setJsonPrompts((current) => current.filter((item) => !completedJsonIds.has(item.id)));
    setNotice(`已清空 ${completedJsonCount} 条已完成描述；固定内容和其它提示词均已保留`);
  }

  function clearAllJsonPrompts() {
    if (jsonClearBlocked || !jsonPrompts.length) return;
    if (!window.confirm(`确定清空全部 ${jsonPrompts.length} 条角色/场景描述吗？仅清空导入列表，不删除已生成图片、任务记录或固定内容。`)) return;
    const count = jsonPrompts.length;
    setJsonPrompts([]);
    setNotice(`已清空 ${count} 条导入描述；已生成图片、任务记录和固定内容均已保留`);
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
    if (!imageModelsFor(activeProfile.adapter).includes(model)) return setNotice("当前手动模型尚未适配所选图片协议；已保留模型名称，但不会尝试生成，请选择已适配模型");
    if (workMode === "json") {
      if (!jsonPrompts.length) return setNotice("请先导入角色/场景 JSON");
      const invalidIndex = jsonPrompts.findIndex((item) => !item.name.trim() || !item.prompt.trim());
      if (invalidIndex !== -1) return setNotice(`第 ${invalidIndex + 1} 条的名称和提示词不能为空`);
    } else if (!prompt.trim()) return setNotice("请填写图片提示词");
    if (workMode === "batch" && !references.length) return setNotice("请先添加需要批量处理的原图");
    if (workMode === "single" && references.length > capability.references) return setNotice(`当前图片模型最多参考 ${capability.references} 张图片`);
    setSubmitting(true);
    setNotice("");
    try {
      const batchId = workMode !== "single" ? `image-batch-${crypto.randomUUID()}` : null;
      const items = workMode === "json" ? jsonPrompts : workMode === "batch" ? references : [null];
      let submittedCount = 0;
      const results = await mapWithConcurrency(items, 3, async (source, index) => {
        const entry = workMode === "json" ? imageJsonGenerationItem(source, fixedContent) : {
          prompt: imagePromptWithFixedContent(fixedContent, prompt),
          title: source?.name || prompt.trim().slice(0, 24) || model,
          sourceName: source?.name || null,
          references: source ? [source] : references,
        };
        try {
          const form = new FormData();
          form.set("prompt", entry.prompt);
          form.set("aspectRatio", aspectRatio);
          form.set("size", size);
          form.set("quality", quality);
          form.set("title", entry.title);
          if (batchId) {
            form.set("batchId", batchId);
            form.set("batchIndex", String(index + 1));
          }
          if (entry.sourcePromptId) form.set("sourcePromptId", entry.sourcePromptId);
          if (entry.sourceName) form.set("sourceName", entry.sourceName);
          if (workMode === "batch" && source?.id) form.set("sourceReferenceId", source.id);
          for (const item of entry.references) form.append("references", item.file, item.name);
          const response = await fetch("/api/image-tasks", {
            method: "POST",
            headers: profileHeaders(activeProfile, apiKey.trim(), model),
            body: form,
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.message || "图片任务提交失败");
          const createdTasks = (body.tasks || []).map((task) => ({
            ...task,
            title: entry.title,
            sourceName: entry.sourceName,
            sourcePromptId: entry.sourcePromptId || null,
            batchId,
            batchIndex: source ? index + 1 : null,
            sourceReferenceId: workMode === "batch" ? source?.id || null : null,
            prompt: entry.prompt,
            model,
            providerId: activeProfile.id,
            providerName: activeProfile.name,
            providerSnapshot: imageProviderSnapshot(activeProfile),
          }));
          if (!createdTasks.length) throw new Error("中转未返回图片任务编号，请核对中转后台，勿重复提交");
          // Save each accepted task immediately, including long JSON batches.
          setTasks((current) => [...createdTasks, ...current]);
          submittedCount += 1;
          if (batchId) setNotice(`正在提交图片 ${submittedCount}/${items.length}；已接单任务会立即保存`);
          return createdTasks;
        } catch (error) {
          return { error: error.message || "图片任务提交失败", sourceName: source?.name || "单条任务" };
        }
      });
      const created = results.flatMap((result) => Array.isArray(result) ? result : []);
      const failures = results.filter((result) => !Array.isArray(result));
      if (!created.length) throw new Error(failures[0]?.error || "图片任务提交失败");
      setNotice(workMode !== "single"
        ? `批量图片已提交 ${created.length} 张${failures.length ? `，失败 ${failures.length} 张（${failures[0].sourceName}：${failures[0].error}）` : ""}；最多同时提交 3 张以避免中转限流`
        : `图片任务已提交：${activeProfile.name} · ${model}`);
    } catch (error) {
      setNotice(error.message || "图片任务提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function fetchImageBlob(task) {
    const profile = imageTaskProvider(task, providersRef.current);
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
    deletedTaskIdsRef.current.add(String(task.id));
    rememberDeletedIds(IMAGE_DELETED_TASK_IDS_KEY, [task.id]);
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
          <button className="secondary-button" onClick={onTextMode}>文本推理</button>
          <button className="secondary-button" onClick={onFaceMode}>明星脸初筛</button>
          <label><span>当前中转站</span><select value={activeProfile.id} onChange={(event) => { setProviderDraft(null); setActiveId(event.target.value); }}>{providers.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
          <span className={`connection-pill ${apiKey ? "ready" : ""}`}>{apiKey ? model : "等待图片 API 配置"}</span>
          <button className="logout-button" onClick={onLogout}>退出登录</button>
        </div>
      </header>

      <div className="workspace-grid">
        <section className="panel generation-panel">
          <div className="panel-heading"><h2>图片生成参数</h2><span className="idle-pill">● IMAGE</span></div>
          <div className="work-mode-switch" role="tablist" aria-label="图片工作模式">
            <button disabled={submitting} className={workMode === "single" ? "active" : ""} onClick={() => setWorkMode("single")}>单条生成</button>
            <button disabled={submitting} className={workMode === "batch" ? "active" : ""} onClick={() => setWorkMode("batch")}>原图批量处理</button>
            <button disabled={submitting} className={workMode === "json" ? "active" : ""} onClick={() => setWorkMode("json")}>角色/场景 JSON</button>
          </div>
          <div className="panel-body">
            <div className="image-provider-config">
              <label><span>图片模型</span><select value={model} onChange={(event) => changeModel(event.target.value)}>{modelOptions.map((item) => <option key={item} value={item}>{imageModelLabel(activeProfile.adapter, item)}{!imageModelsFor(activeProfile.adapter).includes(item) ? "（用途/适配未验证）" : ""}</option>)}</select></label>
              <label><span>手动填写模型（目录不可用时也可使用已适配模型）</span><input value={model} onChange={(event) => changeModel(event.target.value)} /></label>
              <label><span>图片 API Key</span><input type="password" value={apiKey} placeholder={activeProfile.adapter === "canseedream" ? "sk_img_..." : "sk-..."} onChange={(event) => saveCurrentCredentials(event.target.value, rememberKey)} /></label>
              <label className="remember-key-row"><input type="checkbox" checked={rememberKey} onChange={(event) => saveCurrentCredentials(apiKey, event.target.checked)} /><span>在这台浏览器记住图片 Key</span></label>
            </div>

            <div className="image-relay-actions">
              <button disabled={submitting} onClick={() => editImageProvider()}>中转详细设置</button>
              <button disabled={submitting} onClick={() => editImageProvider({ ...IMAGE_PROVIDER_PROFILES[0], id: `image-custom-${crypto.randomUUID()}`, name: "新图片中转" })}>＋ 添加兼容中转</button>
              <small>当前接口：{activeProfile.baseUrl}</small>
            </div>
            {providerDraft && <section className="image-relay-settings" aria-label="图片中转详细设置">
              <h3>图片中转详细设置</h3>
              <label><span>中转名称</span><input disabled={submitting} value={providerDraft.name} onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })} /></label>
              <label><span>Base URL（HTTPS 接口域名）</span><input disabled={submitting} type="url" value={providerDraft.baseUrl} onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })} placeholder="https://api.example.com" /></label>
              <label><span>图片接口协议</span><select disabled={submitting} value={providerDraft.adapter} onChange={(event) => setProviderDraft({ ...providerDraft, adapter: event.target.value, model: imageModelsFor(event.target.value)[0] })}>{IMAGE_ADAPTERS.map((adapter) => <option key={adapter} value={adapter}>{({ fmgo: "FMGO / 飞猫兼容", canseedream: "CanSeeDream 兼容", qiqi: "QIQI / Pidoi 兼容" })[adapter]}</option>)}</select></label>
              <label><span>测试/保存用图片 API Key（未保存前不修改原 Key）</span><input disabled={submitting} type="password" autoComplete="off" value={providerDraftKey} onChange={(event) => setProviderDraftKey(event.target.value)} placeholder="填写当前图片中转 Key" /></label>
              <label className="remember-key-row"><input type="checkbox" checked={providerDraftRemember} onChange={(event) => setProviderDraftRemember(event.target.checked)} /><span>保存时在本机记住此 Key</span></label>
              <label><span>默认图片模型</span><select disabled={submitting} value={providerDraft.model} onChange={(event) => setProviderDraft({ ...providerDraft, model: event.target.value })}>{draftModelOptions.map((item) => <option key={item} value={item}>{imageModelLabel(providerDraft.adapter, item)}{!imageModelsFor(providerDraft.adapter).includes(item) ? "（用途/适配未验证）" : ""}</option>)}</select></label>
              <label><span>手动模型名称（不会因读取目录而被替换）</span><input disabled={submitting} value={providerDraft.model} onChange={(event) => setProviderDraft({ ...providerDraft, model: event.target.value })} /></label>
              <p>目录可能包含文本/视频模型或未知型号，均保留显示但不会自动选用；未适配型号可保存，不能直接生成，以免使用错误协议。</p>
              <div className="image-relay-actions"><button disabled={submitting || modelTesting} onClick={testImageProvider}>{modelTesting ? "测试中…" : "测试并读取模型"}</button></div>
              {modelTestStatus && <p role="status" aria-live="polite">{modelTestStatus}</p>}
              <p>只保存接口域名（不含 /v1 路径）；请填写中转方提供的新地址，不是网页后台地址。已有 Key 的保存方式不变。</p>
              <p>{imageProviderRoutes(providerDraft.adapter, providerDraft.model)}</p>
              <p>路径由所选协议自动匹配，不支持任意自定义接口。已有任务仍按提交时地址查询/下载，不会重新生成。本次新增模型读取接口需空闲时重启本地服务一次；不会自动重启或中断任务。</p>
              {providerError && <p role="alert">{providerError}</p>}
              <div className="image-relay-actions"><button className="primary-button" disabled={submitting} onClick={saveImageProvider}>保存中转配置</button><button disabled={submitting} onClick={() => setProviderDraft(null)}>取消</button></div>
            </section>}

            <label className="field-label fixed-label" htmlFor="image-fixed-content">
              固定内容
              <span>每次图片请求自动追加在提示词最前方；只在手动修改时变化</span>
            </label>
            <textarea className="fixed-content" id="image-fixed-content" value={fixedContent} onChange={(event) => setFixedContent(event.target.value)} placeholder="例如：统一画风、人物一致性、构图和清晰度要求" />
            <div className="fixed-content-count">固定内容 {fixedContent.length} 字</div>

            {workMode === "json" ? <section className="image-json-prompts">
              <div className="section-heading"><div><h3>角色/场景批量提示词</h3><p>JSON 数组中每个 name + description 对应一条；原文导入，点击条目可编辑，下载以名称命名。</p></div><span>{jsonPrompts.length} 条</span></div>
              <div className="reference-toolbar">
                <button disabled={submitting || importingJson || !completedJsonCount} onClick={clearCompletedJsonPrompts}>清空已处理（{completedJsonCount}）</button>
                <button disabled={jsonClearBlocked || !jsonPrompts.length} title={jsonClearBlocked ? "请等待导入、提交及排队/生成任务结束后再清空" : "仅清空导入描述，保留已生成图片和固定内容"} onClick={clearAllJsonPrompts}>清空全部（{jsonPrompts.length}）</button>
                <button disabled={submitting || importingJson} onClick={() => jsonInput.current?.click()}>{importingJson ? "导入中…" : "＋ 导入角色/场景 JSON"}</button>
                <input ref={jsonInput} hidden multiple type="file" accept=".json,application/json" onChange={(event) => { importJsonFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
              </div>
              {!jsonPrompts.length && <div className="batch-filter-empty">可同时导入角色和场景文件。每条描述单独生成一张图片，不需要原图；已有固定内容会统一加在每条前面。</div>}
              <div className="image-json-list">
                {jsonPrompts.map((item, index) => <details className="image-json-row" key={item.id}>
                  <summary><strong>{index + 1}. {item.name}</strong><span>{completedJsonIds.has(item.id) ? "已生成 · " : ""}{item.prompt.length} 字</span></summary>
                  <div className="image-json-row-body">
                    <p className="upload-mode-note">来源：{item.sourceFile}{item.aliases ? ` · 别名：${item.aliases}` : ""}</p>
                    <label className="field-label" htmlFor={`image-json-name-${item.id}`}>名称 / 下载文件名</label>
                    <input id={`image-json-name-${item.id}`} disabled={submitting} value={item.name} onChange={(event) => updateJsonPrompt(item.id, { name: event.target.value })} />
                    <label className="field-label" htmlFor={`image-json-prompt-${item.id}`}>本条提示词</label>
                    <textarea id={`image-json-prompt-${item.id}`} disabled={submitting} value={item.prompt} onChange={(event) => updateJsonPrompt(item.id, { prompt: event.target.value })} />
                    <div className="image-json-row-actions"><span>固定内容在提交时自动加到前面</span><button disabled={submitting} onClick={() => setJsonPrompts((current) => current.filter((row) => row.id !== item.id))}>移除本条</button></div>
                  </div>
                </details>)}
              </div>
            </section> : <>
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
            </>}

            <div className="settings-grid image-settings-grid">
              {activeProfile.adapter === "fmgo"
                ? <label><span>画面比例</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>{capability.ratios.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                : capability.kind === "nano"
                  ? <><label><span>分辨率</span><select value={size} onChange={(event) => setSize(event.target.value)}>{capability.resolutions.map((value) => <option key={value} value={value}>{capability.resolutionLabels[value]}</option>)}</select></label><label><span>画面比例</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>{capability.ratios.map((value) => <option key={value} value={value}>{value}</option>)}</select></label></>
                  : <><label><span>图片尺寸</span><select value={size} onChange={(event) => setSize(event.target.value)}>{capability.sizes.map((value) => <option key={value} value={value}>{(activeProfile.adapter === "qiqi" ? QIQI_IMAGE_SIZE_LABELS : CANSEEDREAM_IMAGE_SIZE_LABELS)[value] || value}</option>)}</select></label><label><span>图片质量</span><select value={quality} onChange={(event) => setQuality(event.target.value)}>{capability.qualities.map((value) => <option key={value} value={value}>{{ auto: "自动", low: "低", medium: "中", high: "高" }[value] || value}</option>)}</select></label></>}
              <label><span>输出规格</span><input readOnly value={activeProfile.adapter === "fmgo" ? capability.imageSize : size} /></label>
            </div>
            {notice && <div className="notice">ⓘ {notice}</div>}
            {!imageModelsFor(activeProfile.adapter).includes(model) && <p role="status">当前模型尚未适配所选图片协议；名称已保留，但不会提交生成，请选择已适配的图片模型。</p>}
            <div className="submit-row"><button className="primary-button" disabled={submitting || importingJson || !imageModelsFor(activeProfile.adapter).includes(model)} onClick={submitImage}>{submitting ? "提交中…" : workMode === "json" ? `一键批量生成（${jsonPrompts.length}）` : workMode === "batch" ? `一键批量生成（${references.length}）` : "开始生成图片"}</button></div>
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
