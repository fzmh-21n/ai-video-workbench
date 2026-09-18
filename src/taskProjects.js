export const TASK_PROJECTS_KEY = "video-workbench-task-projects-v1";
export const ACTIVE_TASK_PROJECT_KEY = "video-workbench-active-task-project-v1";
export const TASK_PROJECT_RATIOS_KEY = "video-workbench-task-project-ratios-v1";
export const UNCLASSIFIED_PROJECT = "未归类";

function uniqueNames(values) {
  return [...new Set((values || [])
    .map((value) => String(value || "").trim())
    .filter((value) => value && value !== UNCLASSIFIED_PROJECT))];
}

export function loadTaskProjects(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(TASK_PROJECTS_KEY) || "[]");
    return uniqueNames(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

export function loadActiveTaskProject(storage = localStorage) {
  return String(storage.getItem(ACTIVE_TASK_PROJECT_KEY) || "").trim() || UNCLASSIFIED_PROJECT;
}

export function saveTaskProjects(projects, activeProject, storage = localStorage) {
  storage.setItem(TASK_PROJECTS_KEY, JSON.stringify(uniqueNames(projects)));
  storage.setItem(ACTIVE_TASK_PROJECT_KEY, String(activeProject || UNCLASSIFIED_PROJECT));
}

export function loadTaskProjectRatios(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(TASK_PROJECT_RATIOS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([name, ratio]) => (
      String(name || "").trim() && String(ratio || "").trim()
    )));
  } catch {
    return {};
  }
}

export function taskProjectRatio(ratios, projectName) {
  return String(ratios?.[String(projectName || "").trim()] || "").trim();
}

export function withTaskProjectRatio(ratios, projectName, ratio) {
  const name = String(projectName || "").trim();
  const normalizedRatio = String(ratio || "").trim();
  if (!name || !normalizedRatio) return { ...(ratios || {}) };
  return { ...(ratios || {}), [name]: normalizedRatio };
}

export function saveTaskProjectRatios(ratios, storage = localStorage) {
  storage.setItem(TASK_PROJECT_RATIOS_KEY, JSON.stringify(ratios || {}));
}

export function addTaskProject(projects, name) {
  const normalized = String(name || "").trim();
  if (!normalized) throw new Error("请填写项目名称");
  if (normalized === UNCLASSIFIED_PROJECT) throw new Error("“未分类”是系统保留名称，请换一个名称");
  if ((projects || []).some((value) => String(value).trim() === normalized))
    throw new Error("已经有同名项目，请直接切换到该项目");
  return [...uniqueNames(projects), normalized];
}

export function removeTaskProject(projects, name) {
  const normalized = String(name || "").trim();
  if (!normalized || normalized === UNCLASSIFIED_PROJECT) return uniqueNames(projects);
  return uniqueNames(projects).filter((value) => value !== normalized);
}

export function taskProjectNamesByCreation(projects, tasks = []) {
  const savedNewestFirst = [...uniqueNames(projects)].reverse();
  const saved = new Set(savedNewestFirst);
  const historicalCreatedAt = new Map();
  for (const task of tasks || []) {
    const name = String(task?.projectName || UNCLASSIFIED_PROJECT).trim() || UNCLASSIFIED_PROJECT;
    if (name === UNCLASSIFIED_PROJECT || saved.has(name)) continue;
    const direct = Number(task?.createdAtMs);
    const timestamp = Number.isFinite(direct) && direct > 0 ? direct : Date.parse(String(task?.createdAt || ""));
    const createdAt = Number.isFinite(timestamp) ? timestamp : 0;
    if (!historicalCreatedAt.has(name) || createdAt < historicalCreatedAt.get(name)) historicalCreatedAt.set(name, createdAt);
  }
  const historicalNewestFirst = [...historicalCreatedAt.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
    .map(([name]) => name);
  return [...savedNewestFirst, ...historicalNewestFirst, UNCLASSIFIED_PROJECT];
}

export function assignTasksToProject(tasks, taskIds, projectName) {
  const selected = new Set(taskIds || []);
  const normalized = String(projectName || "").trim();
  if (!normalized) throw new Error("请选择要归入的任务项目");
  return (tasks || []).map((task) => selected.has(task.id)
    ? { ...task, projectName: normalized }
    : task);
}

export function tasksAfterProjectDeletion(tasks, projectName) {
  const removed = String(projectName || "").trim();
  return (tasks || []).map((task) => (task.projectName || UNCLASSIFIED_PROJECT) === removed
    ? { ...task, projectName: UNCLASSIFIED_PROJECT }
    : task);
}

export function tasksOnOrAfter(tasks, cutoffMs) {
  return (tasks || []).filter((task) => {
    const direct = Number(task?.createdAtMs);
    const timestamp = Number.isFinite(direct) && direct > 0
      ? direct
      : Date.parse(String(task?.createdAt || ""));
    return Number.isFinite(timestamp) && timestamp >= Number(cutoffMs);
  });
}
