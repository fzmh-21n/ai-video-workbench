export function imagePromptWithFixedContent(fixedContent, prompt) {
  return [String(fixedContent || "").trim(), String(prompt || "").trim()].filter(Boolean).join("\n\n");
}

export function imageDownloadFilename(task, mimeType = "image/png") {
  const sourceName = String(task?.sourceName || "").trim();
  if (sourceName) return sourceName;
  const extension = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" }[mimeType] || "png";
  return `${String(task?.title || "image").trim() || "image"}.${extension}`;
}

export function completedImageReferenceIds(references, tasks) {
  const completed = (Array.isArray(tasks) ? tasks : []).filter((task) => task?.status === "completed");
  const ids = new Set(completed.map((task) => task.sourceReferenceId).filter(Boolean));
  return new Set((Array.isArray(references) ? references : [])
    .filter((reference) => ids.has(reference.id))
    .map((reference) => reference.id));
}

export function imageTaskEntries(tasks) {
  const source = Array.isArray(tasks) ? tasks : [];
  const batches = new Map();
  for (const task of source) {
    if (!task?.batchId) continue;
    const batch = batches.get(task.batchId) || [];
    batch.push(task);
    batches.set(task.batchId, batch);
  }

  const seen = new Set();
  return source.flatMap((task) => {
    if (!task?.batchId) return [{ type: "task", task }];
    if (seen.has(task.batchId)) return [];
    seen.add(task.batchId);
    return [{ type: "batch", id: task.batchId, tasks: batches.get(task.batchId) || [] }];
  });
}
