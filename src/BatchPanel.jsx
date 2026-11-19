import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  batchSerializable,
  batchItemChapterLabel,
  batchItemsForSource,
  batchSourceNames,
  batchStatusGroup,
  beginBatchSubmission,
  canBatchDefer,
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
  overnightRetryableItems,
  parseRecoveredTaskIds,
  providerBatchSubmissionPlan,
  reconciledBatchTerminalState,
  removeBatchReferenceKind,
  recoverInterruptedBatchItems,
  runOrderedStaggered,
  setBatchItemsDeferred,
} from "./batchPrompts.js";
import { completedBatchSource, importBatchTextFiles, removeCompletedBatchTextState } from "./batchTextFiles.js";
import { internalizeProjectAliases, normalizeImageReferenceBindings, planProjectAudioReferences, planProjectReferences } from "./projectReferences.js";
import { batchImageReferenceIssues, reindexBatchReferences as reindex, reconcileBatchReferenceTags } from "./batchReferences.js";
import { allTasks, getProjectTasks, getTasksByIds, putTasks } from "./taskStore.js";
import { BATCH_PAGE_SIZE, batchItemPage, needsBatchStatusSync, syncBatchTaskStates } from "./batchPerformance.js";
import { taskReuseSnapshot } from "./taskReuse.js";
import { seedanceSubmissionKey } from "./seedanceSubmissionRecovery.js";
import { reviewedTask } from "./taskRegeneration.js";
import { isTaskCancellable, manuallyCancelledTask } from "./taskCancellation.js";
import { pollDelayForAdapter } from "./providerCatalog.js";
import { normalizedTaskProgress } from "./taskProgress.js";
import { diagnosticHeaders, recordDiagnostic } from "./diagnostics.js";
import FixedContentControls from "./FixedContentControls.jsx";
import {
  configuredUploadBatchSize,
  materialUploadRetryDelay,
  retryableMaterialUploadStatus,
} from "./uploadPolicy.js";
import {
  batchItemDownloadCandidates,
  batchItemTasks,
  createBatchTaskLookup,
  preferredBatchDownloadTasks,
  recoverBatchItemTaskIds,
} from "./taskDownload.js";

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

function countsFor(references) {
  return references.reduce((counts, item) => ({ ...counts, [item.kind]: counts[item.kind] + 1 }), {
    image: 0,
    audio: 0,
    video: 0,
  });
}

function withDownloadedFlags(items, storedTasks) {
  const lookup = createBatchTaskLookup(storedTasks);
  const storedById = lookup.byId;
  let changed = false;
  const updated = (items || []).map((item) => {
    const recoveredTaskIds = recoverBatchItemTaskIds(item, lookup);
    const restoredItem = recoveredTaskIds.length ? { ...item, taskIds: recoveredTaskIds } : item;
    const candidates = batchItemDownloadCandidates(restoredItem, lookup);
    const relatedTasks = (restoredItem.taskIds || []).map((id) => storedById.get(id)).filter(Boolean);
    // 原任务的下载凭据不因事后修改提示词或素材而撤销；生成候选仍严格校验。
    const sourceTitle = String(item.sourceName || "").trim().replace(/\.txt$/i, "");
    const historicalDownload = item.status === "generated" && sourceTitle
      && Number(item.section) > 0 && (item.taskIds || []).some((id) => {
        const task = storedById.get(id);
        return task?.status === "completed" && task.reviewStatus !== "dissatisfied" && Number(task.downloadedAtMs) > 0
          && Number(task.batchSection) === Number(item.section)
          && String(task.batchTitle || "").trim().replace(/\.txt$/i, "") === sourceTitle;
      });
    const downloadedCount = item.manuallyMarkedDownloaded || candidates.some((task) => task.downloadedAtMs) || historicalDownload ? 1 : 0;
    const terminalState = reconciledBatchTerminalState(restoredItem, relatedTasks, candidates.length > 0);
    const activeState = !["unmatched", "matched"].includes(item.status)
      && recoveredTaskIds.length && relatedTasks.some((task) => ["queued", "processing"].includes(task.status))
      ? {
          status: "generating",
          progress: Math.round(relatedTasks.reduce(
            (total, task) => total + normalizedTaskProgress(task.status, task.progress),
            0,
          ) / relatedTasks.length),
          error: "",
        }
      : null;
    const next = {
      ...restoredItem,
      ...(activeState || {}),
      ...(terminalState || {}),
      recoveryNote: (terminalState?.status || activeState?.status || restoredItem.status) === "submission_unknown"
        ? restoredItem.recoveryNote : "",
      downloadedCount,
      downloaded: downloadedCount > 0,
    };
    const taskIdsUnchanged = next.taskIds === item.taskIds || (next.taskIds?.length === item.taskIds?.length
      && next.taskIds?.every((id, index) => id === item.taskIds[index]));
    if (taskIdsUnchanged && Object.entries(next).every(([key, value]) => key === "taskIds" || item[key] === value)) return item;
    changed = true;
    return next;
  });
  return changed ? updated : items;
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
  fixedContentTemplateId,
  fixedContentTemplates,
  fixedContentVersionLabel,
  headers,
  notice,
  onBusyChange,
  onNotice,
  onChooseProjectFolder,
  onDownloadTasks,
  onManageFixedContent,
  onRestoreProjectFolder,
  onTasksAdded,
  projectAssets,
  projectNeedsPermission,
  projectName,
  projectFolderLoading = false,
  projectFolderDiagnostic = null,
  taskProjectName,
  quantity,
  ratio,
  readMediaDuration,
  resolution,
  seed,
  setDuration,
  setFixedContent,
  setFixedContentTemplate,
  setQuantity,
  setRatio,
  setResolution,
  setSeed,
  setSyncAudio,
  syncAudio,
  taskDatabaseReady,
  taskRefreshVersion,
}) {
  const restoredStateRef = useRef();
  if (restoredStateRef.current === undefined) restoredStateRef.current = persistedState();
  const [items, setItems] = useState(restoredStateRef.current?.items || []);
  const [sourceName, setSourceName] = useState(restoredStateRef.current?.sourceName || "");
  const [concurrency, setConcurrency] = useState(restoredStateRef.current?.concurrency || 3);
  const [submissionMode, setSubmissionMode] = useState(restoredStateRef.current?.submissionMode || "ordered_rush");
  const [allowMissingImages, setAllowMissingImages] = useState(false);
  const [uploaded, setUploaded] = useState(restoredStateRef.current?.uploaded || {});
  const [uploadedProfileId, setUploadedProfileId] = useState(restoredStateRef.current?.uploadedProfileId || "");
  // 状态初始化后释放整批旧快照；null 表示已读取，后续渲染不重复读取。
  restoredStateRef.current = null;
  const [overnightPlan, setOvernightPlan] = useState(persistedOvernightPlan);
  const [autoRetryCycle, setAutoRetryCycle] = useState(0);

  const [busy, setBusy] = useState("");
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recoverText, setRecoverText] = useState("");
  const [seedanceRecovering, setSeedanceRecovering] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [batchPage, setBatchPage] = useState(1);
  const [selectedItemIds, setSelectedItemIds] = useState([]);
  const [finalDownloading, setFinalDownloading] = useState(false);
  const [mention, setMention] = useState(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const promptInputs = useRef(new Map());
  const textInput = useRef(null);
  const recoveredBatchRef = useRef("");
  const slowNoticeBatchRef = useRef("");
  const uploadCredentialRef = useRef(apiKey);
  const autoRetryRunningRef = useRef(false);
  const seedanceRecoveryRunningRef = useRef(false);
  const seedanceRecoveryHandlerRef = useRef(null);
  const downloadSyncLoadRef = useRef({ running: false, refresh: null });
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    onBusyChange?.(Boolean(busy || finalDownloading || seedanceRecovering || overnightPlan?.autoRetryFailures));
    return () => onBusyChange?.(false);
  }, [busy, finalDownloading, seedanceRecovering, overnightPlan?.autoRetryFailures, onBusyChange]);

  const seedanceRecoveryKeys = ["seedancevideo", "baoju"].includes(activeProfile.adapter) ? items
    .filter((item) => item.status === "submission_unknown" && item.lastSubmission?.profileId === activeProfile.id)
    .map(seedanceSubmissionKey).filter(Boolean).sort().join("|") : "";
  seedanceRecoveryHandlerRef.current = recoverSeedanceTasks;

  // 待确认只查原任务；查不到继续等待，刷新后也自动恢复核对。
  useEffect(() => {
    if (!apiKey || !seedanceRecoveryKeys) return undefined;
    let cancelled = false;
    let timer;
    const check = async () => {
      const delay = await seedanceRecoveryHandlerRef.current({ automatic: true });
      if (!cancelled) timer = window.setTimeout(check, delay || 30000);
    };
    timer = window.setTimeout(check, 1000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [apiKey, activeProfile.id, seedanceRecoveryKeys]);

  const mentionSuggestions = (items.find((item) => item.id === mention?.itemId)?.references || []).filter((reference) => {
    const query = (mention?.query || "").toLowerCase();
    const number = reference.tag.match(/\d+$/)?.[0] || "";
    return !query || [reference.tag.slice(1), reference.name, reference.alias || "", `${LABELS[reference.kind]}${number}`, `${LABELS[reference.kind].slice(0, 1)}${number}`]
      .some((value) => value.toLowerCase().includes(query));
  });

  useEffect(() => {
    setItems((values) => recoverInterruptedBatchItems(values));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        items: batchSerializable(items),
        sourceName,
        concurrency,
        submissionMode,
        uploaded,
        uploadedProfileId,
      }));
    } catch {
      onNotice("批量内容暂时无法保存到浏览器缓存，当前页面和任务仍保留；暂勿刷新，请保留原始 TXT 并导出任务备份。");
    }
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
    const hasTrackedTasks = items.some(needsBatchStatusSync);
    if (!hasTrackedTasks) return undefined;
    let cancelled = false;
    let timer;
    async function syncGeneratedStatuses() {
      try {
        const stored = await getTasksByIds(itemsRef.current.filter(needsBatchStatusSync).flatMap((item) => item.taskIds));
        if (cancelled) return;
        setItems((values) => syncBatchTaskStates(values, stored));
      } catch {
        // 任务列表暂时不可读时保留现有状态，下一轮继续同步。
      } finally {
        if (!cancelled) timer = window.setTimeout(syncGeneratedStatuses, 3000);
      }
    }
    syncGeneratedStatuses();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [items.some(needsBatchStatusSync)]);

  const summary = useMemo(() => items.reduce((value, item) => {
    value[item.status] = (value[item.status] || 0) + 1;
    return value;
  }, {}), [items]);
  const statusGroupCounts = useMemo(() => items.reduce((value, item) => {
    if (item.deferred) return value;
    const group = batchStatusGroup(item.status);
    value[group] = (value[group] || 0) + 1;
    return value;
  }, {}), [items]);
  const visibleItems = useMemo(() => filterBatchItems(items, statusFilter), [items, statusFilter]);
  const { items: pageItems, page: currentPage, totalPages } = useMemo(() => batchItemPage(visibleItems, batchPage), [visibleItems, batchPage]);
  const deferredItems = useMemo(() => filterBatchItems(items, "deferred"), [items]);
  const selectableItems = visibleItems.filter(canBatchDefer);
  const selectedItems = items.filter((item) => selectedItemIds.includes(item.id) && canBatchDefer(item));
  const allVisibleSelected = selectableItems.length > 0 && selectableItems.every((item) => selectedItemIds.includes(item.id));
  const downloadedSections = items.filter((item) => item.downloaded).length;
  const pendingDownloadSections = filterBatchItems(items, "undownloaded").length;
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
  const overnightRetryable = useMemo(
    () => overnightRetryableItems(items, overnightPlan),
    [items, overnightPlan],
  );
  const overnightRetryKey = useMemo(() => JSON.stringify(overnightRetryable.map((item) => ({
    id: item.id,
    status: item.status,
    taskIds: item.taskIds || [],
    failedAt: item.lastSubmission?.failedAt || 0,
    references: (item.references || []).map((reference) => reference.id || reference.url || reference.name || reference.tag),
    missingImages: item.missingImages || [],
    overrides: item.overrides || {},
  }))), [overnightRetryable]);

  useEffect(() => {
    if (!taskDatabaseReady || !trackedDownloadKey) return undefined;
    let cancelled = false;
    const refresh = async () => {
      try {
        const stored = taskProjectName ? await getProjectTasks(taskProjectName) : await allTasks();
        if (cancelled) return;
        const storedIds = new Set(stored.map((task) => task.id));
        const missingIds = itemsRef.current.flatMap((item) => item.taskIds || []).filter((id) => !storedIds.has(id));
        if (missingIds.length) stored.push(...await getTasksByIds(missingIds));
        if (!cancelled) setItems((values) => withDownloadedFlags(values, stored));
      } catch {
        // 暂时读取失败时保留状态，等待下一次任务刷新。
      }
    };
    const loader = downloadSyncLoadRef.current;
    loader.refresh = refresh;
    if (!loader.running) {
      loader.running = true;
      (async () => {
        try {
          while (loader.refresh) {
            const next = loader.refresh;
            loader.refresh = null;
            await next();
          }
        } finally {
          loader.running = false;
        }
      })();
    }
    return () => {
      cancelled = true;
      if (loader.refresh === refresh) loader.refresh = null;
    };
  }, [taskDatabaseReady, taskRefreshVersion, trackedDownloadKey, taskProjectName]);

  async function importText(fileList) {
    const { additions, sourceNames, failures } = await importBatchTextFiles(fileList, uid("txt-import"));
    if (additions.length) {
      setBatchPage(Math.floor(itemsRef.current.length / BATCH_PAGE_SIZE) + 1);
      setItems((current) => [...current, ...additions]);
      setStatusFilter("all");
      setSourceName(sourceNames.at(-1));
    }
    if (additions.length || failures.length) onNotice(`${additions.length ? `批量 TXT 已追加：${sourceNames.length} 个文件，新增 ${additions.length} 节；按文件名自然顺序导入，正在提交和生成中的章节保持不动。` : "未导入新的章节。"}${failures.length ? `未导入 ${failures.length} 个文件：${failures.map((entry) => `${entry.name}（${entry.error}）`).join("；")}` : ""}`);
  }

  function removeCompletedText(name) {
    if (busy || finalDownloading || autoRetryRunningRef.current) return;
    const next = removeCompletedBatchTextState({ items: itemsRef.current, sourceName, selectedItemIds, uploaded, overnightPlan }, name, uploadKey);
    if (!next) return onNotice("本条 TXT 还有未生成或未下载的节，暂不能删除");
    if (!window.confirm(`确定删除左侧的“${name}”及其 ${itemsRef.current.length - next.items.length} 节批量内容吗？\n\n这些节均已生成并下载。只移除左侧提示词与匹配缓存，右侧任务记录、计费记录和本地视频均保留；不会重新提交。`)) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: batchSerializable(next.items), sourceName: next.sourceName, concurrency, submissionMode, uploaded: next.uploaded, uploadedProfileId }));
    } catch {
      return onNotice("无法保存删除结果，本条 TXT 未删除；请先导出任务备份并检查浏览器存储");
    }
    setItems(next.items);
    setSourceName(next.sourceName);
    setSelectedItemIds(next.selectedItemIds);
    setUploaded(next.uploaded);
    setOvernightPlan(next.overnightPlan);
    setMention(null);
    setBatchPage(1);
    onNotice(`已删除左侧“${name}”；右侧任务、计费记录和本地视频均已保留`);
  }

  function clearBatch() {
    if (!items.length) return;
    if (!window.confirm(`确定清空当前批量内容吗？\n\n将清除 ${items.length} 节提示词、匹配结果、提交状态和预上传缓存。固定内容、公共参数、并发档位及项目文件夹会保留。`)) return;
    setItems([]);
    setBatchPage(1);
    setSelectedItemIds([]);
    setSourceName("");
    setUploaded({});
    setUploadedProfileId("");
    setOvernightPlan(null);
    if (textInput.current) textInput.current.value = "";
    onNotice("批量内容已清空，可以导入下一段 TXT；固定内容、公共参数和当前项目均已保留");
  }

  function deferSelectedItems() {
    if (busy || autoRetryRunningRef.current || !selectedItems.length) return;
    const ids = selectedItems.map((item) => item.id);
    setItems((values) => setBatchItemsDeferred(values, ids));
    setOvernightPlan((current) => current ? {
      ...current,
      itemIds: current.itemIds.filter((id) => !ids.includes(id)),
      baselineTaskIds: Object.fromEntries(Object.entries(current.baselineTaskIds || {}).filter(([id]) => !ids.includes(id))),
    } : current);
    setSelectedItemIds([]);
    onNotice(`已将 ${ids.length} 节移入暂不生成区；原提示词、素材、失败原因和任务 ID 均保留，后续匹配、上传、提交及托管重试会跳过这些节`);
  }

  function releaseDeferredItems() {
    if (busy || autoRetryRunningRef.current || !deferredItems.length) return;
    const ids = deferredItems.map((item) => item.id);
    setItems((values) => setBatchItemsDeferred(values, ids, false));
    setOvernightPlan((current) => current ? {
      ...current,
      itemIds: current.itemIds.filter((id) => !ids.includes(id)),
      baselineTaskIds: Object.fromEntries(Object.entries(current.baselineTaskIds || {}).filter(([id]) => !ids.includes(id))),
    } : current);
    setStatusFilter("all");
    setSelectedItemIds([]);
    onNotice(`已释放 ${deferredItems.length} 节，原状态已保留；不会自动提交，请修改提示词或素材后再匹配、提交`);
  }

  async function matchItem(item) {
    const manual = (item.references || []).filter((reference) => reference.source === "manual");
    const manualNames = new Set(manual.map((reference) => `${reference.kind}:${reference.name}`));
    const boundPrompt = normalizeImageReferenceBindings(item.prompt, item.references);
    const plan = planProjectReferences(boundPrompt, projectAssets);
    const plannedMatches = [...plan.matches, ...(plan.outsideMatches || [])];
    const outsideKeys = new Set((plan.outsideMatches || []).map((match) => match.asset.key));
    const boundManual = manual.map((reference) => {
      const match = plannedMatches.find((entry) => entry.kind === reference.kind && entry.asset.file.name === reference.name);
      return match ? { ...reference, alias: match.asset.stem, projectAssetKey: match.asset.key, noAutoMention: Boolean(match.noAutoMention) } : reference;
    });
    const boundAssets = (item.references || []).filter((reference) => {
      if (reference.source !== "automatic") return false;
      const number = reference.tag?.match(/[1-9]\d*$/)?.[0];
      const labels = { image: "Image|图片|图", audio: "Audio|音频|声音", video: "Video|视频" };
      return number && new RegExp(`@(?:${labels[reference.kind]})${number}(?=\\s|=|[、，,；;。]|$)`, "i").test(boundPrompt);
    }).map((reference) => projectAssets.find((asset) => asset.key === reference.projectAssetKey)).filter(Boolean);
    const automaticAssets = [...new Map([...boundAssets, ...plannedMatches.map((match) => match.asset)]
      .filter((asset) => !manualNames.has(`${asset.kind}:${asset.file.name}`)).map((asset) => [asset.key, asset])).values()];
    const durations = await Promise.all(automaticAssets.map((asset) => readMediaDuration(asset.file, asset.kind)));
    const durationByKey = new Map(automaticAssets.map((asset, index) => [asset.key, durations[index]]));
    const automatic = automaticAssets.map((asset) => ({
      id: uid("batch-ref"),
      source: "automatic",
      projectAssetKey: asset.key,
      kind: asset.kind,
      name: asset.file.name,
      alias: asset.stem,
      durationSeconds: durationByKey.get(asset.key) || null,
      subType: "reference",
      ...(outsideKeys.has(asset.key) ? { noAutoMention: true } : {}),
    }));
    const references = reindex([...automatic, ...boundManual]);
    const prompt = reconcileBatchReferenceTags(plan.annotatedPrompt, item.references || [], references);
    return {
      ...item,
      prompt,
      references,
      missingImages: batchImageReferenceIssues({ prompt, references, status: "matched" }, projectAssets, capability.images),
      status: "matched",
      error: "",
    };
  }

  async function matchAudioItem(item) {
    const plan = planProjectAudioReferences(item.prompt, projectAssets);
    if (!plan.matches.length) return item;
    const automaticAssets = [...new Map(plan.matches.map((match) => [match.asset.key, match.asset])).values()];
    const durations = await Promise.all(automaticAssets.map((asset) => readMediaDuration(asset.file, "audio")));
    const durationByKey = new Map(automaticAssets.map((asset, index) => [asset.key, durations[index]]));
    const preserved = (item.references || []).filter((reference) => reference.kind !== "audio" || reference.source === "manual");
    const manualAudioNames = new Set(preserved
      .filter((reference) => reference.kind === "audio")
      .map((reference) => String(reference.name || "").toLowerCase()));
    const automatic = automaticAssets
      .filter((asset) => !manualAudioNames.has(String(asset.file.name || "").toLowerCase()))
      .map((asset) => ({
        id: uid("batch-ref"),
        source: "automatic",
        projectAssetKey: asset.key,
        kind: "audio",
        name: asset.file.name,
        alias: asset.stem,
        durationSeconds: durationByKey.get(asset.key) || null,
        subType: "reference",
      }));
    const references = reindex([...preserved, ...automatic]);
    return {
      ...item,
      prompt: reconcileBatchReferenceTags(plan.annotatedPrompt, item.references || [], references),
      references,
      status: "matched",
      error: "",
    };
  }

  async function matchOne(id) {
    if (!projectAssets.length) return onNotice("请先选择项目文件夹");
    const current = items.find((item) => item.id === id);
    if (!current || !canBatchMatch(current)) return;
    setBusy(`match:${id}`);
    try {
      const matched = await matchItem(current);
      setItems((values) => values.map((item) => item.id === id ? matched : item));
      onNotice(`第 ${matched.section} 节匹配完成：${matched.references.length} 个素材${matched.missingImages.length ? `；缺少图片：${matched.missingImages.join("、")}` : ""}`);
    } finally {
      setBusy("");
    }
  }

  async function matchAll() {
    if (!projectAssets.length) return onNotice("请先选择项目文件夹");
    const candidates = items.filter(canBatchMatch);
    if (!candidates.length) return onNotice("没有需要匹配的新章节；暂不生成、提交中、生成中和已生成章节已自动跳过");
    setBusy("matching");
    try {
      const matched = [];
      for (const item of candidates) matched.push(await matchItem(item));
      const byId = new Map(matched.map((item) => [item.id, item]));
      setItems((values) => values.map((item) => byId.get(item.id) || item));
      const refs = matched.reduce((total, item) => total + item.references.length, 0);
      const missing = matched.filter((item) => item.missingImages.length);
      onNotice(`全部一键参考完成：${matched.length} 节，共匹配 ${refs} 个素材；${missing.length ? `${missing.length} 节缺少图片，请查看标红章节；` : ""}缺少音频已自动忽略`);
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
    setItems((values) => values.map((item) => {
      if (item.id !== id) return item;
      const references = reindex([...(item.references || []), ...additions]);
      return { ...item, prompt: reconcileBatchReferenceTags(item.prompt, item.references || [], references), references };
    }));
  }

  function removeItemReference(itemId, referenceId) {
    setItems((values) => values.map((item) => {
      if (item.id !== itemId) return item;
      const removed = (item.references || []).find((reference) => reference.id === referenceId);
      const references = reindex((item.references || []).filter((reference) => reference.id !== referenceId));
      let prompt = reconcileBatchReferenceTags(item.prompt, item.references || [], references);
      if (removed?.alias) {
        const escaped = removed.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        prompt = prompt.replace(new RegExp(`@${escaped}=${escaped}`, "g"), removed.alias);
      }
      return { ...item, prompt, references };
    }));
  }

  function resolveFile(reference, cached = null) {
    const file = reference.file || projectAssets.find((asset) => asset.key === reference.projectAssetKey)?.file || null;
    const cachedAvailable = cached && (!cached.expiresAt || Number(cached.expiresAt) > Date.now())
      && (/^https?:\/\//i.test(String(cached.url || "")) || (cached.assetId && (activeProfile.adapter === "aiyrx" || (activeProfile.adapter === "huajing" && reference.kind === "image"))));
    if (reference.source === "manual" && !file && !cachedAvailable && !/^https?:\/\//i.test(String(reference.url || ""))) {
      throw new Error(`手动素材文件“${reference.name || "未命名素材"}”未恢复，请先移除该失效引用，再重新选择文件后生成`);
    }
    return file;
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

  async function preuploadItems(targetItems, quiet = false, startingCache = null) {
    const unique = new Map();
    const nextUploaded = startingCache || (uploadedProfileId === activeProfile.id ? { ...uploaded } : {});
    for (const item of targetItems) {
      for (const reference of item.references || []) {
        const key = uploadKey(item, reference);
        const file = resolveFile(reference, nextUploaded[key]);
        if (activeProfile.adapter === "huajing" && reference.kind !== "image") continue;
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
          && (connectionError || (activeProfile.adapter !== "maxforai" && retryableMaterialUploadStatus(response?.status)));
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
        const error = new Error(`${body.message || "素材预上传失败"}${progress}`);
        error.status = response.status;
        throw error;
      }
      for (const material of body.materials || []) {
        nextUploaded[material.key] = {
          url: material.url || "",
          assetId: material.assetId || "",
          sizeBytes: material.bytes || null,
          expiresAt: body.expiresAt,
        };
      }
      completedThisRun += body.materials?.length || 0;
      // 逐个上传确认；每成功一个就立即写入状态与本地缓存，中途限流也不丢进度。
      setUploaded({ ...nextUploaded });
      setUploadedProfileId(activeProfile.id);
      onNotice(`正在预上传素材：${completedThisRun}/${entries.length}${["ziyuai", "maxforai"].includes(activeProfile.adapter) ? "（单通道，限流时会自动等待）" : ""}`);
    }
    setUploaded(nextUploaded);
    setUploadedProfileId(activeProfile.id);
    if (!quiet) onNotice(activeProfile.adapter === "huajing"
      ? `预上传完成：${entries.length} 张图片已保存至华镜素材库，将复用素材 ID；音频和视频随任务上传`
      : `预上传完成：${entries.length} 个唯一素材。相同素材在不同章节中会复用；建议50分钟内提交`);
    return nextUploaded;
  }

  async function preuploadAll() {
    if (!apiKey) return onNotice("请先配置当前中转站的 API Key");
    setBusy("uploading");
    try {
      await preuploadItems(items.filter((item) => !item.deferred));
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

  function issueFor(item, knownMissingImages) {
    const counts = countsFor(item.references || []);
    const exceeded = KINDS.filter((kind) => counts[kind] > (capability[`${kind}s`] || 0));
    if (exceeded.length) return exceeded.map((kind) => `${LABELS[kind]} ${counts[kind]}/${capability[`${kind}s`] || 0}`).join("、");
    const missingImages = batchImageReferenceIssues(item, projectAssets, capability.images, knownMissingImages);
    if (missingImages.length && !allowMissingImages) return `缺少图片：${missingImages.join("、")}`;
    return "";
  }

  async function submitOne(item, batchId, uploadCache, sequence, batchStartedAt) {
    const params = parametersFor(item);
    const references = reindex(item.references || []);
    const boundPrompt = normalizeImageReferenceBindings(reconcileBatchReferenceTags(item.prompt.trim(), item.references || [], references), references);
    const translated = internalizeProjectAliases(boundPrompt, references);
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
      const savedUpload = uploadCache[uploadKey(item, reference)];
      const cached = savedUpload && (!savedUpload.expiresAt || Number(savedUpload.expiresAt) > Date.now()) ? savedUpload : null;
      const localFile = resolveFile(reference, cached);
      const url = cached?.url || (/^https?:\/\//i.test(String(reference.url || "")) ? reference.url : "");
      const file = url || cached?.assetId ? null : localFile;
      const meta = {
        tag: reference.tag,
        kind: reference.kind,
        name: reference.name,
        subType: reference.subType || "reference",
        ...(reference.noAutoMention ? { noAutoMention: true } : {}),
        durationSeconds: reference.durationSeconds || null,
        sizeBytes: file?.size || cached?.sizeBytes || null,
        url,
        assetId: cached?.assetId || "",
        fileIndex: file ? fileIndex++ : null,
      };
      if (file) form.append("references", file, file.name);
      return meta;
    });
    form.set("referenceMeta", JSON.stringify(referenceMeta));
    const requestId = uid("task-submit");
    const submissionKey = ["seedancevideo", "baoju"].includes(activeProfile.adapter) && Number(params.quantity) === 1 ? crypto.randomUUID() : "";
    if (submissionKey) {
      form.set("clientSubmissionKey", submissionKey);
      setItems((values) => values.map((value) => value.id === item.id ? {
        ...value, lastSubmission: { ...value.lastSubmission, idempotencyKey: submissionKey, requestStartedAt: Date.now() },
      } : value));
    }
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
      if (["seedancevideo", "baoju"].includes(activeProfile.adapter)) {
        error.submissionUnknown = true;
        error.idempotencyKey = submissionKey;
        error.message = "工作台提交连接中断，是否已创建仍待确认；请核对原任务，不要直接重新生成";
      }
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
    const missingSeedanceReceipt = ["seedancevideo", "baoju"].includes(activeProfile.adapter) && response.ok
      && (!Array.isArray(body.tasks) || !body.tasks.length || body.tasks.some((task) => !task.id));
    if (!response.ok || missingSeedanceReceipt) {
      const error = new Error(missingSeedanceReceipt ? "中转未返回完整任务编号，创建结果仍待确认，请先核对原任务" : body.message || "任务提交失败");
      error.status = response.status;
      error.code = body.code || "";
      error.submissionUnknown = Boolean(body.submissionUnknown || body.code === "SUBMISSION_UNKNOWN" || missingSeedanceReceipt);
      error.idempotencyKey = body.idempotencyKey || submissionKey;
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
        prompt: boundPrompt,
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

  async function submitSelected(selectedItems, confirmAll = false, includeGenerated = false, options = {}) {
    if (!apiKey) return onNotice("请先配置当前中转站的 API Key");
    const candidates = selectedItems.filter((item) => canBatchSubmit(item) || (includeGenerated && canBatchResubmit(item)));
    try {
      for (const item of candidates) {
        for (const reference of item.references || []) {
          if (reference.source !== "manual") continue;
          const cache = uploadedProfileId === activeProfile.id ? uploaded : {};
          resolveFile(reference, cache[uploadKey(item, reference)]);
        }
      }
    } catch (error) {
      return onNotice(error.message);
    }
    const blocked = candidates.filter((item) => issueFor(item));
    const ready = candidates.filter((item) => !issueFor(item));
    if (!ready.length) return onNotice(blocked.length
      ? "没有可提交章节，请先处理标红问题"
      : includeGenerated
        ? "当前没有已生成、可以重新提交的章节"
        : "没有已匹配且待提交的新章节；暂不生成、提交中、生成中和已生成章节已自动跳过");
    const totalTasks = ready.reduce((total, item) => total + Number(parametersFor(item).quantity || 1), 0);
    const resubmittingCount = ready.filter(canBatchResubmit).length;
    const providerPlan = providerBatchSubmissionPlan(activeProfile, submissionMode, concurrency);
    const singleLike = submissionMode === "single_like" && !options.forceSerial;
    const submissionPlan = options.forceSerial
      ? { ...providerPlan, concurrency: 1, staggerMs: 0 }
      : providerPlan;
    const effectiveConcurrency = submissionPlan.concurrency;
    const modeLabel = options.forceSerial
      ? "托管失败串行重试（取得上一条任务 ID 后再提交下一条）"
      : submissionPlan.providerLimited
      ? "飞猫 SS 稳定模式（每次1条、间隔5秒；每30条暂停5分钟）"
      : singleLike
      ? "逐节单点（每节上传素材并取得任务ID后，再处理下一节）"
      : submissionMode === "strict_order"
      ? "严格顺序（上一节拿到任务ID后再提交下一节）"
      : submissionMode === "limited_rush"
        ? "限量抢占（50ms错峰、固定并发5；不保证中转后台顺序）"
        : "有序抢位（按章节号每350ms发出）";
    if (confirmAll && !window.confirm(`准备提交 ${ready.length} 节，共创建 ${totalTasks} 条任务。${resubmittingCount ? `\n其中 ${resubmittingCount} 节为重新生成，旧视频任务会保留。` : ""}\n中转站：${activeProfile.name}\n模型：${activeProfile.model}\n模式：${modeLabel}\n最大同时在途：${effectiveConcurrency} 节\n\n${singleLike ? "工作台会逐节上传素材并提交，上一节拿到任务 ID 后才处理下一节。" : "工作台会先自动预上传全部素材，再开始抢位。"}确认开始吗？`)) return;
    let uploadCache = uploadedProfileId === activeProfile.id ? { ...uploaded } : {};
    if (!singleLike) {
      setBusy("uploading");
      onNotice("正在分批预上传素材；已成功的素材会立即保存，临时断线会自动重试");
      try {
        uploadCache = await preuploadItems(ready, true);
      } catch (error) {
        setBusy("");
        onNotice(`自动预上传失败，尚未向中转站创建任务：${error.message || "未知错误"}`);
        return;
      }
    }
    setBusy("submitting");
    const batchId = uid("batch");
    const batchStartedAt = Date.now();
    setItems((values) => values.map((item) => ready.some((candidate) => candidate.id === item.id)
      ? beginBatchSubmission(item, activeProfile, batchStartedAt, batchId)
      : item));
    let successes = 0;
    let failures = 0;
    let firstFailureMessage = "";
    let stopReason = "";
    const startedItemIds = new Set();
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
        autoRetryFailures: sameProvider ? Boolean(current?.autoRetryFailures) : false,
        retryRound: sameProvider ? Number(current?.retryRound || 0) : 0,
        lastRetryAt: sameProvider ? Number(current?.lastRetryAt || 0) : 0,
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
      serialRetry: Boolean(options.forceSerial),
    });
    const dispatchResult = await runOrderedStaggered(ready, effectiveConcurrency, submissionPlan.staggerMs, async (item, sequence) => {
      startedItemIds.add(item.id);
      try {
        if (singleLike) {
          onNotice(`正在逐节上传素材并提交：${batchItemChapterLabel(item.sourceName) || ""}第${item.section}节`);
          uploadCache = await preuploadItems([item], true, uploadCache);
        }
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
              recoveryNote: "",
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
        const rateLimitReason = activeProfile.adapter === "seedancevideo" && error.submissionUnknown
          ? "当前中转创建结果不确定，已暂停后续未提交章节；请先核对原任务，避免重复扣费"
          : singleLike && Number(error.status) === 429
          ? "素材上传被中转限流（HTTP 429），已停止后续章节；请稍后再继续"
          : "";
        if ((deterministicReason || rateLimitReason) && !stopReason) {
          stopReason = deterministicReason || rateLimitReason;
          recordDiagnostic({
            adapter: activeProfile.adapter,
            providerName: activeProfile.name,
            model: activeProfile.model,
            batchId,
            section: item.section,
            sequence,
            stage: "client_batch_stop_requested",
            status: error.status || 0,
            reason: stopReason,
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

  useEffect(() => {
    if (!overnightPlan?.autoRetryFailures || !overnightRetryKey || busy || autoRetryRunningRef.current) return undefined;
    if (overnightPlan.profileId !== activeProfile.id || !apiKey) return undefined;
    const ready = overnightRetryable.filter((item) => !issueFor(item));
    if (!ready.length) return undefined;
    const timer = window.setTimeout(async () => {
      if (autoRetryRunningRef.current) return;
      const queued = overnightRetryableItems(items, overnightPlan).filter((item) => !issueFor(item));
      if (!queued.length) return;
      autoRetryRunningRef.current = true;
      const round = Number(overnightPlan.retryRound || 0) + 1;
      setOvernightPlan((current) => current?.autoRetryFailures ? {
        ...current,
        retryRound: round,
        lastRetryAt: Date.now(),
      } : current);
      onNotice(`托管失败自动重试第 ${round} 轮：${queued.length} 节已进入串行队列；每节取得新任务 ID 后才会提交下一节。`);
      try {
        await submitSelected(queued, false, false, { forceSerial: true });
      } finally {
        autoRetryRunningRef.current = false;
        setAutoRetryCycle((value) => value + 1);
      }
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [
    activeProfile.id,
    apiKey,
    autoRetryCycle,
    busy,
    overnightPlan?.autoRetryFailures,
    overnightPlan?.profileId,
    overnightRetryKey,
  ]);

  useEffect(() => {
    if (
      !overnightPlan?.autoRetryFailures
      || !overnightReport.itemCount
      || overnightReport.generated !== overnightReport.itemCount
      || overnightReport.generating
      || overnightReport.failed
    ) return;
    setOvernightPlan((current) => current ? { ...current, autoRetryFailures: false } : current);
    onNotice(`托管自动重试完成：${overnightReport.itemCount} 节已全部生成成功，失败任务已归零。`);
  }, [
    overnightPlan?.autoRetryFailures,
    overnightReport.failed,
    overnightReport.generated,
    overnightReport.generating,
    overnightReport.itemCount,
  ]);

  function toggleOvernightFailureRetry() {
    if (!overnightPlan?.itemIds?.length) return onNotice("请先开启托管并加入任务，再开启失败自动重试");
    if (overnightPlan.autoRetryFailures) {
      setOvernightPlan((current) => current ? { ...current, autoRetryFailures: false } : current);
      onNotice("托管失败自动重试已停止；当前已经提交出去的任务仍会继续生成");
      return;
    }
    if (overnightPlan.profileId !== activeProfile.id) {
      return onNotice(`请先切回托管使用的中转：${overnightPlan.providerName} · ${overnightPlan.model}`);
    }
    if (!apiKey) return onNotice("请先恢复并记住托管中转的 API Key");
    if (!window.confirm("开启后，托管范围内的确定失败任务会逐条重新提交：上一条取得新任务 ID 后才提交下一条；新失败任务会进入下一轮队列，直到全部成功或你手动停止。重复生成可能产生费用，确认开启吗？")) return;
    setOvernightPlan((current) => current ? {
      ...current,
      autoRetryFailures: true,
      retryRound: 0,
      lastRetryAt: 0,
    } : current);
    onNotice("托管失败自动重试已开启：采用单条串行队列，5 秒后开始检查失败任务");
  }

  async function recoverSeedanceTasks({ automatic = false } = {}) {
    if (seedanceRecoveryRunningRef.current) return 30000;
    if (!apiKey) {
      if (!automatic) onNotice("请先配置当前中转站的 API Key");
      return 30000;
    }
    const candidates = items.filter((item) => item.status === "submission_unknown"
      && item.lastSubmission?.profileId === activeProfile.id && seedanceSubmissionKey(item))
      .sort((a, b) => Number(a.lastSubmission.lastRecoveryAt || 0) - Number(b.lastSubmission.lastRecoveryAt || 0)).slice(0, 50);
    if (!candidates.length) {
      if (!automatic) onNotice("当前中转没有保留原始编号的待确认任务");
      return 30000;
    }
    seedanceRecoveryRunningRef.current = true;
    setSeedanceRecovering(true);
    let nextDelay = 30000;
    if (!automatic) {
      setBusy("recovering");
      onNotice("正在只读核对后台原任务，不重新生成、不重复扣费，请等待核对完成");
    }
    try {
      const response = await fetch("/api/tasks/recover-submissions", {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKeys: candidates.map(seedanceSubmissionKey) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        nextDelay = Math.max(30000, Number(body.retryAfterMs) || 0);
        throw new Error(body.message || "核对原任务失败");
      }
      const results = new Map(body.results.map((result) => [result.idempotencyKey, result]));
      const records = candidates.flatMap((item) => {
        const result = results.get(seedanceSubmissionKey(item));
        if (!result?.task) return [];
        const params = result.parameters || {};
        return [{ ...result.task, profileId: activeProfile.id, providerName: activeProfile.name,
          title: `第${String(item.section).padStart(2, "0")}节-${result.task.model}`,
          prompt: result.submittedPrompt,
          reuseSnapshot: taskReuseSnapshot({ prompt: item.prompt, references: item.references,
            duration: params.duration, resolution: params.resolution, ratio: params.ratio, quantity: 1 }),
          projectName: taskProjectName || "未归类", assetProjectName: projectName || "",
          batchId: item.lastSubmission.batchId || `recovered-${seedanceSubmissionKey(item)}`,
          batchTitle: (item.sourceName || sourceName || "批量任务").replace(/\.txt$/i, ""),
          batchSection: item.section, batchOrder: Number(item.section) * 10,
          createdAtMs: Date.parse(result.createdAt), createdAt: result.createdAt, nextPollAt: Date.now(),
        }];
      });
      await putTasks(records);
      setItems((values) => values.map((item) => {
        if (item.status !== "submission_unknown" || !candidates.some((candidate) => candidate.id === item.id && seedanceSubmissionKey(candidate) === seedanceSubmissionKey(item))) return item;
        const result = results.get(seedanceSubmissionKey(item));
        const lastSubmission = { ...item.lastSubmission, lastRecoveryAt: Date.now() };
        if (!result?.task) return { ...item, lastSubmission,
          recoveryNote: `${result?.reason || "仍需核实，未重新提交"}；30 秒后自动继续核对` };
        const task = result.task;
        return { ...item, status: task.status === "completed" ? "generated" : task.status === "failed" ? "generation_failed" : "generating",
          progress: task.progress, error: task.error || "", recoveryNote: "", taskIds: [task.id], autoRetryBlocked: Boolean(task.autoRetryBlocked),
          lastSubmission: { ...lastSubmission, idempotencyKey: result.idempotencyKey, taskCreated: true, recoveredAt: Date.now() } };
      }));
      if (records.length) onTasksAdded();
      const failed = records.filter((task) => task.status === "failed").length;
      const completed = records.filter((task) => task.status === "completed").length;
      if (!automatic || records.length) onNotice(`${automatic ? "自动" : ""}核对完成：找回 ${records.length} 条原任务（成功 ${completed}、失败 ${failed}、生成中 ${records.length - completed - failed}）；本轮仍待确认 ${candidates.length - records.length} 条，未确认的会继续自动查询。没有重新提交。`);
    } catch (error) {
      setItems((values) => values.map((item) => item.status === "submission_unknown"
        && candidates.some((candidate) => candidate.id === item.id && seedanceSubmissionKey(candidate) === seedanceSubmissionKey(item))
        ? { ...item, lastSubmission: { ...item.lastSubmission, lastRecoveryAt: Date.now() },
            recoveryNote: `${error.message || "后台查询暂时失败"}；${Math.ceil(nextDelay / 1000)} 秒后自动继续核对，未重新提交` }
        : item));
      if (!automatic) onNotice(error.message || "核对原任务失败，待确认任务未改动");
    } finally {
      seedanceRecoveryRunningRef.current = false;
      setSeedanceRecovering(false);
      if (!automatic) setBusy("");
    }
    return nextDelay;
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

  function updateMention(itemId, value, cursor) {
    const match = value.slice(0, cursor).match(/@([^\s@]*)$/);
    const next = match ? { itemId, start: cursor - match[0].length, query: match[1] } : null;
    const changed = !next || next.itemId !== mention?.itemId || next.start !== mention.start || next.query !== mention.query;
    setMention(next);
    if (changed) setMentionIndex(0);
  }

  function handlePromptChange(itemId, event) {
    const value = event.target.value;
    updateItem(itemId, { prompt: value });
    updateMention(itemId, value, event.target.selectionStart ?? value.length);
  }

  function handlePromptBlur(itemId, event) {
    const item = items.find((value) => value.id === itemId);
    if (item) {
      const value = event.currentTarget.value;
      const prompt = normalizeImageReferenceBindings(value, item.references);
      if (prompt !== value) {
        updateItem(itemId, { prompt });
        onNotice("已按本节 @ 图片编号同步实际参考文件名；其他未连接的人物仍会提示缺图");
      }
    }
    setMention((current) => current?.itemId === itemId ? null : current);
  }

  function chooseMention(itemId, reference) {
    const item = items.find((value) => value.id === itemId);
    if (!item || !item.references.some((value) => value.id === reference.id)) return;
    const input = promptInputs.current.get(itemId);
    const cursor = input?.selectionStart ?? item.prompt.length;
    const end = input?.selectionEnd ?? cursor;
    const start = mention?.itemId === itemId ? mention.start : cursor;
    const nextCursor = start + reference.tag.length + 1;
    updateItem(itemId, { prompt: `${item.prompt.slice(0, start)}${reference.tag} ${item.prompt.slice(end)}` });
    setMention(null);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function handlePromptKeyDown(itemId, event) {
    if (event.nativeEvent?.isComposing || event.isComposing || mention?.itemId !== itemId) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setMention(null);
    } else if (mentionSuggestions.length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      setMentionIndex((value) => (value + (event.key === "ArrowDown" ? 1 : -1) + mentionSuggestions.length) % mentionSuggestions.length);
    } else if (mentionSuggestions.length && ["Enter", "Tab"].includes(event.key)) {
      event.preventDefault();
      chooseMention(itemId, mentionSuggestions[mentionIndex] || mentionSuggestions[0]);
    }
  }

  async function cancelBatchItemGeneration(item) {
    const stored = await allTasks();
    const activeTasks = batchItemTasks(item, stored).filter(isTaskCancellable);
    if (!activeTasks.length) {
      onNotice("这节没有仍在排队或生成中的任务");
      return;
    }
    if (!window.confirm(`确定取消${batchItemChapterLabel(item.sourceName) || "本章"}第${item.section}节的生成吗？\n\n工作台会停止查询 ${activeTasks.length} 条任务并标记为已取消，但无法保证中转后台停止生成，也不代表自动退款。`)) return;
    await putTasks(activeTasks.map((task) => manuallyCancelledTask(task)));
    updateItem(item.id, {
      status: "generation_failed",
      progress: 100,
      error: "已由用户手动取消工作台跟踪；中转后台任务可能仍会继续生成",
      expanded: true,
    });
    onTasksAdded();
    onNotice(`${batchItemChapterLabel(item.sourceName) || "本章"}第${item.section}节已取消，可稍后重新生成`);
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

  async function matchAllAudio() {
    if (!projectAssets.some((asset) => asset.kind === "audio")) return onNotice("当前项目文件夹没有可用音频文件");
    const candidates = items.filter(canBatchMatch);
    if (!candidates.length) return onNotice("没有可匹配音频的章节；提交中、生成中和已生成章节已自动跳过");
    setBusy("matching-audio");
    try {
      const results = [];
      for (const item of candidates) results.push(await matchAudioItem(item));
      const matched = results.filter((item, index) => item !== candidates[index]);
      if (!matched.length) {
        onNotice("当前批量提示词中没有找到能与项目音频对应的声线或声音编号，原参考素材未作修改");
        return;
      }
      const byId = new Map(matched.map((item) => [item.id, item]));
      setItems((values) => values.map((item) => byId.get(item.id) || item));
      const audioCount = matched.reduce(
        (total, item) => total + (item.references || []).filter((reference) => reference.kind === "audio").length,
        0,
      );
      onNotice(`批量一键匹配音频完成：处理 ${matched.length} 节，共匹配 ${audioCount} 个音频参考；图片、场景和视频参考保持不变。`);
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
        autoRetryFailures: keepCurrent ? Boolean(current?.autoRetryFailures) : false,
        retryRound: keepCurrent ? Number(current?.retryRound || 0) : 0,
        lastRetryAt: keepCurrent ? Number(current?.lastRetryAt || 0) : 0,
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
      canRemove: completedBatchSource(sourceItems),
    };
  }), [importedSourceNames, items]);

  const pagination = visibleItems.length > BATCH_PAGE_SIZE && (
    <div className="pagination" aria-label="批量分页">
      <button type="button" disabled={currentPage === 1} onClick={() => setBatchPage(currentPage - 1)}>上一页</button>
      <span>第 {currentPage}/{totalPages} 页 · 共 {visibleItems.length} 节 · 每页 {BATCH_PAGE_SIZE} 节</span>
      <button type="button" disabled={currentPage === totalPages} onClick={() => setBatchPage(currentPage + 1)}>下一页</button>
      <small>分页仅影响显示，批量操作仍处理全部符合条件的节。</small>
    </div>
  );

  return (
    <div className="batch-panel">
      <div className="project-bar">
        <div><strong>{projectName ? `当前项目：${projectName}` : "当前未选择项目文件夹"}</strong><span>素材文件夹随任务项目保存；批量匹配只读取文件名，提交时才发送素材</span></div>
        <div>
            <button
              className="secondary-button"
              disabled={projectFolderLoading}
              onClick={projectNeedsPermission ? onRestoreProjectFolder : onChooseProjectFolder}
            >
              {projectFolderLoading ? projectNeedsPermission ? "等待浏览器授权…" : "正在读取文件夹…" : projectNeedsPermission ? "恢复项目" : projectName ? "更换项目" : "选择项目文件夹"}
            </button>
          {projectNeedsPermission && <button className="secondary-button" onClick={onChooseProjectFolder}>重新选择文件夹</button>}
          <button className="secondary-button" onClick={() => textInput.current?.click()}>导入批量 TXT</button>
          <button className="secondary-button batch-clear-button" disabled={!items.length || !!busy} onClick={clearBatch}>一键清空</button>
          <input ref={textInput} type="file" multiple hidden accept="text/plain,.txt" onChange={(event) => { importText(event.target.files); event.target.value = ""; }} />
        </div>
      </div>

      {projectFolderDiagnostic && <div className="notice" role="status">{projectFolderDiagnostic.message} · 记录时累计 {(projectFolderDiagnostic.elapsedMs / 1000).toFixed(1)} 秒</div>}

      <FixedContentControls
        fixedContent={fixedContent}
        onChange={setFixedContent}
        onManage={onManageFixedContent}
        onSelect={setFixedContentTemplate}
        selectedTemplateId={fixedContentTemplateId}
        templates={fixedContentTemplates}
        versionLabel={fixedContentVersionLabel}
      />

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
            {source.canRemove && <button
              type="button"
              disabled={!!busy || finalDownloading}
              onClick={() => removeCompletedText(source.name)}
            >删除本条TXT</button>}
          </div>
        )) : <strong>尚未导入 TXT</strong>}</div><span>{items.length} 节 · 已匹配 {summary.matched || 0} · 生成中 {(summary.generating || 0) + (summary.submitted || 0) + (summary.submitting || 0)} · 已生成 {summary.generated || 0} · 失败 {(summary.failed || 0) + (summary.generation_failed || 0)}</span></div>
        <button disabled={!!busy || !items.length} onClick={matchAll}>{busy === "matching" ? "匹配中…" : "全部一键参考"}</button>
        <button disabled={!!busy || !items.length || !projectAssets.some((asset) => asset.kind === "audio")} onClick={matchAllAudio}>{busy === "matching-audio" ? "匹配音频中…" : "一键匹配音频"}</button>
        <button disabled={!!busy || !audioReferenceCount} onClick={removeAllAudioReferences}>移除全部音频参考（{audioReferenceCount}）</button>
        <button disabled={!!busy || !items.length} onClick={preuploadAll}>{busy === "uploading" ? "上传中…" : `预上传全部素材${validUploaded ? `（${validUploaded}）` : ""}`}</button>
        <button className="overnight-toolbar-button" disabled={!!busy} onClick={startOrCheckOvernight}>{overnightPlan?.itemIds?.length ? "离开前检查" : "托管当前任务"}</button>
        {activeProfile.adapter === "meaicc" && (
          <button disabled={!!busy || !items.length} onClick={() => setRecoverOpen((value) => !value)}>{busy === "recovering" ? "找回中…" : "找回MEAICC任务"}</button>
        )}
        {["seedancevideo", "baoju"].includes(activeProfile.adapter) && (
          <button disabled={!!busy || seedanceRecovering || !seedanceRecoveryKeys} onClick={recoverSeedanceTasks}>{seedanceRecovering ? "核对后台中…" : "立即核对待确认任务（不重交）"}</button>
        )}
        {!!seedanceRecoveryKeys && <span role="status" aria-label="待确认任务自动核对">{apiKey ? "待确认任务每30秒自动查后台，找到原任务后自动接回；不会重新生成" : "待确认任务已保留，恢复当前中转 API Key 后自动继续查后台"}</span>}
        <label><span>提交模式</span><select value={submissionMode} onChange={(event) => setSubmissionMode(event.target.value)}><option value="ordered_rush">有序抢位（350ms）</option><option value="limited_rush">限量抢占（50ms）</option><option value="strict_order">严格顺序</option><option value="single_like">逐节单点（上传并提交一节，再处理下一节）</option></select></label>
        <label title={submissionMode === "limited_rush" ? "限量抢占固定为5条同时在途" : ""}><span>最大同时在途</span><select value={submissionMode === "limited_rush" ? 5 : ["strict_order", "single_like"].includes(submissionMode) ? 1 : concurrency} disabled={submissionMode !== "ordered_rush"} onChange={(event) => setConcurrency(Number(event.target.value))}>{CONCURRENCY_OPTIONS.map((value) => <option key={value} value={value}>{value} 条</option>)}</select></label>
        <button disabled={!!busy || !(summary.generated || 0)} onClick={() => submitSelected(items.filter(canBatchResubmit), true, true)}>用当前模型重做已生成（{summary.generated || 0}）</button>
        <button className="primary-button" disabled={!!busy || !items.length} onClick={() => submitSelected(items, true)}>{busy === "uploading" ? "自动预上传中…" : busy === "submitting" ? "批量提交中…" : "开始批量提交"}</button>
      </div>

      <div className="batch-filter-toolbar" aria-label="批量章节状态筛选">
        {[
          ["all", "全部", items.length],
          ["pending", "待匹配/未提交", statusGroupCounts.pending || 0],
          ["matched", "已匹配", statusGroupCounts.matched || 0],
          ["submitting", "提交中", statusGroupCounts.submitting || 0],
          ["generating", "生成中", statusGroupCounts.generating || 0],
          ["generated", "已生成", statusGroupCounts.generated || 0],
          ["undownloaded", "未下载", pendingDownloadSections],
          ["failed", "失败/待确认", statusGroupCounts.failed || 0],
          ["deferred", "暂不生成区", deferredItems.length],
        ].map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            className={`batch-filter-button batch-filter-${value}${statusFilter === value ? " active" : ""}`}
            onClick={() => { setStatusFilter(value); setBatchPage(1); }}
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

      <div className="batch-defer-toolbar" aria-label="暂不生成区操作">
        <label>
          <input
            type="checkbox"
            checked={allVisibleSelected}
            disabled={!!busy || !selectableItems.length}
            onChange={(event) => setSelectedItemIds((current) => event.target.checked
              ? [...new Set([...current, ...selectableItems.map((item) => item.id)])]
              : current.filter((id) => !selectableItems.some((item) => item.id === id)))}
          />全选当前未生成
        </label>
        <span>已勾选 {selectedItems.length} 节</span>
        <button type="button" disabled={!!busy || !selectedItems.length} onClick={deferSelectedItems}>移入暂不生成区</button>
        <button type="button" disabled={!!busy || !deferredItems.length} onClick={releaseDeferredItems}>一键释放暂不生成区（{deferredItems.length}）</button>
        <small>仅暂存未生成的节，不删除任务；释放后需手动处理并提交。</small>
      </div>

      {overnightPlan && (
        <div className={`overnight-panel ${overnightReport.safeToShutdown ? "ready" : "waiting"}`}>
          <div>
            <strong>离开托管｜{overnightPlan.providerName} · {overnightPlan.model}</strong>
            <span>{overnightReport.itemCount ? `${overnightReport.itemCount} 节 · 已取得 ${overnightReport.acceptedTaskCount} 个新任务 ID · 已生成 ${overnightReport.generated} · 生成中 ${overnightReport.generating} · 失败 ${overnightReport.failed} · 未确认送达 ${overnightReport.awaitingReceipt}` : "已开启，等待你开始批量提交任务"}</span>
            {overnightPlan.autoRetryFailures && <span>失败自动重试已开启 · 串行第 {Number(overnightPlan.retryRound || 0)} 轮 · 当前待重试 {overnightRetryable.length} 节{overnightPlan.profileId !== activeProfile.id ? " · 请切回托管中转" : !apiKey ? " · 等待恢复 API Key" : ""}</span>}
          </div>
          <button type="button" disabled={!!busy || !overnightReport.itemCount} onClick={checkOvernightReadiness}>离开前检查</button>
          <button
            type="button"
            className={`overnight-auto-retry${overnightPlan.autoRetryFailures ? " active" : ""}`}
            disabled={!overnightReport.itemCount || (!overnightPlan.autoRetryFailures && overnightPlan.profileId !== activeProfile.id)}
            onClick={toggleOvernightFailureRetry}
          >{overnightPlan.autoRetryFailures ? "停止失败自动重试" : `失败自动重试（${overnightRetryable.length}）`}</button>
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
        {!["bailing", "huajing"].includes(activeProfile.adapter) && <label className="check-row"><input type="checkbox" checked={syncAudio} onChange={(event) => setSyncAudio(event.target.checked)} />生成同步音频（当前中转默认开启）</label>}
      <label className="check-row warning-check"><input type="checkbox" checked={allowMissingImages} onChange={(event) => setAllowMissingImages(event.target.checked)} />仍然提交缺少图片的章节</label>
      <div className="notice" role="status">ⓘ {onNotice && notice}</div>

      {pagination}
      <div className="batch-list">
        {!visibleItems.length && <div className="batch-filter-empty">当前筛选状态下没有章节</div>}
        {pageItems.map((item) => {
          const counts = countsFor(item.references || []);
          const missingImages = batchImageReferenceIssues(item, projectAssets, capability.images);
          const issue = issueFor(item, missingImages);
          const chapterLabel = batchItemChapterLabel(item.sourceName);
          const shownProgress = normalizedTaskProgress(item.status, item.progress);
          return (
            <article className={`batch-card ${issue || missingImages.length ? "has-issue" : ""}`} data-task-ids={JSON.stringify(item.taskIds || [])} key={item.id}>
              <div className="batch-card-top">
                <input
                  className="batch-item-select"
                  type="checkbox"
                  aria-label={`选择暂不生成 ${chapterLabel || item.sourceName || "本章"}第${item.section}节 ${item.title}`}
                  checked={selectedItemIds.includes(item.id) && canBatchDefer(item)}
                  disabled={!!busy || !canBatchDefer(item)}
                  onChange={(event) => setSelectedItemIds((current) => event.target.checked
                    ? [...new Set([...current, item.id])]
                    : current.filter((id) => id !== item.id))}
                />
                <button className="batch-card-head" onClick={() => updateItem(item.id, { expanded: !item.expanded })}>
                  <strong>{chapterLabel ? `${chapterLabel} · ` : ""}第{item.section}节｜{item.title}</strong>
                  <span className="batch-card-summary">
                    <span className="batch-prompt-count" title="本条提示词字符数，含标点、空格和换行，不含公共固定内容">提示词 {Array.from(item.prompt || "").length} 字符</span>
                    <span>图{counts.image} · 音{counts.audio} · 视{counts.video}</span>
                    <span className={`batch-status batch-status-${item.status || "pending"}`}>{STATUS_LABELS[item.status] || "待匹配"}</span>
                    {item.deferred && <span className="batch-status batch-status-deferred">暂不生成</span>}
                    {!!missingImages.length && <span className="batch-missing-badge">缺少图片 {missingImages.length}</span>}
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
                {["submitted", "generating"].includes(item.status) && !!item.taskIds?.length && (
                  <button
                    type="button"
                    className="batch-item-cancel-generation"
                    disabled={!!busy}
                    onClick={() => cancelBatchItemGeneration(item)}
                  >取消生成</button>
                )}
              </div>
              {["submitted", "submitting", "generating"].includes(item.status) && (
                <div className="batch-item-progress">
                  <div className="progress-track"><span style={{ width: `${shownProgress}%` }} /></div>
                  <b>{shownProgress}%</b>
                </div>
              )}
              {!!(issue || missingImages.length) && <div className="batch-issue">{issue || `缺少图片：${missingImages.join("、")}（已允许继续提交）`}</div>}
              {item.error && <div className="batch-error">{item.lastSubmission?.providerName || item.lastSubmission?.model
                ? <><strong>{[item.lastSubmission.providerName, item.lastSubmission.model].filter(Boolean).join(" · ")}</strong>：{item.error}{item.lastSubmission.taskCreated === false ? `（${item.lastSubmission.statusCode ? `HTTP ${item.lastSubmission.statusCode} · ` : ""}未取得任务 ID）` : ""}</>
                : item.error}</div>}
              {item.status === "submission_unknown" && item.recoveryNote && <div className="batch-issue">核对结果：{item.recoveryNote}</div>}
              {item.expanded && (
                <div className="batch-card-body">
                  <div className="prompt-field">
                    <textarea
                      ref={(input) => { if (input) promptInputs.current.set(item.id, input); else promptInputs.current.delete(item.id); }}
                      aria-label={`${chapterLabel ? `${chapterLabel} · ` : ""}第${item.section}节提示词`}
                      aria-autocomplete="list"
                      aria-expanded={mention?.itemId === item.id}
                      aria-controls={mention?.itemId === item.id ? `batch-mentions-${item.id}` : undefined}
                      value={item.prompt}
                      onChange={(event) => handlePromptChange(item.id, event)}
                      onKeyDown={(event) => handlePromptKeyDown(item.id, event)}
                      onSelect={(event) => updateMention(item.id, event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
                      onBlur={(event) => handlePromptBlur(item.id, event)}
                    />
                    {mention?.itemId === item.id && (
                      <div className="mention-menu" id={`batch-mentions-${item.id}`} role="listbox" aria-label="本节参考素材引用">
                        {mentionSuggestions.length ? mentionSuggestions.map((reference, index) => (
                          <button
                            type="button"
                            role="option"
                            aria-selected={index === mentionIndex}
                            className={index === mentionIndex ? "active" : ""}
                            key={reference.id}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => chooseMention(item.id, reference)}
                          >
                            <span className={`mention-icon ${reference.kind}`}>{LABELS[reference.kind].slice(0, 1)}</span>
                            <strong>{reference.tag}</strong>
                            <small>{reference.name}</small>
                          </button>
                        )) : <div className="mention-empty">{item.references?.length ? "没有匹配的参考素材" : "请先为本节添加参考素材"}</div>}
                      </div>
                    )}
                  </div>
                  <div className="batch-mention-help">输入 @ 选择本节素材，也可点击下方素材名称插入引用。</div>
                  <div className="batch-reference-list">{(item.references || []).map((reference) => (
                    <span key={reference.id} className={reference.kind}>
                      <button
                        type="button"
                        className="batch-reference-insert"
                        title={reference.noAutoMention ? "人物/场景模块外的参考，不自动@；点击可手动插入引用" : "在提示词光标处插入素材引用"}
                        aria-label={`引用素材 ${reference.name}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseMention(item.id, reference)}
                      >{reference.noAutoMention ? "" : `${reference.tag} `}{reference.name}{reference.source === "manual" ? "（手动）" : ""}{reference.noAutoMention ? "（模块外参考，未自动@）" : ""}</button>
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
                    <button disabled={!!busy || !canBatchMatch(item)} onClick={() => matchOne(item.id)}>本节一键参考</button>
                    <label className="secondary-button file-button">手动添加素材<input type="file" multiple hidden accept="image/*,audio/*,video/*,.mov,.mp4" onChange={(event) => { addManualFiles(item.id, event.target.files); event.target.value = ""; }} /></label>
                    <button disabled={!!busy || !!issue || item.deferred} onClick={() => submitSelected([item], canBatchResubmit(item), canBatchResubmit(item))}>{canBatchResubmit(item) ? "用当前模型重新生成本节" : "开始生成本节"}</button>
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
      {pagination}
    </div>
  );
}
