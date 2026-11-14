import { ACTIVE_TASK_PROJECT_KEY, TASK_PROJECT_CREATED_AT_KEY, TASK_PROJECT_RATIOS_KEY, TASK_PROJECTS_KEY, UNCLASSIFIED_PROJECT } from "./taskProjects.js";
import { TASK_PROJECT_FIXED_CONTENT_KEY } from "./fixedContentStore.js";
import { loadProjectFinance } from "./projectFinance.js";

const PROJECT_FINANCE_KEY = "video-workbench-project-finance-v1";

function readProjectFinance(storage) {
  const raw = storage.getItem(PROJECT_FINANCE_KEY);
  if (raw === null) return null;
  try { return loadProjectFinance(storage); }
  catch { throw new Error("项目成本账本格式损坏，请先导出备份后再重命名"); }
}

export function taskProjectRenamePlan(state, oldName, newName, knownNames = []) {
  const from = String(oldName || "").trim();
  const to = String(newName || "").trim();
  if (!from || from === UNCLASSIFIED_PROJECT || from === "all") throw new Error("系统项目不能重命名");
  if (!to) throw new Error("请填写新的项目名称");
  if (to === UNCLASSIFIED_PROJECT || to === "all") throw new Error("这个名称为系统保留名称，请换一个名称");
  const names = new Set([...(state.projects || []), ...knownNames]);
  if (!names.has(from)) throw new Error("原项目不存在，请刷新项目列表后重试");
  if (from === to) return null;
  if (names.has(to)) throw new Error("已经有同名项目，请换一个名称；不会合并项目");
  const moveKey = (values = {}) => Object.fromEntries(Object.entries(values).map(([name, value]) => [name === from ? to : name, value]));
  return {
    from, to,
    projects: state.projects.map((name) => name === from ? to : name),
    activeProject: state.activeProject === from ? to : state.activeProject,
    createdAtByName: moveKey(state.createdAtByName),
    ratios: moveKey(state.ratios),
    fixedContent: moveKey(state.fixedContent),
  };
}

export async function persistTaskProjectRename(plan, renameRecords, storage = localStorage) {
  const financeEntries = readProjectFinance(storage);
  if (financeEntries) {
    const hasTargetHistory = financeEntries.some((entry) => String(entry.projectName || "").trim() === plan.to);
    if (hasTargetHistory) throw new Error("项目成本账本中已经存在目标项目的历史记录，请换一个名称；不会合并账本");
  }
  const changes = [
    [TASK_PROJECTS_KEY, JSON.stringify(plan.projects)],
    [ACTIVE_TASK_PROJECT_KEY, plan.activeProject],
    [TASK_PROJECT_CREATED_AT_KEY, JSON.stringify(plan.createdAtByName)],
    [TASK_PROJECT_RATIOS_KEY, JSON.stringify(plan.ratios)],
    [TASK_PROJECT_FIXED_CONTENT_KEY, JSON.stringify(plan.fixedContent)],
  ];
  if (financeEntries?.some((entry) => String(entry.projectName || "").trim() === plan.from)) {
    changes.push([PROJECT_FINANCE_KEY, JSON.stringify(financeEntries.map((entry) => (
      String(entry.projectName || "").trim() === plan.from ? { ...entry, projectName: plan.to } : entry
    ))) ]);
  }
  const originals = changes.map(([key]) => [key, storage.getItem(key)]);
  try {
    for (const [key, value] of changes) storage.setItem(key, value);
    return await renameRecords(plan.from, plan.to);
  } catch (error) {
    let rollbackError;
    for (const [key, value] of originals) {
      try { if (value === null) storage.removeItem(key); else storage.setItem(key, value); } catch (restoreError) { rollbackError = restoreError; }
    }
    if (rollbackError) throw new Error(`重命名失败，部分设置未能恢复，请暂勿刷新并导出备份：${error.message}`);
    throw error;
  }
}
