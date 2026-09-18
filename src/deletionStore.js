export const VIDEO_DELETED_TASK_IDS_KEY = "video-workbench-deleted-task-ids-v1";
export const IMAGE_DELETED_TASK_IDS_KEY = "image-workbench-deleted-task-ids-v1";

export function loadDeletedIds(key, storage = localStorage) {
  try {
    const value = JSON.parse(storage.getItem(key) || "[]");
    return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))];
  } catch {
    return [];
  }
}

export function rememberDeletedIds(key, ids, storage = localStorage) {
  const deleted = new Set(loadDeletedIds(key, storage));
  for (const id of ids || []) if (id) deleted.add(String(id));
  const saved = [...deleted];
  storage.setItem(key, JSON.stringify(saved));
  return saved;
}

export function withoutDeletedIds(items, deletedIds) {
  const deleted = new Set((deletedIds || []).map(String));
  return (items || []).filter((item) => item?.id && !deleted.has(String(item.id)));
}
