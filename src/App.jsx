import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PROFILES,
  FALLBACK_MODEL_LABELS,
  FALLBACK_MODELS,
  capabilityFor,
  inferAdapter,
  migrateSavedProfile,
  modelForSdVersion,
  pollDelayForAdapter,
  preferredDurationForVersion,
  sdVersionForProfile,
} from "./providerCatalog.js";
import {
  fileStem,
  internalizeProjectAliases,
  planProjectReferences,
} from "./projectReferences.js";
import {
  allTasks,
  getFailedTasks,
  getPendingTasks,
  listTasks,
  markTaskDownloaded,
  projectNames as getTaskProjectNames,
  putPolledTaskUpdates,
  putTask,
  putTasks,
  removeTask as removeStoredTask,
  removeTasks as removeStoredTasks,
} from "./taskStore.js";
import {
  clearCredentials,
  readCredentials,
  saveCredentials,
} from "./credentialStore.js";
import { normalizeApiKey } from "./apiKey.js";
import { normalizedTaskProgress } from "./taskProgress.js";
import { downloadTaskBuckets, orderedDownloadFilename } from "./taskDownload.js";
import { taskContentRequestUrl } from "./taskContent.js";
import { syncAudioForProfile, withSyncAudioPreference } from "./syncAudioPreference.js";
import { loadFixedContentByVersion, withFixedContentForVersion } from "./fixedContentStore.js";
import { reusableAssetFor, taskReuseSnapshot } from "./taskReuse.js";
import { regeneratedTaskRecord, reviewedTask } from "./taskRegeneration.js";
import {
  filesFromProjectDirectory,
  loadProjectDirectory,
  projectDirectoryPermission,
  saveProjectDirectory,
} from "./projectFolderStore.js";
import BatchPanel from "./BatchPanel.jsx";
import CostDashboard from "./CostDashboard.jsx";
import TaskProjectManager from "./TaskProjectManager.jsx";
import ImageWorkbench from "./ImageWorkbench.jsx";
import {
  UNCLASSIFIED_PROJECT,
  addTaskProject,
  assignTasksToProject,
  loadActiveTaskProject,
  loadTaskProjects,
  saveTaskProjects,
} from "./taskProjects.js";
import {
  clearDiagnostics,
  diagnosticHeaders,
  exportDiagnostics,
  recordDiagnostic,
} from "./diagnostics.js";

const PROFILE_KEY = "video-workbench-profiles-v2";
const ACTIVE_KEY = "video-workbench-active-profile-v2";
const TASK_KEY = "video-workbench-tasks-v2";
const FIXED_CONTENT_KEY = "video-workbench-fixed-content-v1";
const FIXED_CONTENT_BY_VERSION_KEY = "video-workbench-fixed-content-by-version-v2";
const SYNC_AUDIO_PREFERENCES_KEY = "video-workbench-sync-audio-v1";
const PAGE_SIZE = 10;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const REFERENCE_LIMITS = { image: 30, audio: 10, video: 10 };
const KIND_LABELS = { image: "图片", audio: "音频", video: "视频" };
const TRANSIENT_NETWORK_STATUSES = new Set([408, 425, 429, 433, 500, 502, 503, 504, 520, 522, 523, 524]);
const DEFAULT_PROMPT = `生成一个电影感短视频，动作自然连贯，人物外形与服装保持一致，画面清晰。

参考素材规则：
@Image1 是主角或主体参考。
@Image2 是场景环境参考。
@Audio1 是音频或节奏参考。
@Video1 是动作或运镜参考。`;

function loadJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function uid(prefix = "item") {
  return globalThis.crypto?.randomUUID?.() || `${prefix}_${Date.now()}_${Math.random()}`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function kindFromFile(file) {
  const name = file.name.toLowerCase();
  if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/.test(name))
    return "image";
  if (file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg)$/.test(name))
    return "audio";
  if (file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/.test(name))
    return "video";
  return null;
}

function kindFromUrl(url, preferred) {
  if (preferred) return preferred;
  const path = url.toLowerCase().split("?")[0];
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/.test(path)) return "audio";
  if (/\.(mp4|mov|webm|mkv)$/.test(path)) return "video";
  return "image";
}

function readMediaDuration(source, kind) {
  if (kind !== "audio" && kind !== "video") return Promise.resolve(null);
  return new Promise((resolve) => {
    const media = document.createElement(kind);
    const objectUrl = source instanceof File ? URL.createObjectURL(source) : "";
    const finish = (value) => {
      window.clearTimeout(timer);
      media.removeAttribute("src");
      media.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(Number.isFinite(value) && value > 0 ? Math.ceil(value) : null);
    };
    const timer = window.setTimeout(() => finish(null), 10000);
    media.preload = "metadata";
    media.onloadedmetadata = () => finish(media.duration);
    media.onerror = () => finish(null);
    media.src = objectUrl || source;
  });
}

function modelLabel(profile, model) {
  return profile?.routeLabels?.[model] || FALLBACK_MODEL_LABELS[profile?.adapter]?.[model] || model;
}

function reindexReferences(items) {
  const counts = { image: 0, audio: 0, video: 0 };
  return items.map((item) => {
    counts[item.kind] += 1;
    const label = item.kind[0].toUpperCase() + item.kind.slice(1);
    return { ...item, tag: `@${label}${counts[item.kind]}` };
  });
}

function visibleReferenceTag(item) {
  return item.alias ? `@${item.alias}` : item.tag;
}

function normalizeModels(payload, adapter) {
  const raw = Array.isArray(payload?.models) ? payload.models : [];
  const values = raw
    .map((model) => (typeof model === "string" ? model : model?.id || model?.name))
    .filter(Boolean);
  if (adapter === "lwaigc" && Array.isArray(payload?.models)) {
    return [...new Set([...FALLBACK_MODELS.lwaigc.slice(0, 2), ...values])];
  }
  return values.length ? values : FALLBACK_MODELS[adapter] || [];
}

function statusLabel(status) {
  return {
    queued: "排队中",
    processing: "生成中",
    completed: "已完成",
    failed: "失败",
  }[status] || status;
}

export default function App() {
  const [authStatus, setAuthStatus] = useState("checking");
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [generationMode, setGenerationMode] = useState(() => localStorage.getItem("ai-workbench-generation-mode-v1") || "video");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session")
      .then((response) => {
        if (!cancelled) setAuthStatus(response.ok ? "authenticated" : "anonymous");
      })
      .catch(() => {
        if (!cancelled) {
          setAuthStatus("anonymous");
          setLoginError("无法连接工作台服务，请稍后重试");
        }
      });
    return () => { cancelled = true; };
  }, []);

  async function submitLogin(event) {
    event.preventDefault();
    if (!loginName.trim() || !loginPassword) {
      setLoginError("请输入用户名和密码");
      return;
    }
    setLoggingIn(true);
    setLoginError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginName.trim(), password: loginPassword }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || "登录失败");
      setLoginPassword("");
      setAuthStatus("authenticated");
    } catch (error) {
      setLoginError(error.message || "登录失败");
    } finally {
      setLoggingIn(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setAuthStatus("anonymous");
    setLoginPassword("");
  }

  if (authStatus !== "authenticated") {
    return (
      <main className="login-shell">
        <form className="login-card" onSubmit={submitLogin}>
          <div className="login-brand">影</div>
          <span>PRIVATE WORKSPACE</span>
          <h1>AI 视频生成工作台</h1>
          <p>{authStatus === "checking" ? "正在验证登录状态…" : "请输入工作台账号后继续"}</p>
          <label><span>用户名</span><input autoComplete="username" value={loginName} onChange={(event) => setLoginName(event.target.value)} disabled={authStatus === "checking" || loggingIn} /></label>
          <label><span>密码</span><input type="password" autoComplete="current-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} disabled={authStatus === "checking" || loggingIn} /></label>
          {loginError && <div className="login-error" role="alert">{loginError}</div>}
          <button className="primary-button" type="submit" disabled={authStatus === "checking" || loggingIn}>{loggingIn ? "登录中…" : "登录工作台"}</button>
          <small>此工作台不开放注册</small>
        </form>
      </main>
    );
  }

  const switchGenerationMode = (mode) => {
    localStorage.setItem("ai-workbench-generation-mode-v1", mode);
    setGenerationMode(mode);
  };
  return generationMode === "image"
    ? <ImageWorkbench onVideoMode={() => switchGenerationMode("video")} onLogout={logout} />
    : <Workbench onImageMode={() => switchGenerationMode("image")} onLogout={logout} />;
}

function Workbench({ onImageMode, onLogout }) {
  const [workMode, setWorkMode] = useState(() => localStorage.getItem("video-workbench-mode-v1") || "single");
  const [profiles, setProfiles] = useState(() => {
    const saved = loadJson(PROFILE_KEY, null);
    if (!Array.isArray(saved) || !saved.length) return DEFAULT_PROFILES;
    const migratedSaved = saved.map(migrateSavedProfile);
    const missingBuiltIns = DEFAULT_PROFILES.filter(
      (builtIn) => !migratedSaved.some((profile) => profile.id === builtIn.id || profile.baseUrl === builtIn.baseUrl),
    );
    return [...missingBuiltIns, ...migratedSaved];
  });
  const [activeId, setActiveId] = useState(
    () => localStorage.getItem(ACTIVE_KEY) || profiles[0].id,
  );
  const [tasks, setTasks] = useState([]);
  const [taskDatabaseReady, setTaskDatabaseReady] = useState(false);
  const [taskRefreshVersion, setTaskRefreshVersion] = useState(0);
  const [taskStatusFilter, setTaskStatusFilter] = useState("all");
  const [taskProjectFilter, setTaskProjectFilter] = useState("all");
  const [taskProjectOptions, setTaskProjectOptions] = useState([]);
  const [taskProjects, setTaskProjects] = useState(loadTaskProjects);
  const [activeTaskProject, setActiveTaskProject] = useState(loadActiveTaskProject);
  const [selectedTaskIds, setSelectedTaskIds] = useState([]);
  const [selectedTargetProject, setSelectedTargetProject] = useState(loadActiveTaskProject);
  const [taskQuery, setTaskQuery] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [fixedContentByVersion, setFixedContentByVersion] = useState(() => {
    const initialProfile = profiles.find((profile) => profile.id === activeId) || profiles[0];
    return loadFixedContentByVersion(
      loadJson(FIXED_CONTENT_BY_VERSION_KEY, null),
      localStorage.getItem(FIXED_CONTENT_KEY) || "",
      sdVersionForProfile(initialProfile),
    );
  });
  const [projectName, setProjectName] = useState("");
  const [projectAssets, setProjectAssets] = useState([]);
  const [projectDirectoryHandle, setProjectDirectoryHandle] = useState(null);
  const [projectNeedsPermission, setProjectNeedsPermission] = useState(false);
  const [references, setReferences] = useState([]);
  const [duration, setDuration] = useState(15);
  const [resolution, setResolution] = useState("720p");
  const [ratio, setRatio] = useState("16:9");
  const [seed, setSeed] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [syncAudioPreferences, setSyncAudioPreferences] = useState(
    () => loadJson(SYNC_AUDIO_PREFERENCES_KEY, {}),
  );
  const [autoReference, setAutoReference] = useState(true);
  const [notice, setNotice] = useState("请选择中转站并完成 API 配置");
  const [submitting, setSubmitting] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
  const [taskProjectOpen, setTaskProjectOpen] = useState(false);
  const [draft, setDraft] = useState(profiles[0]);
  const [draftKey, setDraftKey] = useState("");
  const [draftUploadKey, setDraftUploadKey] = useState("");
  const [rememberKey, setRememberKey] = useState(false);
  const [modelOptions, setModelOptions] = useState({});
  const [configStatus, setConfigStatus] = useState("填写配置后测试连接");
  const [testing, setTesting] = useState(false);
  const [diagnosticBusy, setDiagnosticBusy] = useState("");
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [urlKind, setUrlKind] = useState("image");
  const [page, setPage] = useState(1);
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [expandedBatchId, setExpandedBatchId] = useState(null);
  const [downloadingBatchId, setDownloadingBatchId] = useState(null);
  const [regeneratingTaskId, setRegeneratingTaskId] = useState(null);
  const [videoBlob, setVideoBlob] = useState(null);
  const [mention, setMention] = useState(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const fileInput = useRef(null);
  const taskBackupInput = useRef(null);
  const projectFolderInput = useRef(null);
  const promptInput = useRef(null);
  const profilesRef = useRef(profiles);
  const pollingRef = useRef(false);
  const deletedTaskIdsRef = useRef(new Set());

  const activeProfile =
    profiles.find((profile) => profile.id === activeId) || profiles[0];
  const capability = useMemo(() => capabilityFor(activeProfile), [activeProfile]);
  const syncAudio = syncAudioForProfile(syncAudioPreferences, activeProfile.id);

  function setSyncAudio(nextValue) {
    setSyncAudioPreferences((current) => (
      withSyncAudioPreference(current, activeProfile.id, nextValue)
    ));
  }
  const sdVersion = sdVersionForProfile(activeProfile);
  const fixedContent = fixedContentByVersion[sdVersion] || "";
  function setFixedContent(value) {
    setFixedContentByVersion((current) => withFixedContentForVersion(current, sdVersion, value));
  }
  const availableActiveModels = modelOptions[activeProfile.id];
  const sdVersionAvailability = {
    sd20: modelForSdVersion(activeProfile, "sd20", availableActiveModels),
    sd25: modelForSdVersion(activeProfile, "sd25", availableActiveModels),
  };
  const numericDurations = capability.durations.filter((value) => typeof value === "number");
  const maximumDurationLabel = numericDurations.length ? `${Math.max(...numericDurations)}秒` : "自动时长";
  const totalReferenceBytes = references.reduce(
    (total, item) => total + (item.file?.size || 0),
    0,
  );
  const referenceCounts = references.reduce(
    (counts, item) => ({ ...counts, [item.kind]: counts[item.kind] + 1 }),
    { image: 0, audio: 0, video: 0 },
  );
  const taskEntries = useMemo(() => {
    const entries = [];
    const batches = new Map();
    for (const task of tasks) {
      if (!task.batchId) {
        entries.push({ type: "task", id: task.id, createdAtMs: task.createdAtMs || 0, task });
        continue;
      }
      if (!batches.has(task.batchId)) {
        const entry = { type: "batch", id: task.batchId, createdAtMs: task.createdAtMs || 0, tasks: [], title: task.batchTitle || "批量生成任务" };
        batches.set(task.batchId, entry);
        entries.push(entry);
      }
      const batch = batches.get(task.batchId);
      batch.tasks.push(task);
      batch.createdAtMs = Math.max(batch.createdAtMs, task.createdAtMs || 0);
    }
    for (const batch of batches.values()) {
      batch.tasks.sort((a, b) => (a.batchOrder ?? a.batchSection ?? 0) - (b.batchOrder ?? b.batchSection ?? 0));
    }
    return entries.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }, [tasks]);
  const taskCount = taskEntries.length;
  const availableTaskProjectOptions = useMemo(
    () => [...new Set([...taskProjects, ...taskProjectOptions, UNCLASSIFIED_PROJECT])],
    [taskProjects, taskProjectOptions],
  );
  const pageCount = Math.max(1, Math.ceil(taskCount / PAGE_SIZE));
  const visibleEntries = taskEntries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const visibleTaskIds = visibleEntries.flatMap((entry) => entry.type === "batch"
    ? entry.tasks.map((task) => task.id)
    : [entry.task.id]);
  const allVisibleTasksSelected = visibleTaskIds.length > 0
    && visibleTaskIds.every((id) => selectedTaskIds.includes(id));
  const mentionSuggestions = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    return references.filter((item) =>
      !query ||
      item.tag.slice(1).toLowerCase().includes(query) ||
      (item.alias || "").toLowerCase().includes(query) ||
      item.name.toLowerCase().includes(query),
    );
  }, [mention, references]);

  useEffect(() => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles));
    profilesRef.current = profiles;
  }, [profiles]);
  useEffect(() => localStorage.setItem(ACTIVE_KEY, activeId), [activeId]);
  useEffect(() => {
    localStorage.setItem(FIXED_CONTENT_BY_VERSION_KEY, JSON.stringify(fixedContentByVersion));
    localStorage.removeItem(FIXED_CONTENT_KEY);
  }, [fixedContentByVersion]);
  useEffect(() => {
    localStorage.setItem(SYNC_AUDIO_PREFERENCES_KEY, JSON.stringify(syncAudioPreferences));
  }, [syncAudioPreferences]);
  useEffect(() => localStorage.setItem("video-workbench-mode-v1", workMode), [workMode]);
  useEffect(() => {
    saveTaskProjects(taskProjects, activeTaskProject);
  }, [taskProjects, activeTaskProject]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const handle = await loadProjectDirectory();
        if (!cancelled && handle) await openRememberedProject(handle, false);
      } catch (error) {
        if (!cancelled) setNotice(`恢复已保存项目失败：${error.message}`);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => () => {
    if (videoBlob?.url) URL.revokeObjectURL(videoBlob.url);
  }, [videoBlob]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const legacyTasks = loadJson(TASK_KEY, []);
        if (Array.isArray(legacyTasks) && legacyTasks.length) {
          await putTasks(legacyTasks);
          localStorage.removeItem(TASK_KEY);
        }
        if (!cancelled) setTaskDatabaseReady(true);
      } catch (error) {
        if (!cancelled) setNotice(error.message || "浏览器任务数据库初始化失败");
      }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!taskDatabaseReady) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const result = await listTasks({
          page: 1,
          pageSize: 100000,
          status: taskStatusFilter,
          query: taskQuery,
          projectName: taskProjectFilter,
        });
        const names = await getTaskProjectNames();
        if (!cancelled) {
          setTasks(result.items);
          setTaskProjectOptions(names);
        }
      } catch (error) {
        if (!cancelled) setNotice(error.message || "读取任务列表失败");
      }
    })();
    return () => { cancelled = true; };
  }, [taskDatabaseReady, taskRefreshVersion, taskStatusFilter, taskProjectFilter, taskQuery]);
  useEffect(() => {
    setPage(1);
    setExpandedTaskId(null);
    setExpandedBatchId(null);
    setSelectedTaskIds([]);
  }, [taskStatusFilter, taskProjectFilter, taskQuery]);
  useEffect(() => {
    setExpandedTaskId(null);
    setExpandedBatchId(null);
    setVideoBlob(null);
    setSelectedTaskIds([]);
  }, [page]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  useEffect(() => {
    setDuration(preferredDurationForVersion(capability, sdVersion));
    if (!capability.resolutions.includes(resolution))
      setResolution(capability.resolutions[0]);
    if (!capability.ratios.includes(ratio)) setRatio(capability.ratios[0]);
  }, [activeProfile.id, activeProfile.model]);

  function keyFor(profile) {
    return readCredentials(profile.id).apiKey;
  }

  function mediaKeyFor(profile) {
    return readCredentials(profile.id).mediaKey;
  }

  function switchSdVersion(version) {
    const model = sdVersionAvailability[version];
    if (!model) {
      setNotice(`当前中转站 ${activeProfile.name} 没有配置 ${version === "sd25" ? "SD2.5" : "SD2.0"} 模型`);
      return;
    }
    if (Array.isArray(availableActiveModels) && !availableActiveModels.includes(model)) {
      setNotice(`当前 API Key 没有 ${model} 的调用权限，请在中转站管理中重新读取模型`);
      return;
    }
    setProfiles((current) => current.map((profile) => (
      profile.id === activeProfile.id ? { ...profile, model } : profile
    )));
    const nextCapability = capabilityFor({ ...activeProfile, model });
    const exceeded = Object.keys(REFERENCE_LIMITS).filter(
      (kind) => referenceCounts[kind] > (nextCapability[`${kind}s`] ?? 0),
    );
    const label = version === "sd25" ? "SD2.5（30图 / 10音频 / 10视频 / 最长30秒）" : "SD2.0（9图 / 3音频 / 3视频 / 最长15秒）";
    const warning = exceeded.length
      ? `；已有素材超限：${exceeded.map((kind) => `${KIND_LABELS[kind]} ${referenceCounts[kind]}/${nextCapability[`${kind}s`]}`).join("、")}，请删除标红的超额素材后提交`
      : "";
    setNotice(`已切换到 ${label}，当前模型：${model}${warning}`);
  }

  function headersFor(profile, explicitKey) {
    return {
      ...diagnosticHeaders(),
      "x-api-base-url": profile.baseUrl.trim(),
      "x-api-key": normalizeApiKey(explicitKey ?? keyFor(profile)),
      // HTTP 请求头只允许 Latin-1；中文模型名先编码，服务端再还原。
      "x-api-model": encodeURIComponent(profile.model.trim()),
      "x-api-adapter": profile.adapter,
      "x-media-upload-url": (profile.mediaUploadUrl || "").trim(),
      "x-media-upload-key":
        mediaKeyFor(profile) ||
        normalizeApiKey(explicitKey ?? keyFor(profile)),
    };
  }

  async function downloadDiagnostics() {
    setDiagnosticBusy("exporting");
    try {
      const result = await exportDiagnostics(activeProfile);
      setNotice(`已仅导出当前中转 ${activeProfile.name} 的诊断日志：${result.filename}（${result.count} 条记录）；不包含其他中转`);
    } catch (error) {
      if (error?.name !== "AbortError") setNotice(error.message || "导出诊断日志失败");
    } finally {
      setDiagnosticBusy("");
    }
  }

  async function resetDiagnostics() {
    if (!window.confirm(`确定清空本次浏览器会话中 ${activeProfile.name} 的诊断日志吗？\n建议先导出保存。`)) return;
    setDiagnosticBusy("clearing");
    try {
      await clearDiagnostics(activeProfile);
      setNotice(`已清空 ${activeProfile.name} 的本次诊断日志，可以开始一轮全新测试`);
    } catch (error) {
      setNotice(error.message || "清空诊断日志失败");
    } finally {
      setDiagnosticBusy("");
    }
  }

  useEffect(() => {
    if (!taskDatabaseReady) return undefined;
    const interval = window.setInterval(async () => {
      if (pollingRef.current) return;
      const activePending = await getPendingTasks(10).catch(() => []);
      const failedCandidates = activePending.length < 10
        ? await getFailedTasks(50).catch(() => [])
        : [];
      const recoverableMeaicc = failedCandidates.filter((task) => {
        const profile = profilesRef.current.find((item) => item.id === task.profileId);
        const genericFailure = /^(视频生成失败|video generation failed)$/i.test(String(task.error || "").trim());
        return profile?.adapter === "meaicc"
          && genericFailure
          && Number(task.meaiccFailureChecks || 0) < 30;
      });
      const pending = [...activePending, ...recoverableMeaicc].slice(0, 10);
      if (!pending.length) return;
      pollingRef.current = true;
      try {
        const updates = await Promise.all(
          pending.map(async (task) => {
            const profile = profilesRef.current.find((item) => item.id === task.profileId);
            if (!profile || !keyFor(profile)) return null;
            if (Number(task.nextPollAt) > Date.now()) return null;
            const nextPollAt = Date.now() + pollDelayForAdapter(profile.adapter);
            try {
              const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
                headers: {
                  ...headersFor(profile),
                  ...diagnosticHeaders({
                    requestId: task.diagnosticRequestId,
                    batchId: task.batchId,
                    section: task.batchSection,
                    sequence: task.submissionSequence,
                  }),
                },
              });
              const body = await response.json().catch(() => ({}));
              if (response.ok) {
                const genericMeaiccFailure = profile.adapter === "meaicc"
                  && body.status === "failed"
                  && /^(视频生成失败|video generation failed)$/i.test(String(body.error || "").trim());
                if (genericMeaiccFailure) {
                  const checks = Number(task.meaiccFailureChecks || 0) + 1;
                  if (checks < 30) {
                    return {
                      id: task.id,
                      status: "processing",
                      progress: Math.max(Number(task.progress || 0), 30),
                      error: "",
                      meaiccFailureChecks: checks,
                      nextPollAt,
                      networkWarning: `MEAICC 暂时返回了无原因失败，工作台正在自动复核（${checks}/30）`,
                    };
                  }
                  return { ...body, meaiccFailureChecks: checks, networkWarning: "", nextPollAt };
                }
                return { ...body, meaiccFailureChecks: 0, networkWarning: "", nextPollAt };
              }
              if (TRANSIENT_NETWORK_STATUSES.has(response.status)) {
                return {
                  id: task.id,
                  transient: true,
                  nextPollAt,
                  networkWarning: `网络暂时不稳定（HTTP ${response.status}），任务仍在保留并会自动重试`,
                };
              }
              if (response.status === 409 && /另一把 API Key/.test(String(body.message || ""))) {
                return {
                  id: task.id,
                  nextPollAt,
                  networkWarning: body.message,
                };
              }
              return { id: task.id, status: "failed", error: body.message };
            } catch {
              return {
                id: task.id,
                transient: true,
                nextPollAt,
                networkWarning: "网络暂时不可用，任务仍在保留并会自动重试",
              };
            }
          }),
        );
        const changed = pending
          .map((task) => {
            if (deletedTaskIdsRef.current.has(task.id)) return null;
            const update = updates.find((item) => item?.id === task.id);
            if (!update) return null;
            if (update.transient) {
              return { ...task, nextPollAt: update.nextPollAt, networkWarning: update.networkWarning };
            }
            return { ...task, ...update, networkWarning: "", title: task.title, profileId: task.profileId };
          })
          .filter(Boolean);
        if (changed.length) {
          await putPolledTaskUpdates(changed);
          setTaskRefreshVersion((value) => value + 1);
        }
      } finally {
        pollingRef.current = false;
      }
    }, 5000);
    return () => window.clearInterval(interval);
  }, [taskDatabaseReady]);

  function openConfig(profile = activeProfile) {
    const credentials = readCredentials(profile.id);
    setDraft({ ...profile });
    setDraftKey(credentials.apiKey);
    setDraftUploadKey(credentials.mediaKey);
    setRememberKey(credentials.remember);
    setConfigStatus("填写配置后测试连接");
    setConfigOpen(true);
  }

  function selectDraft(id) {
    const profile = profiles.find((item) => item.id === id);
    const credentials = readCredentials(profile.id);
    setDraft({ ...profile });
    setDraftKey(credentials.apiKey);
    setDraftUploadKey(credentials.mediaKey);
    setRememberKey(credentials.remember);
    setConfigStatus("填写配置后测试连接");
  }

  function createProfile() {
    const profile = {
      id: uid("api"),
      name: "新中转站",
      baseUrl: "https://",
      adapter: "newapi",
      model: "",
      mediaUploadUrl: "",
    };
    setDraft(profile);
    setDraftKey("");
    setDraftUploadKey("");
    setRememberKey(false);
    setConfigStatus("请填写新中转站配置");
  }

  function saveProfile(close = false) {
    try {
      const parsed = new URL(draft.baseUrl);
      if (parsed.protocol !== "https:") throw new Error("Base URL 必须使用 HTTPS");
      if (!draft.name.trim() || !draft.model.trim()) throw new Error("名称和模型不能为空");
      const saved = {
        ...draft,
        name: draft.name.trim(),
        baseUrl: parsed.origin,
        adapter: draft.adapter === "auto" ? inferAdapter(parsed.origin) : draft.adapter,
        model: draft.model.trim(),
      };
      setProfiles((current) => {
        const exists = current.some((item) => item.id === saved.id);
        return exists
          ? current.map((item) => (item.id === saved.id ? saved : item))
          : [...current, saved];
      });
      saveCredentials(saved.id, {
        apiKey: draftKey,
        mediaKey: draftUploadKey,
        remember: rememberKey,
      });
      setActiveId(saved.id);
      setDraft(saved);
      setNotice(`已切换到 ${saved.name} · ${saved.model}`);
      setConfigStatus("配置已保存");
      if (close) setConfigOpen(false);
    } catch (error) {
      setConfigStatus(error.message || "配置无效");
    }
  }

  function deleteProfile() {
    if (profiles.length === 1) {
      setConfigStatus("至少保留一个中转站配置");
      return;
    }
    const remaining = profiles.filter((item) => item.id !== draft.id);
    clearCredentials(draft.id);
    setProfiles(remaining);
    const next = remaining[0];
    const credentials = readCredentials(next.id);
    setActiveId(next.id);
    setDraft({ ...next });
    setDraftKey(credentials.apiKey);
    setDraftUploadKey(credentials.mediaKey);
    setRememberKey(credentials.remember);
  }

  async function testProfile() {
    if (!draftKey.trim()) {
      setConfigStatus("请填写 API Key");
      return;
    }
    setTesting(true);
    setConfigStatus("正在连接并读取模型…");
    try {
      const prepared = {
        ...draft,
        adapter: draft.adapter === "auto" ? inferAdapter(draft.baseUrl) : draft.adapter,
      };
      const response = await fetch("/api/config/models", {
        headers: headersFor(prepared, draftKey),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "连接失败");
      const models = normalizeModels(body, prepared.adapter);
      setModelOptions((current) => ({ ...current, [draft.id]: models }));
      setDraft((current) => ({
        ...current,
        adapter: prepared.adapter,
        model: models.includes(current.model) ? current.model : models[0] || current.model,
        routeCapabilities: body.capabilities || current.routeCapabilities,
        routeLabels: body.labels || current.routeLabels,
      }));
      setConfigStatus(
        prepared.adapter === "canseedream"
          ? `连接成功，读取到 ${models.length} 条当前开放线路`
          : `连接成功，读取到 ${models.length} 个模型`,
      );
    } catch (error) {
      setConfigStatus(
        error instanceof TypeError && /failed to fetch/i.test(error.message || "")
          ? "无法连接本地工作台服务，请双击桌面的“一键启动工作台”后再试"
          : error.message || "连接失败",
      );
    } finally {
      setTesting(false);
    }
  }

  function selectProjectFolder(fileList, explicitRootName = "") {
    const entries = Array.from(fileList || []);
    const assets = entries
      .map((entry) => {
        const file = entry?.file || entry;
        const relativePath = entry?.relativePath || file?.webkitRelativePath || file?.name;
        const kind = kindFromFile(file);
        if (!kind) return null;
        return {
          key: `${kind}:${relativePath}:${file.size}:${file.lastModified}`,
          file,
          kind,
          stem: fileStem(file.name),
          relativePath,
        };
      })
      .filter(Boolean);
    const firstFile = entries[0]?.file || entries[0];
    const rootName = explicitRootName || firstFile?.webkitRelativePath?.split("/")[0] || "已选项目";
    setProjectName(rootName);
    setProjectAssets(assets);
    const counts = assets.reduce(
      (value, asset) => ({ ...value, [asset.kind]: value[asset.kind] + 1 }),
      { image: 0, audio: 0, video: 0 },
    );
    setNotice(
      `项目“${rootName}”已读取：图片 ${counts.image}、音频 ${counts.audio}、视频 ${counts.video}。现在可以点击一键参考。`,
    );
  }

  async function openRememberedProject(handle, requestPermission = false) {
    const permission = await projectDirectoryPermission(handle, requestPermission);
    setProjectDirectoryHandle(handle);
    setProjectName(handle.name || "已保存项目");
    if (permission !== "granted") {
      setProjectNeedsPermission(true);
      setNotice(`已记住项目“${handle.name || "已保存项目"}”，点击“恢复项目”即可继续使用`);
      return false;
    }
    const files = await filesFromProjectDirectory(handle);
    setProjectNeedsPermission(false);
    selectProjectFolder(files, handle.name);
    return true;
  }

  async function chooseProjectFolder() {
    if (!window.showDirectoryPicker) {
      projectFolderInput.current?.click();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      await saveProjectDirectory(handle);
      await openRememberedProject(handle, true);
    } catch (error) {
      if (error?.name !== "AbortError") setNotice(`项目文件夹读取失败：${error.message}`);
    }
  }

  async function restoreProjectFolder() {
    try {
      await openRememberedProject(projectDirectoryHandle, true);
    } catch (error) {
      setNotice(`恢复项目文件夹失败：${error.message}`);
    }
  }

  async function runOneClickReference() {
    if (!projectAssets.length) {
      setNotice("请先选择一个包含图片和音频的项目文件夹");
      return;
    }
    if (!prompt.trim()) {
      setNotice("请先把完整提示词填入提示词框");
      return;
    }
    const plan = planProjectReferences(prompt, projectAssets);
    if (!plan.matches.length) {
      setNotice("项目内没有找到能与人物、背景或声线模块对应的素材，未做任何修改");
      return;
    }

    const selectedAssets = [...new Map(plan.matches.map((match) => [match.asset.key, match.asset])).values()];
    const durations = await Promise.all(
      selectedAssets.map((asset) => readMediaDuration(asset.file, asset.kind)),
    );
    const durationByKey = new Map(selectedAssets.map((asset, index) => [asset.key, durations[index]]));

    setReferences((current) => {
      let next = [...current];
      let bytes = next.reduce((total, item) => total + (item.file?.size || 0), 0);
      for (const asset of selectedAssets) {
        const existingIndex = next.findIndex(
          (item) => item.kind === asset.kind && item.file &&
            item.file.name === asset.file.name && item.file.size === asset.file.size &&
            item.file.lastModified === asset.file.lastModified,
        );
        if (existingIndex >= 0) {
          next[existingIndex] = { ...next[existingIndex], alias: asset.stem, projectAssetKey: asset.key };
          continue;
        }
        const used = next.filter((item) => item.kind === asset.kind).length;
        if (used >= (capability[`${asset.kind}s`] ?? 0) || next.length >= 50) continue;
        if (bytes + asset.file.size > MAX_TOTAL_BYTES) continue;
        bytes += asset.file.size;
        next.push({
          id: uid("ref"),
          kind: asset.kind,
          file: asset.file,
          name: asset.file.name,
          alias: asset.stem,
          projectAssetKey: asset.key,
          preview: URL.createObjectURL(asset.file),
          subType: "reference",
          durationSeconds: durationByKey.get(asset.key) || null,
        });
      }
      return reindexReferences(next);
    });
    setPrompt(plan.annotatedPrompt);

    const matchedCounts = plan.matches.reduce(
      (value, match) => ({ ...value, [match.role]: value[match.role] + 1 }),
      { people: 0, background: 0, voice: 0 },
    );
    const missingText = plan.missing.length
      ? `；${plan.missing.length} 项在项目内没有对应文件，已保持原文不动`
      : "";
    setNotice(
      `一键参考完成：人物图片 ${matchedCounts.people}、场景图片 ${matchedCounts.background}、声线音频 ${matchedCounts.voice}${missingText}。请检查后再手动开始生成。`,
    );
  }

  async function addFiles(fileList) {
    const incoming = Array.from(fileList);
    const durations = await Promise.all(
      incoming.map((file) => readMediaDuration(file, kindFromFile(file))),
    );
    let next = [...references];
    let bytes = totalReferenceBytes;
    const messages = [];
    for (const [fileIndex, file] of incoming.entries()) {
      const kind = kindFromFile(file);
      if (!kind) {
        messages.push(`${file.name} 格式不支持`);
        continue;
      }
      const limit = capability[`${kind}s`] ?? 0;
      const used = next.filter((item) => item.kind === kind).length;
      if (!limit || used >= limit || next.length >= 50) {
        messages.push(`${file.name} 超过${KIND_LABELS[kind]}素材数量限制`);
        continue;
      }
      if (bytes + file.size > MAX_TOTAL_BYTES) {
        messages.push(`${file.name} 加入后总大小超过 200 MB`);
        continue;
      }
      bytes += file.size;
      next.push({
        id: uid("ref"),
        kind,
        file,
        name: file.name,
        preview: URL.createObjectURL(file),
        subType: kind === "image" ? "reference" : "reference",
        durationSeconds: durations[fileIndex],
      });
    }
    next = reindexReferences(next);
    setReferences(next);
    const incompatible = next.filter(
      (item) => (capability[`${item.kind}s`] ?? 0) === 0,
    );
    setNotice(
      messages.length
        ? messages.join("；")
        : incompatible.length
          ? `素材已加入；当前模型不支持${[...new Set(incompatible.map((item) => KIND_LABELS[item.kind]))].join("、")}参考，请在提交前切换模型`
          : `已加入 ${incoming.length} 个素材`,
    );
  }

  async function addUrlReference() {
    try {
      const parsed = new URL(urlValue.trim());
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      const kind = kindFromUrl(parsed.href, urlKind);
      const durationSeconds = await readMediaDuration(parsed.href, kind);
      const limit = capability[`${kind}s`] ?? 0;
      if (!limit || references.filter((item) => item.kind === kind).length >= limit)
        throw new Error(`${KIND_LABELS[kind]}素材最多只能添加 ${limit} 个`);
      setReferences((current) =>
        reindexReferences([
          ...current,
          {
            id: uid("ref"),
            kind,
            url: parsed.href,
            name: parsed.pathname.split("/").pop() || `${kind} URL`,
            preview: parsed.href,
            subType: "reference",
            durationSeconds,
          },
        ]),
      );
      setUrlValue("");
      setUrlOpen(false);
      setNotice(
        (capability[`${kind}s`] ?? 0) > 0
          ? "素材网址已加入"
          : `素材已加入，但当前模型不支持${KIND_LABELS[kind]}参考；请在提交前切换到支持该素材的模型`,
      );
    } catch (error) {
      setNotice(error.message || "请输入有效的 HTTP(S) 素材地址");
    }
  }

  function removeReference(id) {
    setReferences((current) => {
      const target = current.find((item) => item.id === id);
      if (target?.file && target.preview) URL.revokeObjectURL(target.preview);
      return reindexReferences(current.filter((item) => item.id !== id));
    });
  }

  function clearReferences() {
    references.forEach((item) => item.file && item.preview && URL.revokeObjectURL(item.preview));
    setReferences([]);
  }

  function insertionText(item) {
    return item.alias ? `${visibleReferenceTag(item)}=${item.alias}` : item.tag;
  }

  function insertTag(item) {
    const text = insertionText(item);
    setPrompt((value) => `${value}${value.endsWith(" ") || value.endsWith("\n") ? "" : " "}${text} `);
  }

  function updateMention(value, cursor) {
    const beforeCursor = value.slice(0, cursor);
    const match = beforeCursor.match(/@([^\s@]*)$/);
    if (!match) {
      setMention(null);
      return;
    }
    setMention({ start: cursor - match[0].length, query: match[1] });
    setMentionIndex(0);
  }

  function handlePromptChange(event) {
    const value = event.target.value;
    const cursor = event.target.selectionStart ?? value.length;
    setPrompt(value);
    updateMention(value, cursor);
  }

  function chooseMention(item) {
    const input = promptInput.current;
    const cursor = input?.selectionStart ?? prompt.length;
    const end = input?.selectionEnd ?? cursor;
    const start = mention?.start ?? cursor;
    const text = insertionText(item);
    const next = `${prompt.slice(0, start)}${text} ${prompt.slice(end)}`;
    const nextCursor = start + text.length + 1;
    setPrompt(next);
    setMention(null);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function handlePromptKeyDown(event) {
    if (!mention || !mentionSuggestions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionIndex((value) => (value + 1) % mentionSuggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionIndex((value) => (value - 1 + mentionSuggestions.length) % mentionSuggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      chooseMention(mentionSuggestions[mentionIndex] || mentionSuggestions[0]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setMention(null);
    }
  }

  async function submitTask() {
    const apiKey = keyFor(activeProfile);
    if (!apiKey) {
      setNotice("请先配置当前中转站的 API Key");
      openConfig();
      return;
    }
    const translatedPrompt = internalizeProjectAliases(prompt.trim(), references);
    const submittedPrompt = [fixedContent.trim(), translatedPrompt].filter(Boolean).join("\n\n");
    if (!submittedPrompt) {
      setNotice("提示词不能为空");
      return;
    }
    const unsupported = Object.keys(REFERENCE_LIMITS).filter(
      (kind) => referenceCounts[kind] > (capability[`${kind}s`] ?? 0),
    );
    if (unsupported.length) {
      setNotice(
        `当前模型 ${activeProfile.model} 不支持这些素材数量：${unsupported
          .map((kind) => `${KIND_LABELS[kind]} ${referenceCounts[kind]} 个（最多 ${capability[`${kind}s`] ?? 0} 个）`)
          .join("；")}。音视频参考可切换到 Paipu Seedance 多模态模型或 ViralE Viraldance。`,
      );
      return;
    }
    if (activeProfile.adapter === "meaicc") {
      const inputVideoSeconds = references
        .filter((item) => item.kind === "video")
        .reduce((total, item) => total + (Number(item.durationSeconds) || 0), 0);
      if (inputVideoSeconds + Number(duration) > 25) {
        setNotice(`MEAICC 要求输入视频与输出视频总时长不超过 25 秒；当前为 ${inputVideoSeconds + Number(duration)} 秒`);
        return;
      }
    }
    setSubmitting(true);
    const hasLocalMaterials = references.some((item) => item.file);
    setNotice(
      hasLocalMaterials && !activeProfile.mediaUploadUrl
        ? "正在自动把本地素材转成临时 HTTPS 地址并创建任务…"
        : "正在上传参考素材并创建任务…",
    );
    const requestId = uid("single-submit");
    const submitStartedAt = performance.now();
    recordDiagnostic({
      adapter: activeProfile.adapter,
      providerName: activeProfile.name,
      model: activeProfile.model,
      requestId,
      stage: "client_task_submit_started",
      referenceCount: references.length,
      localFileCount: references.filter((item) => item.file).length,
      mode: "single",
    });
    try {
      const form = new FormData();
      form.set("prompt", submittedPrompt);
      form.set("duration", String(duration));
      form.set("resolution", resolution);
      form.set("aspectRatio", ratio);
      form.set("seed", seed);
      form.set("quantity", String(quantity));
      form.set("syncAudio", String(syncAudio));
      form.set("autoReference", String(autoReference));
      let fileIndex = 0;
      const referenceMeta = references.map((item) => {
        const meta = {
          tag: item.tag,
          kind: item.kind,
          name: item.name,
          subType: item.subType || "reference",
          durationSeconds: item.durationSeconds || null,
          url: item.url || "",
          fileIndex: item.file ? fileIndex++ : null,
        };
        if (item.file) form.append("references", item.file, item.file.name);
        return meta;
      });
      form.set("referenceMeta", JSON.stringify(referenceMeta));
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { ...headersFor(activeProfile), ...diagnosticHeaders({ requestId }) },
        body: form,
      });
      const body = await response.json().catch(() => ({}));
      recordDiagnostic({
        adapter: activeProfile.adapter,
        providerName: activeProfile.name,
        model: activeProfile.model,
        requestId,
        stage: response.ok ? "client_task_submit_completed" : "client_task_submit_failed",
        durationMs: Math.round(performance.now() - submitStartedAt),
        status: response.status,
        taskCount: body.tasks?.length || 0,
        submissionUnknown: Boolean(body.submissionUnknown || body.code === "SUBMISSION_UNKNOWN"),
        error: response.ok ? "" : body.message || "任务提交失败",
      });
      if (!response.ok) {
        const message = body.message || "任务提交失败";
        if (body.submissionUnknown || body.code === "SUBMISSION_UNKNOWN") {
          throw new Error(`${message} 请不要立即再次点击生成。`);
        }
        throw new Error(message);
      }
      const created = Array.isArray(body.tasks) ? body.tasks : [body];
      const createdAtMs = Date.now();
      const taskRecords = created.map((task, index) => ({
          ...task,
          profileId: activeProfile.id,
          providerName: activeProfile.name,
          model: activeProfile.model,
          title: `${activeProfile.model}-${createdAtMs}${created.length > 1 ? `-${index + 1}` : ""}`,
          prompt: submittedPrompt,
          reuseSnapshot: taskReuseSnapshot({
            prompt,
            references,
            duration,
            resolution,
            ratio,
            seed,
            quantity,
            syncAudio,
            autoReference,
          }),
          projectName: activeTaskProject || UNCLASSIFIED_PROJECT,
          assetProjectName: projectName || "",
          diagnosticRequestId: requestId,
          submitDurationMs: Math.round(performance.now() - submitStartedAt),
          createdAtMs: createdAtMs + index,
          nextPollAt: createdAtMs + pollDelayForAdapter(activeProfile.adapter),
        }));
      await putTasks(taskRecords);
      setPage(1);
      setTaskStatusFilter("all");
      setTaskProjectFilter("all");
      setTaskRefreshVersion((value) => value + 1);
      setNotice("任务提交成功，正在等待生成");
    } catch (error) {
      recordDiagnostic({
        adapter: activeProfile.adapter,
        providerName: activeProfile.name,
        model: activeProfile.model,
        requestId,
        stage: "client_task_submit_exception",
        durationMs: Math.round(performance.now() - submitStartedAt),
        error: error.message || "任务提交失败",
      });
      setNotice(error.message || "任务提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function loadVideo(task) {
    if (videoBlob?.taskId === task.id) return;
    const profile = profiles.find((item) => item.id === task.profileId);
    if (!profile || !keyFor(profile)) {
      setNotice("需要重新填写该任务所属中转站的 API Key");
      return;
    }
    setNotice("正在读取视频…");
    try {
      const contentUrls = [taskContentRequestUrl(task), task.videoUrl].filter((url, index, values) => url && values.indexOf(url) === index);
      let response;
      for (const contentUrl of contentUrls) {
        response = await fetch(contentUrl, { headers: headersFor(profile) });
        if (response.ok) break;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || "读取视频失败");
      }
      const url = URL.createObjectURL(await response.blob());
      setVideoBlob({ taskId: task.id, url });
      setNotice("视频已加载");
    } catch (error) {
      setNotice(error.message || "读取视频失败");
    }
  }

  function selectFavoriteModel(profileId, model) {
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) {
      setNotice("这个常用模型所属的中转站配置已经不存在");
      return;
    }
    setProfiles((current) => current.map((item) => item.id === profileId ? { ...item, model } : item));
    setActiveId(profileId);
    setNotice(`已从常用模型切换到 ${profile.name} · ${model}`);
  }

  function createTaskProject(name) {
    const next = addTaskProject(taskProjects, name);
    const createdName = next[next.length - 1];
    setTaskProjects(next);
    setActiveTaskProject(createdName);
    setTaskProjectFilter(createdName);
    setNotice(`已新建并切换到任务项目“${createdName}”，之后提交的单条和批量任务都会归入该项目`);
  }

  function selectTaskProject(name) {
    const normalized = String(name || UNCLASSIFIED_PROJECT);
    setActiveTaskProject(normalized);
    setTaskProjectFilter(normalized);
    setNotice(`已切换到任务项目“${normalized}”，之后新提交的任务都会归入该项目`);
  }

  function toggleTaskSelection(taskId) {
    setSelectedTaskIds((current) => current.includes(taskId)
      ? current.filter((id) => id !== taskId)
      : [...current, taskId]);
  }

  function toggleTaskSelectionGroup(taskIds) {
    setSelectedTaskIds((current) => {
      const allSelected = taskIds.every((id) => current.includes(id));
      return allSelected
        ? current.filter((id) => !taskIds.includes(id))
        : [...new Set([...current, ...taskIds])];
    });
  }

  async function moveTasksToProject(taskIds, projectName) {
    const ids = [...new Set((taskIds || []).filter(Boolean))];
    if (!ids.length) {
      setNotice("请先勾选要归类的任务");
      return;
    }
    try {
      const updated = assignTasksToProject(tasks, ids, projectName);
      const changed = updated.filter((task) => ids.includes(task.id));
      if (!changed.length) throw new Error("当前列表中没有找到所选任务");
      await putTasks(changed);
      if (projectName !== UNCLASSIFIED_PROJECT && !taskProjects.includes(projectName))
        setTaskProjects((current) => [...current, projectName]);
      setSelectedTaskIds([]);
      setSelectedTargetProject(projectName);
      setTaskRefreshVersion((value) => value + 1);
      setNotice(`已将 ${changed.length} 条任务归入“${projectName}”，项目条数和预计成本已重新归类`);
    } catch (error) {
      setNotice(error.message || "任务项目调整失败");
    }
  }

  async function reuseFailedTask(task) {
    const snapshot = task.reuseSnapshot || {};
    const targetProfile = profiles.find((profile) => profile.id === task.profileId) || activeProfile;
    const targetModel = task.model || targetProfile.model;
    const targetVersion = sdVersionForProfile({ ...targetProfile, model: targetModel });
    const versionFixedContent = fixedContentByVersion[targetVersion] || "";
    let reusablePrompt = String(snapshot.prompt || task.prompt || "");
    if (!snapshot.prompt && versionFixedContent && reusablePrompt.startsWith(versionFixedContent)) {
      reusablePrompt = reusablePrompt.slice(versionFixedContent.length).replace(/^\s+/, "");
    }

    const restored = [];
    const missing = [];
    for (const [index, reference] of (snapshot.references || []).entries()) {
      const asset = reusableAssetFor(reference, projectAssets);
      if (asset?.file) {
        restored.push({
          id: uid("ref"),
          kind: reference.kind || asset.kind,
          file: asset.file,
          name: asset.file.name,
          alias: reference.alias || fileStem(asset.file.name),
          projectAssetKey: asset.key,
          preview: URL.createObjectURL(asset.file),
          subType: reference.subType || "reference",
          durationSeconds: reference.durationSeconds || await readMediaDuration(asset.file, reference.kind || asset.kind),
        });
      } else if (reference.url) {
        restored.push({
          id: uid("ref"),
          kind: reference.kind || kindFromUrl(reference.url, "image"),
          url: reference.url,
          name: reference.name || `素材 ${index + 1}`,
          alias: reference.alias || "",
          preview: reference.url,
          subType: reference.subType || "reference",
          durationSeconds: reference.durationSeconds || null,
        });
      } else {
        missing.push(reference.name || `素材 ${index + 1}`);
      }
    }

    // 旧任务是在“可复用快照”加入前创建的。只要当前项目仍然打开，
    // 就用原提示词再做一次精确项目匹配，让旧失败任务也尽量能一键复用。
    if (!snapshot.references && projectAssets.length) {
      const plan = planProjectReferences(reusablePrompt, projectAssets);
      const selectedAssets = [...new Map(plan.matches.map((match) => [match.asset.key, match.asset])).values()];
      const durations = await Promise.all(selectedAssets.map((asset) => readMediaDuration(asset.file, asset.kind)));
      selectedAssets.forEach((asset, index) => restored.push({
        id: uid("ref"),
        kind: asset.kind,
        file: asset.file,
        name: asset.file.name,
        alias: asset.stem,
        projectAssetKey: asset.key,
        preview: URL.createObjectURL(asset.file),
        subType: "reference",
        durationSeconds: durations[index] || null,
      }));
      if (plan.matches.length) reusablePrompt = plan.annotatedPrompt;
    }

    clearReferences();
    setReferences(reindexReferences(restored));
    setPrompt(reusablePrompt);
    if (snapshot.duration != null) setDuration(snapshot.duration);
    if (snapshot.resolution) setResolution(snapshot.resolution);
    if (snapshot.ratio) setRatio(snapshot.ratio);
    if (snapshot.seed != null) setSeed(snapshot.seed);
    if (snapshot.quantity != null) setQuantity(snapshot.quantity);
    if (snapshot.syncAudio != null) {
      setSyncAudioPreferences((current) => withSyncAudioPreference(current, targetProfile.id, snapshot.syncAudio));
    }
    if (snapshot.autoReference != null) setAutoReference(snapshot.autoReference);
    setProfiles((current) => current.map((profile) => (
      profile.id === targetProfile.id ? { ...profile, model: targetModel } : profile
    )));
    setActiveId(targetProfile.id);
    setWorkMode("single");
    window.scrollTo({ top: 0, behavior: "smooth" });
    setNotice(
      missing.length
        ? `已复用失败任务的提示词和 ${restored.length} 个素材；${missing.length} 个本地素材未在当前项目找到：${missing.join("、")}`
        : `已复用失败任务的提示词和 ${restored.length} 个参考素材，请检查后手动开始生成`,
    );
  }

  async function setTaskDissatisfied(task, dissatisfied) {
    const updated = reviewedTask(task, dissatisfied);
    await putTask(updated);
    setTaskRefreshVersion((value) => value + 1);
    setNotice(dissatisfied ? "已标记为不满意；可以按原参数重新生成，旧视频会保留" : "已取消不满意标记");
  }

  async function regenerateTask(task) {
    if (task.status !== "completed" || task.reviewStatus !== "dissatisfied") return;
    const targetProfile = profiles.find((profile) => profile.id === task.profileId);
    if (!targetProfile || !keyFor(targetProfile)) {
      setNotice("需要先补全该任务所属中转站的 API Key，原视频和不满意标记均已保留");
      if (targetProfile) {
        setDraft(targetProfile);
        setDraftKey(keyFor(targetProfile));
      }
      setConfigOpen(true);
      return;
    }

    const snapshot = task.reuseSnapshot || {};
    const targetModel = task.model || targetProfile.model;
    const submissionProfile = { ...targetProfile, model: targetModel };
    const targetCapability = capabilityFor(submissionProfile);
    const targetVersion = sdVersionForProfile(submissionProfile);
    const versionFixedContent = fixedContentByVersion[targetVersion] || "";
    let reusablePrompt = String(snapshot.prompt || task.prompt || "");
    if (!snapshot.prompt && versionFixedContent && reusablePrompt.startsWith(versionFixedContent)) {
      reusablePrompt = reusablePrompt.slice(versionFixedContent.length).replace(/^\s+/, "");
    }

    const restored = [];
    const missing = [];
    for (const [index, reference] of (snapshot.references || []).entries()) {
      const asset = reusableAssetFor(reference, projectAssets);
      if (asset?.file) {
        restored.push({
          id: uid("ref"),
          kind: reference.kind || asset.kind,
          file: asset.file,
          name: asset.file.name,
          alias: reference.alias || fileStem(asset.file.name),
          projectAssetKey: asset.key,
          subType: reference.subType || "reference",
          durationSeconds: reference.durationSeconds || await readMediaDuration(asset.file, reference.kind || asset.kind),
        });
      } else if (reference.url) {
        restored.push({
          id: uid("ref"),
          kind: reference.kind || kindFromUrl(reference.url, "image"),
          url: reference.url,
          name: reference.name || `素材 ${index + 1}`,
          alias: reference.alias || "",
          subType: reference.subType || "reference",
          durationSeconds: reference.durationSeconds || null,
        });
      } else {
        missing.push(reference.name || `素材 ${index + 1}`);
      }
    }

    if (!snapshot.references && projectAssets.length) {
      const plan = planProjectReferences(reusablePrompt, projectAssets);
      const selectedAssets = [...new Map(plan.matches.map((match) => [match.asset.key, match.asset])).values()];
      const durations = await Promise.all(selectedAssets.map((asset) => readMediaDuration(asset.file, asset.kind)));
      selectedAssets.forEach((asset, index) => restored.push({
        id: uid("ref"),
        kind: asset.kind,
        file: asset.file,
        name: asset.file.name,
        alias: asset.stem,
        projectAssetKey: asset.key,
        subType: "reference",
        durationSeconds: durations[index] || null,
      }));
      if (plan.matches.length) reusablePrompt = plan.annotatedPrompt;
    }

    if (missing.length) {
      setNotice(`原视频和不满意标记已保留。请重新打开原项目资产后再试，当前缺少：${missing.join("、")}`);
      return;
    }

    const restoredReferences = reindexReferences(restored);
    const counts = restoredReferences.reduce((result, item) => ({
      ...result,
      [item.kind]: (result[item.kind] || 0) + 1,
    }), {});
    const unsupported = Object.keys(REFERENCE_LIMITS).filter(
      (kind) => (counts[kind] || 0) > (targetCapability[`${kind}s`] ?? 0),
    );
    if (unsupported.length) {
      setNotice(`原模型 ${targetModel} 当前不支持原任务的素材数量：${unsupported.map((kind) => `${KIND_LABELS[kind]} ${counts[kind]} 个`).join("；")}`);
      return;
    }

    const targetDuration = snapshot.duration ?? task.duration ?? preferredDurationForVersion(targetCapability, targetVersion);
    const targetResolution = snapshot.resolution || task.resolution || targetCapability.resolutions[0];
    const targetRatio = snapshot.ratio || task.aspectRatio || targetCapability.ratios[0];
    const targetSeed = snapshot.seed ?? task.seed ?? "";
    const targetSyncAudio = snapshot.syncAudio ?? true;
    const targetAutoReference = snapshot.autoReference ?? true;
    if (submissionProfile.adapter === "meaicc") {
      const inputVideoSeconds = restoredReferences
        .filter((item) => item.kind === "video")
        .reduce((total, item) => total + (Number(item.durationSeconds) || 0), 0);
      if (inputVideoSeconds + Number(targetDuration) > 25) {
        setNotice(`MEAICC 要求输入视频与输出视频总时长不超过 25 秒；当前为 ${inputVideoSeconds + Number(targetDuration)} 秒`);
        return;
      }
    }

    const translatedPrompt = internalizeProjectAliases(reusablePrompt.trim(), restoredReferences);
    const submittedPrompt = [versionFixedContent.trim(), translatedPrompt].filter(Boolean).join("\n\n");
    if (!submittedPrompt) {
      setNotice("原任务缺少可复用的提示词，无法重新生成");
      return;
    }
    if (!window.confirm(`将按原模型 ${targetModel}、原时长和原素材重新提交 1 条任务，可能再次产生费用。旧视频会保留，是否继续？`)) return;

    const requestId = uid("task-regeneration");
    const submitStartedAt = performance.now();
    setRegeneratingTaskId(task.id);
    setNotice("正在按原参数重新提交，旧视频会继续保留…");
    recordDiagnostic({
      adapter: submissionProfile.adapter,
      providerName: submissionProfile.name,
      model: targetModel,
      requestId,
      stage: "client_task_regeneration_started",
      retryOfTaskId: task.id,
      mode: task.batchId ? "batch" : "single",
    });
    try {
      const form = new FormData();
      form.set("prompt", submittedPrompt);
      form.set("duration", String(targetDuration));
      form.set("resolution", targetResolution);
      form.set("aspectRatio", targetRatio);
      form.set("seed", targetSeed);
      form.set("quantity", "1");
      form.set("syncAudio", String(targetSyncAudio));
      form.set("autoReference", String(targetAutoReference));
      let fileIndex = 0;
      const referenceMeta = restoredReferences.map((item) => {
        const meta = {
          tag: item.tag,
          kind: item.kind,
          name: item.name,
          subType: item.subType || "reference",
          durationSeconds: item.durationSeconds || null,
          sizeBytes: item.file?.size || null,
          url: item.url || "",
          fileIndex: item.file ? fileIndex++ : null,
        };
        if (item.file) form.append("references", item.file, item.file.name);
        return meta;
      });
      form.set("referenceMeta", JSON.stringify(referenceMeta));
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { ...headersFor(submissionProfile), ...diagnosticHeaders({ requestId }) },
        body: form,
      });
      const body = await response.json().catch(() => ({}));
      recordDiagnostic({
        adapter: submissionProfile.adapter,
        providerName: submissionProfile.name,
        model: targetModel,
        requestId,
        stage: response.ok ? "client_task_regeneration_completed" : "client_task_regeneration_failed",
        durationMs: Math.round(performance.now() - submitStartedAt),
        status: response.status,
        taskCount: body.tasks?.length || 0,
        retryOfTaskId: task.id,
        error: response.ok ? "" : body.message || "重新生成提交失败",
      });
      if (!response.ok) {
        const message = body.message || "重新生成提交失败";
        if (body.submissionUnknown || body.code === "SUBMISSION_UNKNOWN") {
          throw new Error(`${message} 请不要立即再次点击重新生成。`);
        }
        throw new Error(message);
      }
      const created = Array.isArray(body.tasks) ? body.tasks : [body];
      const createdAtMs = Date.now();
      const reuseSnapshot = taskReuseSnapshot({
        prompt: reusablePrompt,
        references: restoredReferences,
        duration: targetDuration,
        resolution: targetResolution,
        ratio: targetRatio,
        seed: targetSeed,
        quantity: 1,
        syncAudio: targetSyncAudio,
        autoReference: targetAutoReference,
      });
      const savedTasks = await allTasks();
      const priorRegenerations = savedTasks.filter((item) => item.retryOfTaskId === task.id).length;
      const sourceTask = {
        ...task,
        retryAttempt: Math.max(Number(task.retryAttempt || 0), priorRegenerations),
      };
      const taskRecords = created.map((createdTask, index) => regeneratedTaskRecord({
        sourceTask,
        createdTask: {
          ...createdTask,
          submitDurationMs: Math.round(performance.now() - submitStartedAt),
        },
        profile: submissionProfile,
        model: targetModel,
        prompt: submittedPrompt,
        reuseSnapshot,
        diagnosticRequestId: requestId,
        createdAtMs: createdAtMs + index,
        nextPollAt: createdAtMs + pollDelayForAdapter(submissionProfile.adapter),
        index,
      }));
      await putTasks(taskRecords);
      setPage(1);
      setTaskStatusFilter("all");
      setTaskProjectFilter(activeTaskProject || UNCLASSIFIED_PROJECT);
      setTaskRefreshVersion((value) => value + 1);
      setNotice(task.batchId ? "已按原参数重新提交，并保留在原批次和原章节" : "已按原参数重新提交新任务，旧视频已保留");
    } catch (error) {
      recordDiagnostic({
        adapter: submissionProfile.adapter,
        providerName: submissionProfile.name,
        model: targetModel,
        requestId,
        stage: "client_task_regeneration_exception",
        durationMs: Math.round(performance.now() - submitStartedAt),
        retryOfTaskId: task.id,
        error: error.message || "重新生成提交失败",
      });
      setNotice(`${error.message || "重新生成提交失败"}；原视频和不满意标记均已保留`);
    } finally {
      setRegeneratingTaskId(null);
    }
  }

  async function downloadTaskCollection(taskCollection, downloadId, collectionLabel = "批次", options = {}) {
    const { pending: completed, alreadyDownloaded, unavailable: skippedTasks } = downloadTaskBuckets(taskCollection, options);
    if (!completed.length) {
      setNotice(alreadyDownloaded.length
        ? `该${collectionLabel}当前成功的视频都已下载，无需重复下载`
        : `该${collectionLabel}目前还没有可下载的成功视频`);
      return { downloadedTaskIds: [], alreadyDownloaded: alreadyDownloaded.length, unavailable: skippedTasks.length };
    }
    const skipped = skippedTasks.length;
    setDownloadingBatchId(downloadId);
    let downloaded = 0;
    let unavailable = 0;
    const downloadErrors = [];
    const downloadedTaskIds = [];
    const markErrors = [];
    try {
      const downloadOne = async (index) => {
        const task = completed[index];
        try {
          setNotice(`正在按章节顺序下载：第 ${index + 1}/${completed.length} 个 · 已成功 ${downloaded} · 不可用 ${unavailable}`);
          let response;
          let body = {};
          let downloadedTask = task;
          const candidateTasks = [task, ...(task.downloadAlternatives || [])];
          for (const candidateTask of candidateTasks) {
            const profile = profiles.find((item) => item.id === candidateTask.profileId);
            if (!profile || !keyFor(profile)) {
              body = { message: "所属中转站缺少 API Key" };
              continue;
            }
            const contentUrls = [taskContentRequestUrl(candidateTask), candidateTask.videoUrl].filter((url, index, values) => url && values.indexOf(url) === index);
            for (const contentUrl of contentUrls) {
              response = await fetch(contentUrl, { headers: headersFor(profile) });
              if (response.ok) {
                downloadedTask = candidateTask;
                break;
              }
              body = await response.json().catch(() => ({}));
            }
            if (response.ok) break;
          }
          if (!response?.ok) {
            throw new Error(body.message || (response ? `HTTP ${response.status}` : "没有可用的任务记录"));
          }
          const url = URL.createObjectURL(await response.blob());
          const link = document.createElement("a");
          link.href = url;
          link.download = orderedDownloadFilename({ ...downloadedTask, batchTitle: task.batchTitle, batchSection: task.batchSection }, index, completed.length);
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
          downloaded += 1;
          downloadedTaskIds.push(task.id);
          try {
            await markTaskDownloaded(downloadedTask.id);
          } catch {
            markErrors.push(task.title || task.id);
          }
          await new Promise((resolve) => window.setTimeout(resolve, 150));
        } catch (error) {
          unavailable += 1;
          downloadErrors.push(`${task.title || task.id}：${error.message || "下载地址不可用"}`);
        }
        setNotice(`正在按章节顺序下载：已处理 ${downloaded + unavailable}/${completed.length} · 已成功 ${downloaded} · 不可用 ${unavailable}`);
      };
      for (let index = 0; index < completed.length; index += 1) await downloadOne(index);
      setTaskRefreshVersion((value) => value + 1);
      setNotice(`${collectionLabel}下载尝试完成：本次新下载 ${downloaded} 个${alreadyDownloaded.length ? `，跳过已下载 ${alreadyDownloaded.length} 个` : ""}，结果地址不可用 ${unavailable} 个${skipped ? `，另跳过生成失败或未完成任务 ${skipped} 条` : ""}${downloadErrors.length ? `；首个错误：${downloadErrors[0]}` : ""}${markErrors.length ? `；有 ${markErrors.length} 个下载记录未能保存，下次可能重复下载` : ""}`);
      return { downloadedTaskIds, alreadyDownloaded: alreadyDownloaded.length, unavailable: unavailable + skipped };
    } catch (error) {
      setNotice(error.message || "批次下载失败");
      return { downloadedTaskIds, alreadyDownloaded: alreadyDownloaded.length, unavailable: unavailable + skipped };
    } finally {
      setDownloadingBatchId(null);
    }
  }

  async function downloadBatch(batch) {
    return downloadTaskCollection(batch.tasks, batch.id, "批次");
  }

  function toggleTask(task) {
    const next = expandedTaskId === task.id ? null : task.id;
    if (!next || videoBlob?.taskId !== next) setVideoBlob(null);
    setExpandedTaskId(next);
    if (next && task.status === "completed") loadVideo(task);
  }

  async function renameTask(task) {
    const value = window.prompt("输入任务名称", task.title || task.id);
    if (!value?.trim()) return;
    await putTask({ ...task, title: value.trim() });
    setTaskRefreshVersion((current) => current + 1);
  }

  async function deleteTask(task) {
    if (videoBlob?.taskId === task.id) setVideoBlob(null);
    deletedTaskIdsRef.current.add(task.id);
    try {
      await removeStoredTask(task.id);
      setTasks((current) => current.filter((item) => item.id !== task.id));
      setExpandedTaskId((current) => (current === task.id ? null : current));
      setTaskRefreshVersion((current) => current + 1);
    } catch (error) {
      deletedTaskIdsRef.current.delete(task.id);
      setNotice(error.message || "删除任务失败");
    }
  }

  async function deleteBatch(batch) {
    const taskIds = batch.tasks.map((task) => task.id);
    if (!taskIds.length) return;
    const activeCount = batch.tasks.filter((task) => task.status === "queued" || task.status === "processing").length;
    const activeWarning = activeCount
      ? `\n其中 ${activeCount} 条仍在生成；删除只移除本机记录，不会取消中转站已经创建的任务。`
      : "";
    if (!window.confirm(`确定删除整个批次“${batch.title}”及其 ${taskIds.length} 条任务记录吗？${activeWarning}\n此操作无法撤销。`)) return;

    taskIds.forEach((id) => deletedTaskIdsRef.current.add(id));
    try {
      await removeStoredTasks(taskIds);
      if (taskIds.includes(videoBlob?.taskId)) setVideoBlob(null);
      setTasks((current) => current.filter((task) => !taskIds.includes(task.id)));
      setExpandedTaskId((current) => (taskIds.includes(current) ? null : current));
      setExpandedBatchId((current) => (current === batch.id ? null : current));
      setTaskRefreshVersion((current) => current + 1);
      setNotice(`已删除批次“${batch.title}”及其 ${taskIds.length} 条本机任务记录`);
    } catch (error) {
      taskIds.forEach((id) => deletedTaskIdsRef.current.delete(id));
      setNotice(error.message || "删除批量任务失败");
    }
  }

  async function exportTaskBackup() {
    try {
      const savedTasks = await allTasks();
      const blob = new Blob(
        [JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), tasks: savedTasks }, null, 2)],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `AI视频工作台-任务备份-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`已导出 ${savedTasks.length} 条任务记录，不包含视频文件和 API Key`);
    } catch (error) {
      setNotice(error.message || "导出任务备份失败");
    }
  }

  async function importTaskBackup(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const imported = Array.isArray(parsed) ? parsed : parsed?.tasks;
      if (!Array.isArray(imported) || imported.some((task) => !task?.id))
        throw new Error("任务备份文件格式无效");
      await putTasks(imported);
      setTaskRefreshVersion((value) => value + 1);
      setNotice(`已导入 ${imported.length} 条任务记录；相同任务编号会更新，不会重复添加`);
    } catch (error) {
      setNotice(error.message || "导入任务备份失败");
    }
  }

  return (
    <main className="workspace-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">影</span>
          <div>
            <h1>AI 视频生成工作台</h1>
            <p>图片对应 @Image，音频对应 @Audio，视频对应 @Video</p>
          </div>
        </div>
        <div className="provider-switcher">
          <button className="secondary-button" onClick={onImageMode}>图片生成</button>
          <div className="model-version-switch" role="group" aria-label="Seedance 模型版本">
            <span>模型版本</span>
            <button
              className={sdVersion === "sd20" ? "active" : ""}
              disabled={!sdVersionAvailability.sd20 || (Array.isArray(availableActiveModels) && !availableActiveModels.includes(sdVersionAvailability.sd20))}
              onClick={() => switchSdVersion("sd20")}
              title="9张图片、3个音频、3个视频，最长15秒"
            >SD2.0</button>
            <button
              className={sdVersion === "sd25" ? "active" : ""}
              disabled={!sdVersionAvailability.sd25 || (Array.isArray(availableActiveModels) && !availableActiveModels.includes(sdVersionAvailability.sd25))}
              onClick={() => switchSdVersion("sd25")}
              title="30张图片、10个音频、10个视频，最长30秒"
            >SD2.5</button>
          </div>
          <label>
            <span>当前中转站</span>
            <select value={activeProfile.id} onChange={(event) => setActiveId(event.target.value)}>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
          </label>
          <span className={`connection-pill ${keyFor(activeProfile) ? "ready" : ""}`}>
            {keyFor(activeProfile) ? activeProfile.model : "等待 API 配置"}
          </span>
          <span className="network-pill" title="不继承环境变量代理；系统网卡/TUN代理仍会接管请求">直连防丢包</span>
          <button className="secondary-button" title="只导出当前选择的中转，不包含其他中转" disabled={!!diagnosticBusy} onClick={downloadDiagnostics}>{diagnosticBusy === "exporting" ? "导出中…" : "仅导出当前中转日志"}</button>
          <button className="secondary-button" disabled={!!diagnosticBusy} onClick={resetDiagnostics}>{diagnosticBusy === "clearing" ? "清空中…" : "清空本次日志"}</button>
          <button className="task-project-button" onClick={() => setTaskProjectOpen(true)}>任务项目：{activeTaskProject}</button>
          <button className="secondary-button" onClick={() => setCostOpen(true)}>成本统计</button>
          <button className="secondary-button" onClick={() => openConfig()}>中转站管理</button>
          <button className="logout-button" onClick={onLogout}>退出登录</button>
        </div>
      </header>

      <div className="workspace-grid">
        <section className="panel generation-panel">
          <div className="panel-heading">
            <h2>生成参数</h2>
            <span className="idle-pill">● IDLE</span>
          </div>
          <div className="work-mode-switch" role="tablist" aria-label="工作模式">
            <button className={workMode === "single" ? "active" : ""} onClick={() => setWorkMode("single")}>单条生成</button>
            <button className={workMode === "batch" ? "active" : ""} onClick={() => setWorkMode("batch")}>批量生成</button>
          </div>
          {workMode === "batch" ? (
            <BatchPanel
              activeProfile={activeProfile}
              apiKey={keyFor(activeProfile)}
              autoReference={autoReference}
              capability={capability}
              duration={duration}
              fixedContent={fixedContent}
              fixedContentVersionLabel={sdVersion === "sd25" ? "SD2.5" : "SD2.0"}
              headers={headersFor(activeProfile)}
              notice={notice}
              onNotice={setNotice}
              onProjectFolder={selectProjectFolder}
              onChooseProjectFolder={chooseProjectFolder}
              onDownloadTasks={downloadTaskCollection}
              onRestoreProjectFolder={restoreProjectFolder}
              onTasksAdded={() => {
                setPage(1);
                setTaskStatusFilter("all");
                setTaskProjectFilter(activeTaskProject || UNCLASSIFIED_PROJECT);
                setTaskRefreshVersion((value) => value + 1);
              }}
              projectAssets={projectAssets}
              projectNeedsPermission={projectNeedsPermission}
              projectName={projectName}
              taskProjectName={activeTaskProject}
              quantity={quantity}
              ratio={ratio}
              readMediaDuration={readMediaDuration}
              resolution={resolution}
              seed={seed}
              setDuration={setDuration}
              setFixedContent={setFixedContent}
              setQuantity={setQuantity}
              setRatio={setRatio}
              setResolution={setResolution}
              setSeed={setSeed}
              setSyncAudio={setSyncAudio}
              syncAudio={syncAudio}
            />
          ) : (
          <div className="panel-body">
            <div className="project-bar">
              <div>
                <strong>{projectName ? `当前项目：${projectName}` : "当前未选择项目文件夹"}</strong>
                <span>
                  {projectAssets.length
                    ? `已读取 ${projectAssets.length} 个可用素材；本地文件只会在开始生成时上传`
                    : projectNeedsPermission
                      ? "项目位置已保留；浏览器需要确认后即可继续读取"
                      : "选择后会记住项目位置，重启工作台后自动恢复"}
                </span>
              </div>
              <div>
                <button
                  className="secondary-button"
                  onClick={projectNeedsPermission ? restoreProjectFolder : chooseProjectFolder}
                >
                  {projectNeedsPermission ? "恢复项目" : projectName ? "更换项目" : "选择项目文件夹"}
                </button>
                <button className="one-click-button" disabled={!projectAssets.length} onClick={runOneClickReference}>
                  一键参考
                </button>
              </div>
              <input
                ref={projectFolderInput}
                type="file"
                multiple
                hidden
                webkitdirectory=""
                directory=""
                onChange={(event) => {
                  selectProjectFolder(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>

            <label className="field-label fixed-label" htmlFor="fixed-content">
              固定内容（{sdVersion === "sd25" ? "SD2.5" : "SD2.0"}）
              <span>两个模型版本分别保存；每次提交自动放在提示词最前方，清空素材不会删除</span>
            </label>
            <textarea
              className="fixed-content"
              id="fixed-content"
              value={fixedContent}
              onChange={(event) => setFixedContent(event.target.value)}
              placeholder="例如：统一画风、人物一致性、镜头规范等每次都要携带的内容"
            />
            <div className="fixed-content-count">固定内容 {fixedContent.length} 字</div>

            <label className="field-label" htmlFor="prompt">提示词 Prompt</label>
            <div className="prompt-field">
              <textarea
                ref={promptInput}
                id="prompt"
                value={prompt}
                onChange={handlePromptChange}
                onKeyDown={handlePromptKeyDown}
                onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
                onBlur={() => window.setTimeout(() => setMention(null), 150)}
              />
              {mention && references.length > 0 && (
                <div className="mention-menu" role="listbox" aria-label="参考素材引用">
                  {mentionSuggestions.length ? mentionSuggestions.map((item, index) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === mentionIndex}
                      className={index === mentionIndex ? "active" : ""}
                      key={item.id}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseMention(item)}
                    >
                      <span className={`mention-icon ${item.kind}`}>
                        {item.kind === "image" ? "图" : item.kind === "audio" ? "音" : "视"}
                      </span>
                      <strong>{visibleReferenceTag(item)}</strong>
                      <small>{item.name}</small>
                    </button>
                  )) : (
                    <div className="mention-empty">没有匹配的参考素材</div>
                  )}
                </div>
              )}
            </div>
            <div className="character-count">{prompt.length} 字</div>

            <div className="section-heading">
              <div>
                <h3>参考素材</h3>
                <p>支持图片、音频和视频；点击标签可插入提示词</p>
              </div>
              <span>{references.length}/50 · 图{referenceCounts.image}/{capability.images} · 音{referenceCounts.audio}/{capability.audios} · 视{referenceCounts.video}/{capability.videos} · {formatBytes(totalReferenceBytes)}</span>
            </div>

            <div className="reference-toolbar">
              <button onClick={() => fileInput.current?.click()}>＋ 添加素材</button>
              <button onClick={() => setUrlOpen((value) => !value)}>素材 URL</button>
              <button disabled={!references.length} onClick={clearReferences}>清空</button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept="image/*,audio/*,video/mp4,video/quicktime,.mov,.mp4,.mp3,.wav,.m4a,.aac,.flac"
                onChange={(event) => {
                  if (event.target.files) addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
            <p className="upload-mode-note">
              {activeProfile.adapter === "paipu"
                ? "素材上传：图片使用 Paipu 上传接口；本地音频和视频自动转为临时 HTTPS 地址"
                : activeProfile.mediaUploadUrl
                ? "素材上传：使用你填写的自定义上传地址"
                : "素材上传：未填写地址时自动选择临时转链（约 1–3 小时后失效）"}
            </p>
            {urlOpen && (
              <div className="url-adder">
                <select value={urlKind} onChange={(event) => setUrlKind(event.target.value)}>
                  <option value="image">图片</option>
                  <option value="audio">音频</option>
                  <option value="video">视频</option>
                </select>
                <input value={urlValue} onChange={(event) => setUrlValue(event.target.value)} placeholder="https://..." />
                <button onClick={addUrlReference}>加入</button>
              </div>
            )}

            <div
              className="reference-zone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                addFiles(event.dataTransfer.files);
              }}
            >
              {!references.length && (
                <div className="empty-reference">
                  <strong>把参考图片、音频或视频拖到这里</strong>
                  <span>
                    当前 {sdVersion === "sd25" ? "SD2.5" : "SD2.0"} 上限：图片{capability.images}张、音频{capability.audios}个、视频{capability.videos}个；{numericDurations.length ? "最长" : ""}{maximumDurationLabel}
                  </span>
                </div>
              )}
              {references.map((item) => {
                const kindPosition = references
                  .filter((reference) => reference.kind === item.kind)
                  .findIndex((reference) => reference.id === item.id) + 1;
                const supported = kindPosition <= (capability[`${item.kind}s`] ?? 0);
                return (
                <article className={`reference-card ${item.kind} ${supported ? "" : "unsupported"}`} key={item.id}>
                  <button className="tag" onClick={() => insertTag(item)}>{visibleReferenceTag(item)}</button>
                  <button className="remove" onClick={() => removeReference(item.id)}>×</button>
                  <div className="reference-preview">
                    {item.kind === "image" && <img src={item.preview} alt="" />}
                    {item.kind === "video" && <video src={item.preview} muted />}
                    {item.kind === "audio" && <span>♫</span>}
                  </div>
                  <strong title={item.name}>{item.name}</strong>
                  <small>{item.file ? formatBytes(item.file.size) : "网络素材"}</small>
                  {item.durationSeconds && <small>{item.durationSeconds} 秒</small>}
                  {!supported && <span className="unsupported-badge">当前模型不支持</span>}
                  {item.kind === "image" && (
                    (activeProfile.adapter === "viralee" && activeProfile.model.startsWith("viraldance")) ||
                    activeProfile.adapter === "meaicc"
                  ) && (
                    <select value={item.subType} onChange={(event) => setReferences((current) => current.map((ref) => ref.id === item.id ? { ...ref, subType: event.target.value } : ref))}>
                      <option value="reference">参考图</option>
                      <option value="first_frame">首帧</option>
                      <option value="last_frame">尾帧</option>
                    </select>
                  )}
                </article>
                );
              })}
            </div>

            <label className="check-row">
              <input type="checkbox" checked={autoReference} onChange={(event) => setAutoReference(event.target.checked)} />
              提交时自动在提示词中附加素材编号与文件名
            </label>

            <div className="settings-grid">
              <label><span>时长</span><select value={duration} onChange={(event) => setDuration(event.target.value === "auto" ? "auto" : Number(event.target.value))}>{capability.durations.map((value) => <option key={value} value={value}>{value === "auto" ? "自动" : `${value} 秒`}</option>)}</select></label>
              <label><span>清晰度</span><select value={resolution} onChange={(event) => setResolution(event.target.value)}>{capability.resolutions.map((value) => <option key={value}>{value}</option>)}</select></label>
              <label><span>画面比例</span><select value={ratio} onChange={(event) => setRatio(event.target.value)}>{capability.ratios.map((value) => <option key={value}>{value}</option>)}</select></label>
              <label><span>随机种子</span><input value={seed} onChange={(event) => setSeed(event.target.value)} placeholder={capability.seed ? "空 = 随机" : "当前模型不支持"} disabled={!capability.seed} /></label>
              <label><span>生成数量</span><select value={quantity} onChange={(event) => setQuantity(Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value}>{value}</option>)}</select></label>
            </div>
            <label className="check-row">
                        <input type="checkbox" checked={syncAudio} onChange={(event) => setSyncAudio(event.target.checked)} />
                        生成同步音频（当前中转默认开启）
            </label>
            <div className="notice" role="status">ⓘ {notice}</div>
            <div className="submit-row">
              <button className="primary-button" disabled={submitting} onClick={submitTask}>{submitting ? "提交中…" : "开始生成"}</button>
            <button className="secondary-button" onClick={() => { setTaskRefreshVersion((value) => value + 1); setNotice("任务列表已刷新；生成中任务会按各中转站要求分批查询"); }}>刷新任务</button>
            </div>
          </div>
          )}
        </section>

        <aside className="panel task-panel">
          <div className="panel-heading">
            <h2>我的任务</h2>
            <span>{taskCount} 条</span>
          </div>
          <div className="task-controls">
            <select aria-label="任务状态" value={taskStatusFilter} onChange={(event) => setTaskStatusFilter(event.target.value)}>
              <option value="all">全部状态</option>
              <option value="queued">排队中</option>
              <option value="processing">生成中</option>
              <option value="completed">已完成</option>
              <option value="failed">失败</option>
              <option value="history">7天前历史</option>
            </select>
            <select aria-label="任务项目" value={taskProjectFilter} onChange={(event) => setTaskProjectFilter(event.target.value)}>
              <option value="all">全部项目</option>
              {availableTaskProjectOptions.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <input aria-label="搜索任务" value={taskQuery} onChange={(event) => setTaskQuery(event.target.value)} placeholder="搜索名称、编号或模型" />
            <div className="task-backup-buttons">
              <button onClick={exportTaskBackup}>导出备份</button>
              <button onClick={() => taskBackupInput.current?.click()}>导入备份</button>
              <input
                ref={taskBackupInput}
                hidden
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  importTaskBackup(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </div>
          </div>
          <div className="task-project-bulk-bar">
            <label><input type="checkbox" checked={allVisibleTasksSelected} onChange={() => toggleTaskSelectionGroup(visibleTaskIds)} />全选本页</label>
            <span>已选 {selectedTaskIds.length} 条</span>
            <select aria-label="批量归入任务项目" value={selectedTargetProject} onChange={(event) => setSelectedTargetProject(event.target.value)}>
              {availableTaskProjectOptions.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <button className="secondary-button" disabled={!selectedTaskIds.length} onClick={() => moveTasksToProject(selectedTaskIds, selectedTargetProject)}>将所选归入项目</button>
          </div>
          <div className="task-list">
            {!visibleEntries.length && (
              <div className="empty-tasks"><span>▶</span><h3>{taskDatabaseReady ? "没有符合条件的任务" : "正在读取任务记录"}</h3><p>任务记录保存在本机浏览器数据库中，不保存视频文件。</p></div>
            )}
            {visibleEntries.map((entry) => {
              if (entry.type === "batch") {
                const batchExpanded = expandedBatchId === entry.id;
                const completedCount = entry.tasks.filter((task) => task.status === "completed").length;
                const downloadedCount = entry.tasks.filter((task) => task.downloadedAtMs).length;
                const failedCount = entry.tasks.filter((task) => task.status === "failed").length;
                const dissatisfiedCount = entry.tasks.filter((task) => task.reviewStatus === "dissatisfied").length;
                const progress = entry.tasks.length
                  ? Math.round(entry.tasks.reduce((total, task) => total + normalizedTaskProgress(task.status, task.progress), 0) / entry.tasks.length)
                  : 0;
                return (
                  <article className={`batch-task-group ${batchExpanded ? "expanded" : ""}`} key={entry.id}>
                    <div className="batch-task-group-head" onClick={() => setExpandedBatchId(batchExpanded ? null : entry.id)}>
                      <label className="task-select-box" title="选择或取消本批次全部任务" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={entry.tasks.every((task) => selectedTaskIds.includes(task.id))} onChange={() => toggleTaskSelectionGroup(entry.tasks.map((task) => task.id))} /></label>
                      <div className="batch-task-group-summary">
                        <strong>▸ 批量任务｜{entry.title}</strong>
                        <span>共 {entry.tasks.length} 条 · 已生成 {completedCount} · 已下载 {downloadedCount} · 生成中 {entry.tasks.length - completedCount - failedCount} · 失败 {failedCount}{dissatisfiedCount ? ` · 不满意 ${dissatisfiedCount}` : ""}</span>
                      </div>
                      <div className="batch-task-actions">
                        <button
                          className="batch-download-button"
                          disabled={!completedCount || downloadingBatchId === entry.id}
                          onClick={(event) => { event.stopPropagation(); downloadBatch(entry); }}
                        >{downloadingBatchId === entry.id ? "下载中…" : `一键下载（${completedCount}）`}</button>
                        <button
                          className="delete-button batch-delete-button"
                          onClick={(event) => { event.stopPropagation(); deleteBatch(entry); }}
                        >删除批次</button>
                      </div>
                    </div>
                    <div className="progress-row batch-group-progress"><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><b>{progress}%</b></div>
                    {batchExpanded && (
                      <div className="batch-task-children">
                        {entry.tasks.map((task) => {
                          const childExpanded = expandedTaskId === task.id;
                          const shownProgress = normalizedTaskProgress(task.status, task.progress);
                          return (
                            <article className={`task-card batch-child-task ${childExpanded ? "expanded" : ""}`} key={task.id} onClick={() => toggleTask(task)}>
                              <div className="task-topline"><label className="task-select-box" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selectedTaskIds.includes(task.id)} onChange={() => toggleTaskSelection(task.id)} /></label><code>#{task.title || task.id}</code><span className={`task-status ${task.status}`}>● {statusLabel(task.status)}</span>{task.downloadedAtMs && <span className="task-download-badge">✓ 已下载</span>}</div>
                              <div className="progress-row"><div className="progress-track"><span style={{ width: `${shownProgress}%` }} /></div><b>{shownProgress}%</b></div>
                              <label className="task-project-assignment" onClick={(event) => event.stopPropagation()}><span>任务项目</span><select value={task.projectName || UNCLASSIFIED_PROJECT} onChange={(event) => moveTasksToProject([task.id], event.target.value)}>{availableTaskProjectOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
                              {task.error && <p className="task-error">错误：{task.error}</p>}
                              {task.status === "failed" && <button className="secondary-button" onClick={(event) => { event.stopPropagation(); reuseFailedTask(task); }}>复用本条</button>}
                              {task.status === "completed" && (
                                <div className="task-review-actions" onClick={(event) => event.stopPropagation()}>
                                  {task.reviewStatus === "dissatisfied" ? (
                                    <>
                                      <span className="task-review-badge">不满意</span>
                                      <button className="primary-button" disabled={regeneratingTaskId === task.id} onClick={() => regenerateTask(task)}>{regeneratingTaskId === task.id ? "重新提交中…" : "重新生成"}</button>
                                      <button className="secondary-button" onClick={() => setTaskDissatisfied(task, false)}>取消标记</button>
                                    </>
                                  ) : (
                                    <button className="secondary-button" onClick={() => setTaskDissatisfied(task, true)}>标记不满意</button>
                                  )}
                                </div>
                              )}
                              {task.retryOfTaskId && <p className="task-regeneration-link">由上一条不满意视频重新生成</p>}
                              {childExpanded && (
                                <div className="task-details" onClick={(event) => event.stopPropagation()}>
                                  {task.status === "completed" ? (
                                    videoBlob?.taskId === task.id
                                      ? <><video src={videoBlob.url} controls /><a className="download-button" href={videoBlob.url} download={`${task.title || "video"}.mp4`}>下载视频</a></>
                                      : <button className="secondary-button" onClick={() => loadVideo(task)}>加载视频</button>
                                  ) : <p>{task.status === "failed" ? "该任务生成失败" : "视频生成完成后可在这里播放"}</p>}
                                  <details><summary>查看提示词</summary><pre>{task.prompt}</pre></details>
                                </div>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </article>
                );
              }
              const task = entry.task;
              const expanded = expandedTaskId === task.id;
              const shownProgress = normalizedTaskProgress(task.status, task.progress);
              return (
                <article className={`task-card ${expanded ? "expanded" : ""}`} key={task.id} onClick={() => toggleTask(task)}>
                  <div className="task-topline">
                    <div className="task-title-with-select"><label className="task-select-box" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selectedTaskIds.includes(task.id)} onChange={() => toggleTaskSelection(task.id)} /></label><code title={task.id}>#{task.title || task.id}</code></div>
                    <div>
                      <button className="icon-button" onClick={(event) => { event.stopPropagation(); renameTask(task); }}>✎</button>
                      <span className={`task-status ${task.status}`}>● {statusLabel(task.status)}</span>
                      {task.downloadedAtMs && <span className="task-download-badge">✓ 已下载</span>}
                      {task.status === "failed" && <button className="secondary-button" onClick={(event) => { event.stopPropagation(); reuseFailedTask(task); }}>复用本条</button>}
                      {task.status === "failed" && <button className="delete-button" onClick={(event) => { event.stopPropagation(); deleteTask(task); }}>删除</button>}
                    </div>
                  </div>
                  <div className="progress-row"><div className="progress-track"><span style={{ width: `${shownProgress}%` }} /></div><b>{shownProgress}%</b></div>
                  <label className="task-project-assignment" onClick={(event) => event.stopPropagation()}><span>任务项目</span><select value={task.projectName || UNCLASSIFIED_PROJECT} onChange={(event) => moveTasksToProject([task.id], event.target.value)}>{availableTaskProjectOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
                  {task.status === "completed" && (
                    <div className="task-review-actions" onClick={(event) => event.stopPropagation()}>
                      {task.reviewStatus === "dissatisfied" ? (
                        <>
                          <span className="task-review-badge">不满意</span>
                          <button className="primary-button" disabled={regeneratingTaskId === task.id} onClick={() => regenerateTask(task)}>{regeneratingTaskId === task.id ? "重新提交中…" : "重新生成"}</button>
                          <button className="secondary-button" onClick={() => setTaskDissatisfied(task, false)}>取消标记</button>
                        </>
                      ) : (
                        <button className="secondary-button" onClick={() => setTaskDissatisfied(task, true)}>标记不满意</button>
                      )}
                    </div>
                  )}
                  {task.cost != null && <p>本次消耗：{task.cost}</p>}
                  <p>项目：{task.projectName || "未归类"}</p>
                  <p>中转站：{task.providerName} · 模型：{task.model}</p>
                  <p>创建：{task.createdAt || "—"}{task.completedAt ? ` · 完成：${task.completedAt}` : ""}</p>
                  {task.error && <p className="task-error">错误：{task.error}</p>}
                  {task.networkWarning && <p className="task-network-warning">{task.networkWarning}</p>}
                  {task.retryOfTaskId && <p className="task-regeneration-link">由上一条不满意视频重新生成</p>}
                  {expanded && (
                    <div className="task-details" onClick={(event) => event.stopPropagation()}>
                      {task.status === "completed" ? (
                        videoBlob?.taskId === task.id ? (
                          <><video src={videoBlob.url} controls /><a className="download-button" href={videoBlob.url} download={`${task.title || "video"}.mp4`}>下载视频</a></>
                        ) : <button className="secondary-button" onClick={() => loadVideo(task)}>加载视频</button>
                      ) : <p>{task.status === "failed" ? "该任务生成失败" : "视频生成完成后可在这里播放"}</p>}
                      <details><summary>查看提示词</summary><pre>{task.prompt}</pre></details>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          <div className="pagination">
            <span>第 {page}/{pageCount} 页 · 共 {taskCount} 条</span>
            <div><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><button disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>下一页</button></div>
          </div>
        </aside>
      </div>

      {configOpen && (
        <div className="modal-backdrop" onMouseDown={() => setConfigOpen(false)}>
          <section className="config-dialog" role="dialog" aria-label="中转站管理" onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-heading"><div><span>PROVIDERS</span><h2>中转站管理</h2></div><button onClick={() => setConfigOpen(false)}>×</button></div>
            <div className="config-layout">
              <nav className="profile-list">
                {profiles.map((profile) => <button className={profile.id === draft.id ? "active" : ""} key={profile.id} onClick={() => selectDraft(profile.id)}><strong>{profile.name}</strong><small>{profile.model ? modelLabel(profile, profile.model) : "未选择模型"}</small></button>)}
                <button className="add-profile" onClick={createProfile}>＋ 新增中转站</button>
              </nav>
              <div className="config-form">
                <label><span>配置名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：主力 API" /></label>
                <label><span>Base URL</span><input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value, adapter: inferAdapter(event.target.value) })} placeholder="https://api.example.com" /></label>
                <label><span>接口类型</span><select value={draft.adapter} onChange={(event) => setDraft({ ...draft, adapter: event.target.value })}><option value="fmgo">FMGO / 飞猫</option><option value="paipu">Paipu / Lec</option><option value="viralee">ViralE</option><option value="canseedream">CanSeeDream / 看见梦想</option><option value="lwaigc">LWAIGC 官方统一接口</option><option value="meaicc">MEAICC / 林木森AI</option><option value="ziyuai">Ziyu AI / 紫域AI</option><option value="globalaiopc">GlobalAiOpc / 全球AI</option><option value="maxforai">MaxForAI</option><option value="clmm">CLMM Mall</option><option value="pidoi">Pidoi</option><option value="newapi">New API 通用</option></select></label>
                <label><span>API Key</span><input type="password" value={draftKey} onChange={(event) => setDraftKey(event.target.value)} placeholder="sk-••••••••" /><small>{rememberKey ? "将保存在此浏览器；公共电脑请勿启用。" : "仅保存在当前浏览器会话，不写入源码。"}</small></label>
                <label className="remember-key-row"><input type="checkbox" checked={rememberKey} onChange={(event) => setRememberKey(event.target.checked)} /><span>在这台浏览器记住当前中转站的 Key</span></label>
                <label>
                  <span>模型</span>
                  {(modelOptions[draft.id] || FALLBACK_MODELS[draft.adapter] || []).length ? (
                    <select
                      value={draft.model}
                      onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                    >
                      {draft.model &&
                        !(modelOptions[draft.id] || FALLBACK_MODELS[draft.adapter] || []).includes(draft.model) && (
                          <option value={draft.model}>{modelLabel(draft, draft.model)}</option>
                        )}
                      {(modelOptions[draft.id] || FALLBACK_MODELS[draft.adapter] || []).map((model) => (
                        <option key={model} value={model}>{modelLabel(draft, model)}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={draft.model}
                      onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                      placeholder="先测试连接或手动填写模型 ID"
                    />
                  )}
                  <small>
                    当前列表共 {(modelOptions[draft.id] || FALLBACK_MODELS[draft.adapter] || []).length} 个模型
                  </small>
                </label>
                <details className="advanced-config"><summary>高级素材上传设置</summary><label><span>素材上传地址</span><input value={draft.mediaUploadUrl || ""} onChange={(event) => setDraft({ ...draft, mediaUploadUrl: event.target.value })} placeholder="可选，例如 /v1/media/upload" /></label><label><span>独立上传密钥</span><input type="password" value={draftUploadKey} onChange={(event) => setDraftUploadKey(event.target.value)} placeholder="留空则使用当前 API Key" /><small>保存位置跟随上方“记住 Key”选项。</small></label></details>
                <div className="config-status" role="status">{configStatus}</div>
                <div className="dialog-actions"><button onClick={testProfile} disabled={testing}>{testing ? "测试中…" : "测试并读取模型"}</button><button className="primary-button" onClick={() => saveProfile(true)}>保存并切换</button><button className="danger-button" onClick={deleteProfile}>删除配置</button></div>
              </div>
            </div>
          </section>
        </div>
      )}
      {costOpen && (
        <CostDashboard
          modelOptions={modelOptions}
          onClose={() => setCostOpen(false)}
          onSelectModel={selectFavoriteModel}
          profiles={profiles}
        />
      )}
      {taskProjectOpen && (
        <TaskProjectManager
          activeProject={activeTaskProject}
          onClose={() => setTaskProjectOpen(false)}
          onCreate={createTaskProject}
          onSelect={selectTaskProject}
          onTasksChanged={(count, projectName) => {
            setTaskRefreshVersion((value) => value + 1);
            setNotice(`已将 ${count} 条历史任务移动到“${projectName}”；原项目不再保留这些任务`);
          }}
          projects={taskProjects}
        />
      )}
    </main>
  );
}
