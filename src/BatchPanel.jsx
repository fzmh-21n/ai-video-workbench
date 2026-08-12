import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  batchSerializable,
  canBatchMatch,
  canBatchSubmit,
  parseRecoveredTaskIds,
  runOrderedStaggered,
  splitBatchPrompts,
} from "./batchPrompts.js";
import { internalizeProjectAliases, planProjectReferences } from "./projectReferences.js";
import { allTasks, putTasks } from "./taskStore.js";
import { pollDelayForAdapter } from "./providerCatalog.js";
import { normalizedTaskProgress } from "./taskProgress.js";
import { diagnosticHeaders, recordDiagnostic } from "./diagnostics.js";

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
  submission_unknown: "结果待确认",
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
  onChooseProjectFolder,
  onRestoreProjectFolder,
  onTasksAdded,
  projectAssets,
  projectNeedsPermission,
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
  const [submissionMode, setSubmissionMode] = useState(restored?.submissionMode || "ordered_rush");
  const [allowMissingImages, setAllowMissingImages] = useState(false);
  const [uploaded, setUploaded] = useState(restored?.uploaded || {});
  const [uploadedProfileId, setUploadedProfileId] = useState(restored?.uploadedProfileId || "");
  const [busy, setBusy] = useState("");
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recoverText, setRecoverText] = useState("");
  const textInput = useRef(null);
  const recoveredBatchRef = useRef("");

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      items: batchSerializable(items),
      sourceName,
      concurrency,
      submissionMode,
      uploaded,
      uploadedProfileId,
    }));
  }, [items, sourceName, concurrency, submissionMode, uploaded, uploadedProfileId]);

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
    const hasTrackedTasks = items.some((item) => item.taskIds?.length && ["submitted", "generating", "submitting", "generation_failed"].includes(item.status));
    if (!hasTrackedTasks) return undefined;
    let cancelled = false;
    async function syncGeneratedStatuses() {
      try {
        const stored = await allTasks();
        if (cancelled) return;
        const byId = new Map(stored.map((task) => [task.id, task]));
        setItems((values) => values.map((item) => {
          if (!item.taskIds?.length || !["submitted", "generating", "submitting", "generation_failed"].includes(item.status)) return item;
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
  }, [items.some((item) => item.taskIds?.length && ["submitted", "generating", "submitting", "generation_failed"].includes(item.status))]);

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
    const importedAt = Date.now();
    const additions = parsed.map((item, index) => ({
      ...item,
      id: `${item.id}-${importedAt}-${index}`,
      sourceName: file.name,
      expanded: index === 0,
    }));
    setItems((current) => [...current, ...additions]);
    setSourceName(file.name);
    onNotice(`批量 TXT 已追加：新增 ${parsed.length} 节（第 ${parsed[0].section}–${parsed.at(-1).section} 节）；正在提交和生成中的章节保持不动`);
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
    const candidates = items.filter(canBatchMatch);
    if (!candidates.length) return onNotice("没有需要匹配的新章节；提交中、生成中和已生成章节已自动跳过");
    setBusy("matching");
    try {
      const matched = [];
      for (const item of candidates) matched.push(await matchItem(item));
      const byId = new Map(matched.map((item) => [item.id, item]));
      setItems((values) => values.map((item) => byId.get(item.id) || item));
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

  function removeItemReference(itemId, referenceId) {
    setItems((values) => values.map((item) => {
      if (item.id !== itemId) return item;
      const removed = (item.references || []).find((reference) => reference.id === referenceId);
      const references = reindex((item.references || []).filter((reference) => reference.id !== referenceId));
      let prompt = item.prompt;
      if (removed?.alias) {
        const escaped = removed.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        prompt = prompt.replace(new RegExp(`@${escaped}=${escaped}`, "g"), removed.alias);
      }
      return { ...item, prompt, references };
    }));
  }

  function resolveFile(reference) {
    if (reference.file) return reference.file;
    return projectAssets.find((asset) => asset.key === reference.projectAssetKey)?.file || null;
  }

  function uploadKey(item, reference) {
    return reference.projectAssetKey || `manual:${item.id}:${reference.id}`;
  }

  async function preuploadItems(targetItems, quiet = false) {
    const unique = new Map();
    const nextUploaded = uploadedProfileId === activeProfile.id ? { ...uploaded } : {};
    for (const item of targetItems) {
      for (const reference of item.references || []) {
        const key = uploadKey(item, reference);
        const file = resolveFile(reference);
        if (file && (!nextUploaded[key] || Number(nextUploaded[key].expiresAt) <= Date.now())) {
          unique.set(key, { item, reference, file });
        }
      }
    }
    if (!unique.size) {
      if (!quiet) onNotice("没有需要预上传的本地素材；可能尚未匹配，或全部已经预上传");
      return nextUploaded;
    }
    const entries = [...unique.entries()];
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
      const requestId = uid("material-upload");
      const startedAt = performance.now();
      recordDiagnostic({
        adapter: activeProfile.adapter,
        providerName: activeProfile.name,
        model: activeProfile.model,
        requestId,
        stage: "client_materials_upload_started",
        fileCount: chunk.length,
        totalBytes: chunk.reduce((total, [, value]) => total + Number(value.file?.size || 0), 0),
      });
      let response;
      try {
        response = await fetch("/api/materials", {
          method: "POST",
          headers: { ...headers, ...diagnosticHeaders({ requestId }) },
          body: form,
        });
      } catch (error) {
        recordDiagnostic({
          adapter: activeProfile.adapter,
          providerName: activeProfile.name,
          model: activeProfile.model,
          requestId,
          stage: "client_materials_upload_exception",
          durationMs: Math.round(performance.now() - startedAt),
          error: error.message || "素材预上传连接失败",
        });
        throw error;
      }
      const body = await response.json().catch(() => ({}));
      recordDiagnostic({
        adapter: activeProfile.adapter,
        providerName: activeProfile.name,
        model: activeProfile.model,
        requestId,
        stage: response.ok ? "client_materials_upload_completed" : "client_materials_upload_failed",
        durationMs: Math.round(performance.now() - startedAt),
        status: response.status,
        materialCount: body.materials?.length || 0,
        error: response.ok ? "" : body.message || "素材预上传失败",
      