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
  projectNames as getTaskProjectNames,
  putTask,
  putTasks,
  removeTask as removeStoredTask,
} from "./taskStore.js";
import {
  clearCredentials,
  readCredentials,
  saveCredentials,
} from "./credentialStore.js";
import { normalizedTaskProgress } from "./taskProgress.js";
import {
  filesFromProjectDirectory,
  loadProjectDirectory,
  projectDirectoryPermission,
  saveProjectDirectory,
} from "./projectFolderStore.js";
import BatchPanel from "./BatchPanel.jsx";
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
  if (adapter === "lwaigc" && Array.isArray(payload?.models)) return values;
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

  return <Workbench onLogout={logout} />;
}

function Workbench({ onLogout }) {
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
  const [taskQuery, setTaskQuery] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [fixedContent, setFixedContent] = useState(
    () => localStorage.getItem(FIXED_CONTENT_KEY) || "",
  );
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
  const [syncAudio, setSyncAudio] = useState(true);
  const [autoReference, setAutoReference] = useState(true);
  const [notice, setNotice] = useState("请选择中转站并完成 API 配置");
  const [submitting, setSubmitting] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
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
  const [videoBlob, setVideoBlob] = useState(null);
  const [mention, setMention] = useState(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const fileInput = useRef(null);
  const taskBackupInput = useRef(null);
  const projectFolderInput = useRef(null);
  const promptInput = useRef(null);
  const profilesRef = useRef(profiles);
  const pollingRef = useRef(false);

  const activeProfile =
    profiles.find((profile) => profile.id === activeId) || profiles[0];
  const capability = useMemo(() => capabilityFor(activeProfile), [activeProfile]);
  const sdVersion = sdVersionForProfile(activeProfile);
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
  const pageCount = Math.max(1, Math.ceil(taskCount / PAGE_SIZE));
  const visibleEntries = taskEntries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
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
  useEffect(() => localStorage.setItem(FIXED_CONTENT_KEY, fixedContent), [fixedContent]);
  useEffect(() => localStorage.setItem("video-workbench-mode-v1", workMode), [workMode]);
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
  }, [taskStatusFilter, taskProjectFilter, taskQuery]);
  useEffect(() => {
    setExpandedTaskId(null);
    setExpandedBatchId(null);
    setVideoBlob(null);
  }, [page]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  useEffect(() => {
    if (sdVersion === "sd20" && capability.durations.includes(15))
      setDuration(15);
    else if (!capability.durations.includes(Number(duration)))
      setDuration(capability.durations[0]);
    if (!capability.resolutions.includes(resolution))
      setResolution(capability.resolutions[0]);
    if (!capability.ratios.includes(ratio)) setRatio(capability.ratios[0]);
    if (capability.syncAudioFixed) setSyncAudio(true);
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
      "x-api-key": (explicitKey ?? keyFor(profile)).trim(),
      // HTTP 请求头只允许 Latin-1；中文模型名先编码，服务端再还原。
      "x-api-model": encodeURIComponent(profile.model.trim()),
      "x-api-adapter": profile.adapter,
      "x-media-upload-url": (profile.mediaUploadUrl || "").trim(),
      "x-media-upload-key":
        mediaKeyFor(profile) ||
        (explicitKey ?? keyFor(profile)).trim(),
    };
  }

  async function downloadDiagnostics() {
    setDiagnosticBusy("exporting");
    try {
      const result = await exportDiagnostics(activeProfile);
      setNotice(`已导出 ${activeProfile.name} 的诊断日志：${result.filename}（${result.count} 条记录）`);
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
            const update = updates.find((item) => item?.id === task.id);
            if (!update) return null;
            if (update.transient) {
              return { ...task, nextPollAt: update.nextPollAt, networkWarning: update.networkWarning };
            }
            return { ...task, ...update, networkWarning: "", title: task.title, profileId: task.profileId };
          })
          .filter(Boolean);
        if (changed.length) {
          await putTasks(changed);
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
        if (bytes + asset.file.size > MAX_TOTAL_BYTEt(id) {
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
        if (bytes + asset.file.size > MAX_TOTAL_BYTES) conti