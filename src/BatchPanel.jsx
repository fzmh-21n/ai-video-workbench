import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  batchSerializable,
  batchItemChapterLabel,
  batchItemsForSource,
  batchSourceNames,
  batchStatusGroup,
  beginBatchSubmission,
  canBatchMatch,
  canBatchResubmit,
  canBatchSubmit,
  clearBatchReferences,
  deterministicBatchStopReason,
  failBatchSubmission,
  filterBatchItems,
  clearManualBatchCompletion,
  clearManualBatchDownload,
  manuallyCompleteBatchItem,
  overnightBatchReport,
  parseRecoveredTaskIds,
  providerBatchSubmissionPlan,
  reconciledBatchTerminalState,
  removeBatchReferenceKind,
  recoverInterruptedBatchItems,
  runOrderedStaggered,
  splitBatchPrompts,
} from "./batchPrompts.js";
import { internalizeProjectAliases, planProjectReferences } from "./projectReferences.js";
import { allTasks, putTasks } from "./taskStore.js";
import { taskReuseSnapshot } from "./taskReuse.js";
import { reviewedTask } from "./taskRegeneration.js";
import { pollDelayForAdapter } from "./providerCatalog.js";
import { normalizedTaskProgress } from "./taskProgress.js";
import { diagnosticHeaders, recordDiagnostic } from "./diagnostics.js";
import {
  configuredUploadBatchSize,
  materialUploadRetryDelay,
  retryableMaterialUploadStatus,
} from "./uploadPolicy.js";
import { batchItemDownloadCandidates, batchItemTasks, preferredBatchDownloadTasks } from "./taskDownload.js";

const STORAGE_KEY = "video-workbench-batch-v1";
const AWAY_STORAGE_KEY = "video-workbench-away-batch-v1";
const LEGACY_OVERNIGHT_STORAGE_KEY = "video-workbench-overnight-batch-v1";
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
  not_submitted: "未提交",
};
const MANUAL_UNUSABLE_ERROR = "当前成功视频已标记为不可用，可以重新生成本节";

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

function withDownloadedFlags(items, storedTasks) {
  const storedById = new Map((storedTasks || []).map((task) => [task.id, task]));
  return (items || []).map((item) => {
    const candidates = batchItemDownloadCandidates(item, storedTasks);
    const relatedTasks = (item.taskIds || []).map((id) => storedById.get(id)).filter(Boolean);
    const downloadedCount = item.manuallyMarkedDownloaded || candidates.some((task) => task.downloadedAtMs) ? 1 : 0;
    const terminalState = reconciledBatchTerminalState(item, relatedTasks, candidates.length > 0);
    return {
      ...item,
      ...(terminalState || {}),
      downloadedCount,
      downloaded: downloadedCount > 0,
    };
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
    return parsed && Array.isArray(parsed.items)
      ? { ...parsed, items: recoverInterruptedBatchItems(parsed.items) }
      : null;
  } catch {
    return null;
  }
}

function persistedOvernightPlan() {
  try {
    const value = JSON.parse(localStorage.getItem(AWAY_STORAGE_KEY) || localStorage.getItem(LEGACY_OVERNIGHT_STORAGE_KEY) || "null");
    return value && Array.isArray(value.itemIds) ? value : null;
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
  fixedContentVersionLabel,
  headers,
  notice,
  onNotice,
  onProjectFolder,
  onChooseProjectFolder,
  onDownloadTasks,
  onRestoreProjectFolder,
  onTasksAdded,
  projectAssets,
  projectNeedsPermission,
  projectName,
  taskProjectName,
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
  taskDatabaseReady,
  taskRefreshVersion,
}) {
  const restored = useMemo(persistedState, []);
  const [items, setItems] = useState(restored?.items || []);
  const [sourceName, setSourceName] = useState(restored?.sourceName || "");
  const [concurrency, setConcurrency] = useState(restored?.concurrency || 3);
  const [submissionMode, setSubmissionMode] = useState(restored?.submissionMode || "ordered_rush");
  const [allowMissingImages, setAllowMissingImages] = useState(false);
  const [uploaded, setUploaded] = useState(restored?.uploaded || {});
  const [uploadedProfileId, setUploadedProfileId] = useState(restored?.uploadedProfileId || "");
  const [overnightPlan, setOvernightPlan] = useState(persistedOvernightPlan);

  const [busy, setBusy] = useState("");
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recoverText, setRecoverText] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [finalDownloading, setFinalDownloading] = useState(false);
  const textInput = useRef(null);
  const recoveredBatchRef = useRef("");
  const slowNoticeBatchRef = useRef("");
  const uploadCredentialRef = useRef(apiKey);

  useEffect(() => {
    setItems((values) => recoverInterruptedBatchItems(values));
  }, []);

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
    localStorage.removeItem(LEGACY_OVERNIGHT_STORAGE_KEY);
    if (overnightPlan) localStorage.setItem(AWAY_STORAGE_KEY, JSON.stringify(overnightPlan));
    else localStorage.removeItem(AWAY_STORAGE_KEY);
  }, [overnightPlan]);

  useEffect(() => {
    const credentialChanged = uploadCredentialRef.current !== apiKey;
    uploadCredentialRef.current = apiKey;
    if (
      uploadedProfileId && (
        uploadedProfileId !== activeProfile.id ||
        credentialChanged ||
        activeProfile.adapter === "lwaigc"
      )
    ) {
      setUploaded({});
      setUploadedProfileId("");
    }
  }, [activeProfile.id, activeProfile.adapter, apiKey]);

  useEffect(() => {
    const tracked = items.flatMap((item) => (item.taskIds || []).map((taskId, index) => ({
      taskId,
      section: item.section,
      order: Number(item.section) * 10 + index,
      sourceName: item.sourceName,
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
        const recoveredBatchIds = new Map();
        await putTasks(ungrouped.map((entry) => ({
          ...byId.get(entry.taskId),
          batchId: (() => {
            const key = String(entry.sourceName || sourceName || "已归组批量任务");
            if (!recoveredBatchIds.has(key)) recoveredBatchIds.set(key, `batch-recovered-${entry.taskId}`);
            return recoveredBatchIds.get(key);
          })(),
          batchTitle: String(entry.sourceName || sourceName || "已归组批量任务").replace(/\.txt$/i, ""),
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
        const storedById = new Map(stored.map((task) => [task.id, task]));
        setItems((values) => values.map((item) => {
          if (!item.taskIds?.length || !["submitted", "generating", "submitting", "generation_failed"].includes(item.status)) return item;
          const tracked = item.taskIds.map((id) => storedById.get(id)).filter(Boolean);
          if (!tracked.length) return item;
          const progress = Math.round(tracked.reduce(
            (total, task) => total + normalizedTaskProgress(task.status, task.progress),
            0,
          ) / tracked.length);
          if (tracked.some((task) => task.status === "completed" && task.reviewStatus !== "dissatisfied")) {
            return { ...item, status: "generated", progress: 100, error: "" };
          }
          if (tracked.every((task) => task.status === "failed" || (task.status === "completed" && task.reviewStatus === "dissatisfied"))) {
            const failed = tracked.find((task) => task.status === "failed");
            const error = tracked.some((task) => task.reviewStatus === "dissatisfied")
              ? MANUAL_UNUSABLE_ERROR
              : failed?.error || failed?.message || "中转站返回生成失败";
            return { ...item, status: "generation_failed", progress, error };
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
  const statusGroupCounts = useMemo(() => items.reduce((value, item) => {
    const group = batchStatusGroup(item.status);
    value[group] = (value[group] || 0) + 1;
    return value;
  }, {}), [items]);
  const visibleItems = useMemo(() => filterBatchItems(items, statusFilter), [items, statusFilter]);
  const downloadedSections = items.filter((item) => item.downloaded).length;
  const pendingDownloadSections = Math.max(0, Number(summary.generated || 0) - downloadedSections);
  const finalDownloadAvailable = items.length > 0 && pendingDownloadSections > 0;
  const audioReferenceCount = items.reduce((total, item) => (
    total + (item.references || []).filter((reference) => reference.kind === "audio").length
  ), 0);
  const trackedDownloadKey = useMemo(() => items.flatMap((item) => item.taskIds || []).sort().join("|"), [items]);
  const overnightReport = useMemo(() => overnightBatchReport(items, overnightPlan), [items, overnightPlan]);
  const overnightItems = useMemo(() => {
    const ids = new Set(overnightPlan?.itemIds || []);
    return items.filter((item) => ids.has(item.id));
  }, [items, overnightPlan]);

  useEffect(() => {
    if (!taskDatabaseReady || !trackedDownloadKey) return undefined;
    let cancelled = false;
    allTasks().then((stored) => {
      if (!cancelled) setItems((values) => withDownloadedFlags(values, stored));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [taskDatabaseReady, taskRefreshVersion, trackedDownloadKey]);

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
    setOvernightPlan(null);
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
    const key = reference.projectAssetKey || `manual:${item.id}:${reference.id}`;
    return activeProfile.adapter === "unmau" ? `unmau-image-v1:${key}` : key;
  }

  function clearItemReferences(item) {
    const references = item.references || [];
    if (!references.length) return;
    if (!window.confirm(`确定清空${batchItemChapterLabel(item.sourceName) || "本章"}第${item.section}节的 ${references.length} 个参考素材吗？\n\n提示词、项目资产和生成记录不会删除；手动添加的素材需要重新选择才能恢复。`)) return;
    const removedKeys = new Set(references.map((reference) => uploadKey(item, reference)));
    const retainedKeys = new Set(items
      .filter((other) => other.id !== item.id)
      .flatMap((other) => (other.references || []).map((reference) => uploadKey(other, reference))));
    setUploaded((current) => Object.fromEntries(Object.entries(current).filter(
      ([key]) => !removedKeys.has(key) || retainedKeys.has(key),
    )));
    setItems((values) => values.map((value) => value.id === item.id ? clearBatchReferences(value) : value));
    onNotice(`${batchItemChapterLabel(item.sourceName) || "本章"}第${item.section}节已清空 ${references.length} 个参考素材；提示词和生成记录均已保留`);
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
    const chunkSize = configuredUploadBatchSize(activeProfile.adapter);
    let completedThisRun = 0;
    for (let offset = 0; offset < entries.length; offset += chunkSize) {
      const chunk = entries.slice(offset, offset + chunkSize);
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
      const maximumAttempts = 4;
      let response;
      let body = {};
      let connectionError;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        connectionError = null;
        try {
          response = await fetch("/api/materials", {
            method: "POST",
            headers: { ...headers, ...diagnosticHeaders({ requestId }) },
            body: form,
          });
          body = await response.json().catch(() => ({}));
        } catch (error) {
          connectionError = error;
          recordDiagnostic({
            adapter: activeProfile.adapter,
            providerName: activeProfile.name,
            model: activeProfile.model,
            requestId,
            stage: "client_materials_upload_exception",
            attempt,
            maximumAttempts,
            durationMs: Math.round(performance.now() - startedAt),
            error: error.message || "素材预上传连接失败",
          });
        }
        const shouldRetry = attempt < maximumAttempts
          && (connectionError || retryableMaterialUploadStatus(response?.status));
        if (!shouldRetry) break;
        onNotice(`素材预上传连接不稳定，正在重试 ${attempt}/${maximumAttempts - 1}；已完成的素材不会重复处理`);
        await new Promise((resolve) => setTimeout(resolve, materialUploadRetryDelay(attempt - 1)));
      }
      if (connectionError) {
        throw new Error(`素材预上传连接失败，自动重试 ${maximumAttempts - 1} 次后仍未恢复：${connectionError.message || "Failed to fetch"}`);
      }
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
      });
      if (!response?.ok) {
        setUploaded(nextUploaded);
        setUploadedProfileId(activeProfile.id);
        const progress = completedThisRun
          ? `；本次已成功并保留 ${completedThisRun}/${entries.length} 个素材，下次会从未完成处继续`
          : "";
        throw new Error(`${body.message || "素材预上传失败"}${progress}`);
      }
      for (const material of body.materials || []) {
        nextUploaded[material.key] = {
          url: material.url || "",
          assetId: material.assetId || "",
          expiresAt: body.expiresAt,
        };
      }
      completedThisRun += body.materials?.length || 0;
      // 紫域逐个上传确认；每成功一个就立即写入状态与本地缓存，中途限流也不丢进度。
      setUploaded({ ...nextUploaded });
      setUploadedProfileId(activeProfile.id);
      onNotice(`正在预上传素材：${completedThisRun}/${entries.length}${activeProfile.adapter === "ziyuai" ? "（紫域单通道，限流时会自动等待）" : ""}`);
    }
    setUploaded(nextUploaded);
    setUploadedProfileId(activeProfile.id);
    if (!quiet) onNotice(`预上传完成：${entries.length} 个唯一素材。相同素材在不同章节中会复用；建议50分钟内提交`);
    return nextUploaded;
  }

  async function preuploadAll() {
    if (!apiKey) return onNotice("请先配置当前中转站的 API Key");
    setBusy("uploading");
    try {
      await preuploadItems(items);
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

  async function submitOne(item, batchId, uploadCache, sequence, batchStartedAt) {
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
      const cached = uploadCache[uploadKey(item, reference)];
      const file = cached?.url || cached?.assetId ? null : resolveFile(reference);
      const meta = {
        tag: reference.tag,
        kind: reference.kind,
        name: reference.name,
        subType: reference.subType || "reference",
        durationSeconds: reference.durationSeconds || null,
        sizeBytes: file?.size || null,
        url: cached?.url || "",
        assetId: cached?.assetId || "",
        fileIndex: file ? fileIndex++ : null,
      };
      if (file) form.append("references", file, file.name);
      return meta;
    });
    form.set("referenceMeta", JSON.stringify(referenceMeta));
    const requestId = uid("task-submit");
    const startedAt = performance.now();
    recordDiagnostic({
      adapter: activeProfile.adapter,
      providerName: activeProfile.name,
      model: activeProfile.model,
      batchId,
      section: item.section,
      sequence,
      requestId,
      stage: "client_task_submit_started",
      localFileCount: fileIndex,
      referenceCount: references.length,
      submissionMode,
    });
    let response;
    const slowNoticeTimer = activeProfile.adapter === "meaicc"
      ? window.setTimeout(() => {
          recordDiagnostic({
            adapter: activeProfile.adapter,
            providerName: activeProfile.name,
            model: activeProfile.model,
            batchId,
            section: item.section,
            sequence,
            requestId,
            stage: "client_provider_ack_slow",
            elapsedMs: Math.round(performance.now() - startedAt),
          });
          if (slowNoticeBatchRef.current !== batchId) {
            slowNoticeBatchRef.current = batchId;
            onNotice("MEAICC 正在较慢地确认任务，任务可能已经进入中转。请等待工作台返回结果，不要重复点击提交。");
          }
        }, 8000)
      : null;
    try {
      response = await fetch("/api/tasks", {
        method: "POST",
        headers: {
          ...headers,
          ...diagnosticHeaders({ requestId, batchId, section: item.section, sequence }),
        },
        body: form,
      });
    } catch (error) {
      recordDiagnostic({
        adapter: activeProfile.adapter,
        providerName: activeProfile.name,
        model: activeProfile.model,
        batchId,
        section: item.section,
        sequence,
        requestId,
        stage: "client_task_submit_exception",
        durationMs: Math.round(performance.now() - startedAt),
        error: error.message || "任务提交连接失败",
      });
      throw error;
    } finally {
      if (slowNoticeTimer) window.clearTimeout(slowNoticeTimer);
    }
    const body = await response.json().catch(() => ({}));
    recordDiagnostic({
      adapter: activeProfile.adapter,
      providerName: activeProfile.name,
      model: activeProfile.model,
      batchId,
      section: item.section,
      sequence,
      requestId,
      stage: response.ok ? "client_task_submit_completed" : "client_task_submit_failed",
      durationMs: Math.round(performance.now() - startedAt),
      status: response.status,
      taskCount: body.tasks?.length || 0,
      submissionUnknown: Boolean(body.submissionUnknown || body.code === "SUBMISSION_UNKNOWN"),
      error: response.ok ? "" : body.message || "任务提交失败",
    });
    if (!response.ok) {
      const error = new Error(body.message || "任务提交失败");
      error.status = response.status;
      error.code = body.code || "";
      error.submissionUnknown = Boolean(body.submissionUnknown || body.code === "SUBMISSION_UNKNOWN");
      throw error;
    }
    const created = Array.isArray(body.tasks) ? body.tasks : [body];
    const createdAtMs = batchStartedAt + sequence;
    const records = created.map((task, index) => ({
      ...task,
      profileId: activeProfile.id,
      providerName: activeProfile.name,
      model: activeProfile.model,
      title: `第${String(item.section).padStart(2, "0")}节-${activeProfile.model}${created.length > 1 ? `-${index + 1}` : ""}`,
      prompt: submittedPrompt,
      reuseSnapshot: taskReuseSnapshot({
        prompt: item.prompt,
        references,
        duration: params.duration,
        resolution: params.resolution,
        ratio: params.ratio,
        seed: params.seed,
        quantity: params.quantity,
        syncAudio: params.syncAudio,
        autoReference,
      }),
      projectName: taskProjectName || "未归类",
      assetProjectName: projectName || "",
      batchId,
      batchTitle: item.sourceName
        ? item.sourceName.replace(/\.txt$/i, "")
        : sourceName ? sourceName.replace(/\.txt$/i, "") : `批量任务 ${new Date(createdAtMs).toLocaleString("zh-CN")}`,
      batchSection: item.section,
      batchOrder: Number(item.section) * 10 + index,
      createdAtMs: createdAtMs + index,
      submissionSequence: sequence,
      diagnosticRequestId: requestId,
      submitDurationMs: Math.round(performance.now() - startedAt),
      nextPollAt: Date.now() + pollDelayForAdapter(activeProfile.adapter),
    }));
    await putTasks(records);
    return records;
  }

  async function submitSelected(selectedItems, confirmAll = false, includeGenerated = false) {
    if (!apiKey) return onNotice("请先配置当前中转站的 API Key");
    const candidates = selectedItems.filter((item) => canBatchSubmit(item) || (includeGenerated && canBatchResubmit(item)));
    const blocked = candidates.filter(issueFor);
    const ready = candidates.filter((item) => !issueFor(item));
    if (!ready.length) return onNotice(blocked.length
      ? "没有可提交章节，请先处理标红问题"
      : includeGenerated
        ? "当前没有已生成、可以重新提交的章节"
        : "没有已匹配且待提交的新章节；提交中、生成中和已生成章节已自动跳过");
    const totalTasks = ready.reduce((total, item) => total + Number(parametersFor(item).quantity || 1), 0);
    const resubmittingCount = ready.filter(canBatchResubmit).length;
    const submissionPlan = providerBatchSubmissionPlan(activeProfile, submissionMode, concurrency);
    const effectiveConcurrency = submissionPlan.concurrency;
    const modeLabel = submissionPlan.providerLimited
      ? "飞猫 SS 稳定模式（每次1条、间隔5秒；每30条暂停5分钟）"
      : submissionMode === "strict_order"
      ? "严格顺序（上一节拿到任务ID后再提交下一节）"
      : submissionMode === "limited_rush"
        ? "限量抢占（50ms错峰、固定并发5；不保证中转后台顺序）"
        : "有序抢位（按章节号每350ms发出）";
    if (confirmAll && !window.confirm(`准备提交 ${ready.length} 节，共创建 ${totalTasks} 条任务。${resubmittingCount ? `\n其中 ${resubmittingCount} 节为重新生成，旧视频任务会保留。` : ""}\n中转站：${activeProfile.name}\n模型：${activeProfile.model}\n模式：${modeLabel}\n最大同时在途：${effectiveConcurrency} 节\n\n工作台会先自动预上传全部素材，再开始抢位。确认开始吗？`)) return;
    setBusy("uploading");
    onNotice("正在分批预上传素材；已成功的素材会立即保存，临时断线会自动重试");
    let uploadCache;
    try {
      uploadCache = await preuploadItems(ready, true);
    } catch (error) {
      setBusy("");
      onNotice(`自动预上传失败，尚未向中转站创建任务：${error.message || "未知错误"}`);
      return;
    }
    setBusy("submitting");
    setItems((values) => values.map((item) => ready.some((candidate) => candidate.id === item.id)
      ? beginBatchSubmission(item, activeProfile)
      : item));
    let successes = 0;
    let failures = 0;
    let firstFailureMessage = "";
    let stopReason = "";
    const startedItemIds = new Set();
    const batchId = uid("batch");
    const batchStartedAt = Date.now();
    setOvernightPlan((current) => {
      const sameProvider = current?.profileId === activeProfile.id;
      const itemIds = sameProvider ? [...current.itemIds] : [];
      const baselineTaskIds = sameProvider ? { ...(current.baselineTaskIds || {}) } : {};
      for (const item of ready) {
        if (!itemIds.includes(item.id)) itemIds.push(item.id);
        baselineTaskIds[item.id] = [...(item.taskIds || [])];
      }
      return {
        itemIds,
        baselineTaskIds,
        profileId: activeProfile.id,
        providerName: activeProfile.name,
        model: activeProfile.model,
        createdAt: sameProvider ? current.createdAt : batchStartedAt,
        updatedAt: batchStartedAt,
      };
    });
    recordDiagnostic({
      adapter: activeProfile.adapter,
      providerName: activeProfile.name,
      model: activeProfile.model,
      batchId,
      stage: "client_batch_started",
      chapterCount: ready.length,
      concurrency: effectiveConcurrency,
      submissionMode,
      providerLimited: Boolean(submissionPlan.providerLimited),
    });
    const dispatchResult = await runOrderedStaggered(ready, effectiveConcurrency, submissionPlan.staggerMs, async (item, sequence) => {
      startedItemIds.add(item.id);
      try {
        const records = await submitOne(item, batchId, uploadCache, sequence, batchStartedAt);
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
              manuallyMarkedGenerated: false,
              manuallyMarkedDownloaded: false,
              manualCompletionSnapshot: undefined,
            }
          : value));
      } catch (error) {
        failures += 1;
        if (!firstFailureMessage) firstFailureMessage = `${activeProfile.name} · ${activeProfile.model}：${error.message || "提交失败"}`;
        const deterministicReason = deterministicBatchStopReason(error);
        if (deterministicReason && !stopReason) {
          stopReason = deterministicReason;
          recordDiagnostic({
            adapter: activeProfile.adapter,
            providerName: activeProfile.name,
            model: activeProfile.model,
            batchId,
            section: item.section,
            sequence,
            stage: "client_batch_stop_requested",
            status: error.status || 0,
            reason: deterministicReason,
          });
        }
        setItems((values) => values.map((value) => value.id === item.id
          ? failBatchSubmission(value, error, activeProfile)
          : value));
      }
    }, {
      shouldStop: () => Boolean(stopReason),
      groupSize: submissionPlan.groupSize,
      cooldownMs: submissionPlan.cooldownMs,
      weightOf: (item) => Number(parametersFor(item).quantity || 1),
      onGroupCooldown: ({ completedGroups, submitted }) => {
        onNotice(`飞猫 SS 第 ${completedGroups} 轮已提交 ${submitted} 节，正在等待 5 分钟；等待结束后会自动继续下一轮，请不要重复点击。`);
      },
    });
    const skippedItems = ready.filter((item) => !startedItemIds.has(item.id));
    if (skippedItems.length) {
      const skippedIds = new Set(skippedItems.map((item) => item.id));
      setItems((values) => values.map((value) => skippedIds.has(value.id)
        ? {
            ...value,
            status: "not_submitted",
            error: `整批已停止，本节尚未提交：${stopReason}`,
            expanded: true,
          }
        : value));
    }
    recordDiagnostic({
      adapter: activeProfile.adapter,
      providerName: activeProfile.name,
      model: activeProfile.model,
      batchId,
      stage: "client_batch_completed",
      durationMs: Date.now() - batchStartedAt,
      successes,
      failures,
      skipped: dispatchResult.skipped,
      stopped: Boolean(stopReason),
      stopReason,
      submissionMode,
    });
    setBusy("");
    onTasksAdded();
    if (stopReason) {
      onNotice(`批量已安全停止：${stopReason}。成功 ${successes} 节，失败 ${failures} 节，剩余 ${skippedItems.length} 节未提交，可处理账号问题后继续。`);
    } else {
      onNotice(`批量提交完成：成功 ${successes} 节，失败 ${failures} 节${blocked.length ? `，另有 ${blocked.length} 节因缺图或素材超限未提交` : ""}${firstFailureMessage ? `；首个错误：${firstFailureMessage}` : ""}`);
    }
  }

  async function recoverMeaiccTasks() {
    const value = recoverText;
    if (!value?.trim()) return;
    const parsed = parseRecoveredTaskIds(value);
    if (!parsed.length) return onNotice("没有识别到 MEAICC 任务 ID（支持 wr_... 和 UUID）");
    const chapters = [...items].sort((a, b) => Number(a.section) - Number(b.section));
    let assignments = [];
    if (parsed.every((entry) => entry.section != null)) {
      assignments = parsed.map((entry) => ({
        ...entry,
        chapter: chapters.find((chapter) => Number(chapter.section) === entry.section),
      }));
      if (assignments.some((entry) => !entry.chapter)) {
        return onNotice("任务 ID 前标注的章节号在当前批量列表中不存在");
      }
    } else if (parsed.length === chapters.length) {
      assignments = parsed.map((entry, index) => ({ ...entry, chapter: chapters[index] }));
    } else {
      const unknown = chapters.filter((chapter) => chapter.status === "submission_unknown");
      if (parsed.length === 1 && unknown.length === 1) {
        assignments = [{ ...parsed[0], chapter: unknown[0] }];
      } else {
        return onNotice(`识别到 ${parsed.length} 个任务 ID。请使用“29=任务ID”的格式明确章节，避免挂错任务。`);
      }
    }
    const taskIds = assignments.map((entry) => entry.taskId);
    setBusy("recovering");
    try {
      const response = await fetch("/api/tasks/recover", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || "找回任务失败");
      const batchId = uid("recovered-batch");
      const createdAtMs = Date.now();
      const records = body.tasks.map((task, index) => ({
        ...task,
        profileId: activeProfile.id,
        providerName: activeProfile.name,
        model: activeProfile.model,
        title: `第${String(assignments[index].chapter.section).padStart(2, "0")}节-${activeProfile.model}`,
        prompt: assignments[index].chapter.prompt,
        projectName: taskProjectName || "未归类",
        assetProjectName: projectName || "",
        batchId,
        batchTitle: `${(sourceName || "批量任务").replace(/\.txt$/i, "")}（找回）`,
        batchSection: assignments[index].chapter.section,
        batchOrder: Number(assignments[index].chapter.section) * 10,
        createdAtMs: createdAtMs + index,
        nextPollAt: Date.now(),
      }));
      await putTasks(records);
      setItems((values) => values.map((item) => {
        const index = assignments.findIndex((assignment) => assignment.chapter.id === item.id);
        return index < 0 ? item : { ...item, status: "generating", progress: 0, error: "", taskIds: [records[index].id] };
      }));
      setRecoverOpen(false);
      setRecoverText("");
      onTasksAdded();
      onNotice(`已找回 ${records.length} 条 MEAICC 任务，正在按中转后台状态查询；没有重新提交。`);
    } catch (error) {
      onNotice(error.message || "找回任务失败");
    } finally {
      setBusy("");
    }
  }

  function updateItem(id, patch) {
    setItems((values) => values.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function markBatchItemGenerated(item) {
    if (!window.confirm(`确定把${batchItemChapterLabel(item.sourceName) || "本章"}第${item.section}节手动标记为生成成功吗？\n\n这只修正工作台记录，不会创建视频、视频地址或新任务。`)) return;
    setItems((values) => values.map((value) => value.id === item.id ? manuallyCompleteBatchItem(value) : value));
    onNotice(`${batchItemChapterLabel(item.sourceName) || "本章"}第${item.section}节已手动标记为生成成功`);
  }

  function markBatchItemDownloaded(item) {
    if (!window.confirm(`确定把${batchItemChapterLabel(item.sourceName) || "本章"}第${item.section}节手动标记为下载成功吗？\n\n这会同时视为生成成功，之后“下载新增成功”会跳过本节。`)) return;
    setItems((values) => values.map((value) => value.id === item.id ? manuallyCompleteBatchItem(value, true) : value));
    onNotice(`${batchItemChapterLabel(item.sourceName) || "本章"}第${item.section}节已手动标记为生成成功、下载成功`);
  }

  function undoManualBatchItemGenerated(item) {
    setItems((values) => values.map((value) => value.id === item.id ? clearManualBatchCompletion(value) : value));
    onNotice(`${batchItemChapterLabel(item.sourceName) || "本章"}第${item.section}节已取消手动成功标记`);
  }

  function undoManualBatchItemDownloaded(item) {
    setItems((values) => values.map((value) => value.id === item.id ? clearManualBatchDownload(value) : value));
    onNotice(`${batchItemChapterLabel(item.sourceName) || "本章"}第${item.section}节已取消手动下载标记`);
  }

  function removeAllAudioReferences() {
    if (!audioReferenceCount) return onNotice("当前批量章节没有已匹配的音频参考");
    if (!window.confirm(`确定移除当前批量中的 ${audioReferenceCount} 个音频参考吗？\n\n图片、视频、提示词正文和项目资产不会删除；角色声线与配音指令文字会保留。`)) return;
    const affectedSections = items.filter((item) => (
      (item.references || []).some((reference) => reference.kind === "audio")
    )).length;
    setItems((values) => values.map((item) => removeBatchReferenceKind(item, "audio")));
    onNotice(`已从 ${affectedSections} 节中移除 ${audioReferenceCount} 个音频参考；图片、视频及提示词正文均已保留`);
  }

  async function markBatchItemUnusable(item) {
    setBusy("reviewing");
    try {
      const stored = await allTasks();
      const completed = batchItemTasks(item, stored).filter((task) => task.status === "completed");
      if (completed.length) await putTasks(completed.map((task) => reviewedTask(task, true)));
      updateItem(item.id, {
        status: "generation_failed",
        progress: 100,
        error: MANUAL_UNUSABLE_ERROR,
        manuallyMarkedUnusable: true,
        downloaded: false,
        downloadedCount: 0,
        manuallyMarkedGenerated: false,
        manuallyMarkedDownloaded: false,
        manualCompletionSnapshot: undefined,
      });
      onTasksAdded();
      onNotice(`${batchItemChapterLabel(item.sourceName) || "当前章"}第${item.section}节已标记为视频不可用；${completed.length ? "旧任务仍保留" : "原关联任务记录已缺失"}，可以单独重新生成本节`);
    } catch (error) {
      onNotice(error.message || "修改本节状态失败");
    } finally {
      setBusy("");
    }
  }

  async function undoBatchItemUnusable(item) {
    setBusy("reviewing");
    try {
      const stored = await allTasks();
      const related = batchItemTasks(item, stored);
      const marked = related.filter((task) => task.status === "completed" && task.reviewStatus === "dissatisfied");
      if (!marked.length && !related.some((task) => task.status === "completed")) {
        throw new Error("没有找到本节原来的成功任务，无法取消不可用标记");
      }
      const restored = marked.map((task) => reviewedTask(task, false));
      if (restored.length) await putTasks(restored);
      const restoredById = new Map(restored.map((task) => [task.id, task]));
      const updatedStored = stored.map((task) => restoredById.get(task.id) || task);
      setItems((values) => withDownloadedFlags(values.map((value) => value.id === item.id
        ? { ...value, manuallyMarkedUnusable: false, status: "generated", progress: 100, error: "" }
        : value), updatedStored));
      onTasksAdded();
      onNotice(`${batchItemChapterLabel(item.sourceName) || "当前章"}第${item.section}节已取消不可用标记，原成功视频已恢复`);
    } catch (error) {
      onNotice(error.message || "取消不可用标记失败");
    } finally {
      setBusy("");
    }
  }

  async function downloadFinalCollection(includeDownloaded = false) {
    setFinalDownloading(true);
    try {
      const stored = await allTasks();
      const completed = preferredBatchDownloadTasks(items, stored);
      if (!completed.length) throw new Error("当前还没有取得下载地址的成功视频，请稍后刷新任务状态");
      const unfinished = Math.max(0, items.length - Number(summary.generated || 0));
      await onDownloadTasks(completed, `final-${Date.now()}`, `多章节阶段合集（已生成 ${summary.generated || 0}/${items.length} 节${unfinished ? `，其余 ${unfinished} 节暂不下载` : ""}）`, { includeDownloaded });
      const refreshed = await allTasks();
      setItems((values) => withDownloadedFlags(values, refreshed));
    } catch (error) {
      onNotice(error.message || "最终下载失败");
    } finally {
      setFinalDownloading(false);
    }
  }

  function checkOvernightReadiness() {
    if (!overnightPlan?.itemIds?.length) return onNotice("当前托管还没有任务；可以先批量提交，或在已有任务生成时重新点击“托管当前任务”");
    if (busy || overnightReport.awaitingReceipt || !overnightReport.safeToShutdown) {
      return onNotice(`现在还不能安全关机：${overnightReport.itemCount} 节中已取得 ${overnightReport.acceptedTaskCount} 个新任务 ID，仍有 ${overnightReport.awaitingReceipt} 节未确认送达。请等待提交结束；结果待确认的任务也要先处理。`);
    }
    onNotice(`离开前检查通过：${overnightReport.itemCount} 节均已取得中转任务 ID，可以关机或离开。下次启动工作台会自动恢复查询；请确保当前中转 KEY 已勾选“记住 Key”。`);
  }

  function startOrCheckOvernight() {
    const startedAt = Date.now();
    const activeItems = items.filter((item) => ["submitting", "submitted", "generating"].includes(item.status));
    const sameProvider = overnightPlan?.profileId === activeProfile.id;
    const trackedIds = new Set(sameProvider ? overnightPlan?.itemIds || [] : []);
    const additions = activeItems.filter((item) => !trackedIds.has(item.id));
    if (sameProvider && overnightPlan?.itemIds?.length && !additions.length) return checkOvernightReadiness();
    setOvernightPlan((current) => {
      const keepCurrent = current?.profileId === activeProfile.id;
      const itemIds = keepCurrent ? [...(current.itemIds || [])] : [];
      const baselineTaskIds = keepCurrent ? { ...(current.baselineTaskIds || {}) } : {};
      for (const item of activeItems) {
        if (!itemIds.includes(item.id)) {
          itemIds.push(item.id);
          baselineTaskIds[item.id] = [];
        }
      }
      return {
        itemIds,
        baselineTaskIds,
        profileId: activeProfile.id,
        providerName: activeProfile.name,
        model: activeProfile.model,
        createdAt: keepCurrent ? current.createdAt : startedAt,
        updatedAt: startedAt,
      };
    });
    onNotice(activeItems.length
      ? `已接管当前 ${additions.length || activeItems.length} 节正在提交或生成的任务；接下来提交到 ${activeProfile.name} 的任务也会继续加入。离开前再点击“离开前检查”。`
      : `离开托管已开启：接下来提交到 ${activeProfile.name} 的批量任务会自动加入。全部提交结束后，再点击“离开前检查”。`);
  }

  async function downloadOvernightCollection() {
    setFinalDownloading(true);
    try {
      const stored = await allTasks();
      const completed = preferredBatchDownloadTasks(overnightItems, stored);
      if (!completed.length) throw new Error("托管任务目前还没有可下载的成功视频，工作台会继续自动查询");
      await onDownloadTasks(
        completed,
        `overnight-${overnightPlan.createdAt}`,
        `离开托管任务（已生成 ${overnightReport.generated}/${overnightReport.itemCount} 节）`,
        { includeDownloaded: false },
      );
      const refreshed = await allTasks();
      setItems((values) => withDownloadedFlags(values, refreshed));
    } catch (error) {
      onNotice(error.message || "托管任务下载失败");
    } finally {
      setFinalDownloading(false);
    }
  }

  const validUploaded = Object.values(uploaded).filter((value) => Number(value.expiresAt) > Date.now()).length;
  const importedSourceNames = useMemo(() => batchSourceNames(items, sourceName), [items, sourceName]);
  const importedSources = useMemo(() => importedSourceNames.map((name) => {
    const sourceItems = batchItemsForSource(items, name);
    return {
      name,
      items: sourceItems,
      generated: sourceItems.filter((item) => item.status === "generated").length,
      canSubmit: sourceItems.some(canBatchSubmit),
    };
  }), [importedSourceNames, items]);

  return (
    <div className="batch-panel">
      <div className="project-bar">
        <div><strong>{projectName ? `当前项目：${projectName}` : "当前未选择项目文件夹"}</strong><span>批量匹配只读取文件名；预上传或提交时才发送素材</span></div>
        <div>
          {window.showDirectoryPicker ? (
            <button
              className="secondary-button"
              onClick={projectNeedsPermission ? onRestoreProjectFolder : onChooseProjectFolder}
            >
              {projectNeedsPermission ? "恢复项目" : projectName ? "更换项目" : "选择项目文件夹"}
            </button>
          ) : (
            <label className="secondary-button file-button">选择项目文件夹<input type="file" multiple hidden webkitdirectory="" directory="" onChange={(event) => { onProjectFolder(event.target.files); event.target.value = ""; }} /></label>
          )}
          <button className="secondary-button" onClick={() => textInput.current?.click()}>导入批量 TXT</button>
          <button className="secondary-button batch-clear-button" disabled={!items.length || !!busy} onClick={clearBatch}>一键清空</button>
          <input ref={textInput} type="file" hidden accept="text/plain,.txt" onChange={(event) => { importText(event.target.files?.[0]); event.target.value = ""; }} />
        </div>
      </div>

      <label className="field-label fixed-label">固定内容（{fixedContentVersionLabel}）<span>两个模型版本分别保存；提交每一节时自动放在最前方</span></label>
      <textarea className="fixed-content" value={fixedContent} onChange={(event) => setFixedContent(event.target.value)} />

      <div className="batch-toolbar">
        <div><div className="batch-source-list">{importedSources.length ? importedSources.map((source) => (
          <div className="batch-source-row" key={source.name}>
            <strong>{source.name}</strong>
            <span>{source.generated}/{source.items.length} 节已生成</span>
            <button
              type="button"
              disabled={!!busy || !source.canSubmit}
              onClick={() => submitSelected(source.items, true)}
            >{source.generated === source.items.length ? "本章已完成" : "生成本章"}</button>
          </div>
        )) : <strong>尚未导入 TXT</strong>}</div><span>{items.length} 节 · 已匹配 {summary.matched || 0} · 生成中 {(summary.generating || 0) + (summary.submitted || 0) + (summary.submitting || 0)} · 已生成 {summary.generated || 0} · 失败 {(summary.failed || 0) + (summary.generation_failed || 0)}</span></div>
        <button disabled={!!busy || !items.length} onClick={matchAll}>{busy === "matching" ? "匹配中…" : "全部一键参考"}</button>
        <button disabled={!!busy || !audioReferenceCount} onClick={removeAllAudioReferences}>移除全部音频参考（{audioReferenceCount}）</button>
        <button disabled={!!busy || !items.length} onClick={preuploadAll}>{busy === "uploading" ? "上传中…" : `预上传全部素材${validUploaded ? `（${validUploaded}）` : ""}`}</button>
        <button className="overnight-toolbar-button" disabled={!!busy} onClick={startOrCheckOvernight}>{overnightPlan?.itemIds?.length ? "离开前检查" : "托管当前任务"}</button>
        {activeProfile.adapter === "meaicc" && (
          <button disabled={!!busy || !items.length} onClick={() => setRecoverOpen((value) => !value)}>{busy === "recovering" ? "找回中…" : "找回MEAICC任务"}</button>
        )}
        <label><span>提交模式</span><select value={submissionMode} onChange={(event) => setSubmissionMode(event.target.value)}><option value="ordered_rush">有序抢位（350ms）</option><option value="limited_rush">限量抢占（50ms）</option><option value="strict_order">严格顺序</option></select></label>
        <label title={submissionMode === "limited_rush" ? "限量抢占固定为5条同时在途" : ""}><span>最大同时在途</span><select value={submissionMode === "limited_rush" ? 5 : submissionMode === "strict_order" ? 1 : concurrency} disabled={submissionMode !== "ordered_rush"} onChange={(event) => setConcurrency(Number(event.target.value))}>{CONCURRENCY_OPTIONS.map((value) => <option key={value} value={value}>{value} 条</option>)}</select></label>
        <button disabled={!!busy || !(summary.generated || 0)} onClick={() => submitSelected(items.filter(canBatchResubmit), true, true)}>用当前模型重做已生成（{summary.generated || 0}）</button>
        <button className="primary-button" disabled={!!busy || !items.length} onClick={() => submitSelected(items, true)}>{busy === "uploading" ? "自动预上传中…" : busy === "submitting" ? "批量提交中…" : "开始批量提交"}</button>
      </div>

      <div className="batch-filter-toolbar" aria-label="批量章节状态筛选">
        {[
          ["all", "全部", items.length],
          ["pending", "待匹配/未提交", statusGroupCounts.pending || 0],
          ["matched", "已匹配", statusGroupCounts.matched || 0],
          ["generating", "提交中/生成中", statusGroupCounts.generating || 0],
          ["generated", "已生成", statusGroupCounts.generated || 0],
          ["failed", "失败/待确认", statusGroupCounts.failed || 0],
        ].map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            className={`batch-filter-button batch-filter-${value}${statusFilter === value ? " active" : ""}`}
            onClick={() => setStatusFilter(value)}
          >{label}（{count}）</button>
        ))}
        <button
          type="button"
          className="batch-final-download"
          disabled={!finalDownloadAvailable || finalDownloading}
          title="无需等待全部完成；按章号、节号顺序下载当前已经生成成功的视频"
          onClick={() => downloadFinalCollection(false)}
        >{finalDownloading ? "下载中…" : pendingDownloadSections > 0 ? `下载新增成功（${pendingDownloadSections}节）` : `已下载（${downloadedSections}节）`}</button>
        <button
          type="button"
          className="batch-final-download"
          disabled={!(summary.generated || 0) || finalDownloading}
          title="忽略已下载标记，按章号、节号从头重新下载全部成功视频"
          onClick={() => downloadFinalCollection(true)}
        >{finalDownloading ? "下载中…" : `完整重下全部（${summary.generated || 0}节）`}</button>
      </div>

      {overnightPlan && (
        <div className={`overnight-panel ${overnightReport.safeToShutdown ? "ready" : "waiting"}`}>
          <div>
            <strong>离开托管｜{overnightPlan.providerName} · {overnightPlan.model}</strong>
            <span>{overnightReport.itemCount ? `${overnightReport.itemCount} 节 · 已取得 ${overnightReport.acceptedTaskCount} 个新任务 ID · 已生成 ${overnightReport.generated} · 生成中 ${overnightReport.generating} · 失败 ${overnightReport.failed} · 未确认送达 ${overnightReport.awaitingReceipt}` : "已开启，等待你开始批量提交任务"}</span>
          </div>
          <button type="button" disabled={!!busy || !overnightReport.itemCount} onClick={checkOvernightReadiness}>离开前检查</button>
          <button type="button" disabled={finalDownloading || !overnightReport.generated} onClick={downloadOvernightCollection}>{finalDownloading ? "下载中…" : `回来收菜（${overnightReport.generated}）`}</button>
          <button type="button" className="overnight-clear" disabled={!!busy || finalDownloading} onClick={() => setOvernightPlan(null)}>结束本次托管</button>
        </div>
      )}

      {recoverOpen && activeProfile.adapter === "meaicc" && (
        <div className="notice">
          <label><span>粘贴任务 ID；推荐写成“29=任务ID”（支持 wr_... 和 UUID）</span>
            <textarea aria-label="MEAICC任务ID" value={recoverText} onChange={(event) => setRecoverText(event.target.value)} />
          </label>
          <button disabled={!!busy || !recoverText.trim()} onClick={recoverMeaiccTasks}>确认找回，不重新生成</button>
        </div>
      )}

      <div className="settings-grid batch-common-settings">
        <label><span>公共时长</span><select value={duration} onChange={(event) => setDuration(event.target.value === "auto" ? "auto" : Number(event.target.value))}>{capability.durations.map((value) => <option key={value} value={value}>{value === "auto" ? "自动" : `${value} 秒`}</option>)}</select></label>
        <label><span>公共清晰度</span><select value={resolution} onChange={(event) => setResolution(event.target.value)}>{capability.resolutions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>公共比例</span><select value={ratio} onChange={(event) => setRatio(event.target.value)}>{capability.ratios.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>生成数量</span><select value={quantity} onChange={(event) => setQuantity(Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>随机种子</span><input value={seed} onChange={(event) => setSeed(event.target.value)} disabled={!capability.seed} /></label>
      </div>
        <label className="check-row"><input type="checkbox" checked={syncAudio} onChange={(event) => setSyncAudio(event.target.checked)} />生成同步音频（当前中转默认开启）</label>
      <label className="check-row warning-check"><input type="checkbox" checked={allowMissingImages} onChange={(event) => setAllowMissingImages(event.target.checked)} />仍然提交缺少图片的章节</label>
      <div className="notice" role="status">ⓘ {onNotice && notice}</div>

      <div className="batch-list">
        {!visibleItems.length && <div className="batch-filter-empty">当前筛选状态下没有章节</div>}
        {visibleItems.map((item) => {
          const counts = countsFor(item.references || []);
          const issue = issueFor(item);
          const chapterLabel = batchItemChapterLabel(item.sourceName);
          const shownProgress = normalizedTaskProgress(item.status, item.progress);
          return (
            <article className={`batch-card ${issue ? "has-issue" : ""}`} key={item.id}>
              <div className="batch-card-top">
                <button className="batch-card-head" onClick={() => updateItem(item.id, { expanded: !item.expanded })}>
                  <strong>{chapterLabel ? `${chapterLabel} · ` : ""}第{item.section}节｜{item.title}</strong>
                  <span className="batch-card-summary">
                    <span>图{counts.image} · 音{counts.audio} · 视{counts.video}</span>
                    <span className={`batch-status batch-status-${item.status || "pending"}`}>{STATUS_LABELS[item.status] || "待匹配"}</span>
                    {item.downloaded && <span className="batch-downloaded-badge">✓ 已下载</span>}
                  </span>
                </button>
                <button
                  type="button"
                  className="batch-item-clear-references"
                  disabled={!!busy || !item.references?.length || ["submitting", "submitted", "generating"].includes(item.status)}
                  title={["submitting", "submitted", "generating"].includes(item.status) ? "任务正在提交或生成，暂时不能修改参考素材" : "只清空本节的图片、音频和视频参考"}
                  onClick={() => clearItemReferences(item)}
                >清空参考素材</button>
              </div>
              {["submitted", "submitting", "generating"].includes(item.status) && (
                <div className="batch-item-progress">
                  <div className="progress-track"><span style={{ width: `${shownProgress}%` }} /></div>
                  <b>{shownProgress}%</b>
                </div>
              )}
              {issue && <div className="batch-issue">{issue}</div>}
              {item.error && <div className="batch-error">{item.lastSubmission?.providerName || item.lastSubmission?.model
                ? <><strong>{[item.lastSubmission.providerName, item.lastSubmission.model].filter(Boolean).join(" · ")}</strong>：{item.error}{item.lastSubmission.taskCreated === false ? `（${item.lastSubmission.statusCode ? `HTTP ${item.lastSubmission.statusCode} · ` : ""}未取得任务 ID）` : ""}</>
                : item.error}</div>}
              {item.expanded && (
                <div className="batch-card-body">
                  <textarea value={item.prompt} onChange={(event) => updateItem(item.id, { prompt: event.target.value })} />
                  <div className="batch-reference-list">{(item.references || []).map((reference) => (
                    <span key={reference.id} className={reference.kind}>
                      {reference.tag} {reference.name}{reference.source === "manual" ? "（手动）" : ""}
                      <button
                        type="button"
                        className="batch-reference-remove"
                        title="删除这个素材"
                        aria-label={`删除素材 ${reference.name}`}
                        onClick={() => removeItemReference(item.id, reference.id)}
                      >×</button>
                    </span>
                  ))}</div>
                  <div className="batch-card-actions">
                    <button disabled={!!busy} onClick={() => matchOne(item.id)}>本节一键参考</button>
                    <label className="secondary-button file-button">手动添加素材<input type="file" multiple hidden accept="image/*,audio/*,video/*,.mov,.mp4" onChange={(event) => { addManualFiles(item.id, event.target.files); event.target.value = ""; }} /></label>
                    <button disabled={!!busy || !!issue} onClick={() => submitSelected([item], canBatchResubmit(item), canBatchResubmit(item))}>{canBatchResubmit(item) ? "用当前模型重新生成本节" : "开始生成本节"}</button>
                    {item.status === "generated" && (
                      <button type="button" disabled={!!busy} onClick={() => markBatchItemUnusable(item)}>标记视频不可用</button>
                    )}
                    {item.status !== "generated" && !item.manuallyMarkedGenerated && (
                      <button type="button" disabled={!!busy} onClick={() => markBatchItemGenerated(item)}>手动标记已生成</button>
                    )}
                    {item.status === "generated" && !item.downloaded && (
                      <button type="button" disabled={!!busy} onClick={() => markBatchItemDownloaded(item)}>手动标记已下载</button>
                    )}
                    {item.manuallyMarkedDownloaded && (
                      <button type="button" disabled={!!busy} onClick={() => undoManualBatchItemDownloaded(item)}>取消手动已下载</button>
                    )}
                    {item.manuallyMarkedGenerated && (
                      <button type="button" disabled={!!busy} onClick={() => undoManualBatchItemGenerated(item)}>取消手动已生成</button>
                    )}
                    {item.status === "generation_failed" && (item.manuallyMarkedUnusable || item.error === MANUAL_UNUSABLE_ERROR) && (
                      <button type="button" disabled={!!busy} onClick={() => undoBatchItemUnusable(item)}>取消不可用标记</button>
                    )}
                    {item.status === "submission_unknown" && (
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => {
                          if (window.confirm("请确认你已经在 MEAICC 后台核对过，本条确实没有创建任务。继续后，本条才会恢复为可提交状态。")) {
                            updateItem(item.id, { status: "matched", error: "" });
                          }
                        }}
                      >确认后台无任务，允许重试</button>
                    )}
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
