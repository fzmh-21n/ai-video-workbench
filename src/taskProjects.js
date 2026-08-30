export const TASK_PROJECTS_KEY = "video-workbench-task-projects-v1";
export const ACTIVE_TASK_PROJECT_KEY = "video-workbench-active-task-project-v1";
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

export function addTaskProject(projects, name) {
  const normalized = String(name || "").trim();
  if (!normalized) throw new Error("请填写项目名称");
  if (normalized === UNCLASSIFIED_PROJECT) throw new Error("“未分类”是系统保留名称，请换一个名称");
  if ((projects || []).some((value) => String(value).trim() === normalized))
    throw new Error("已经有同名项目，请直接切换到该项目");
  return [...uniqueNames(projects), normalized];
}

export function assignTasksToProject(tasks, taskIds, projectName) {
  const selected = new Set(taskIds || []);
  const normalized = String(projectName || "").trim();
  if (!normalized) throw new Error("请选择要归入的任务项目");
  return (tasks || []).map((task) => selected.has(task.id)
    ? { ...task, projectName: normalized }
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
