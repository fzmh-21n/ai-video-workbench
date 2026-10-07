import { imagePromptWithFixedContent } from "./imageBatch.js";

export function parseImagePromptJson(text, sourceFile = "") {
  const sourceLabel = sourceFile ? `${sourceFile}：` : "";
  let entries;
  try {
    entries = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${sourceLabel}JSON 格式错误，请检查文件内容`);
  }
  if (!Array.isArray(entries)) throw new Error(`${sourceLabel}JSON 顶层必须是数组`);
  if (!entries.length) throw new Error(`${sourceLabel}JSON 数组不能为空`);

  return entries.map((entry, index) => {
    const entryLabel = `${sourceLabel}第 ${index + 1} 条`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${entryLabel}必须是对象`);
    if (typeof entry.name !== "string" || !entry.name.trim()) throw new Error(`${entryLabel}的 name 必须是非空字符串`);
    if (typeof entry.description !== "string" || !entry.description.trim()) throw new Error(`${entryLabel}的 description 必须是非空字符串`);
    return {
      name: entry.name.trim(),
      aliases: typeof entry.aliases === "string" ? entry.aliases : "",
      prompt: entry.description,
      sourceFile,
    };
  });
}

export function imageJsonGenerationItem(row, fixedContent = "") {
  return {
    prompt: imagePromptWithFixedContent(fixedContent, row.prompt),
    title: row.name,
    sourceName: null,
    sourcePromptId: row.id || null,
    references: [],
  };
}

export function completedImagePromptIds(rows, tasks, fixedContent = "") {
  const completed = tasks.filter((task) => task.status === "completed" && task.sourcePromptId);
  return new Set(rows.filter((row) => completed.some((task) =>
    task.sourcePromptId === row.id && task.title === row.name && task.prompt === imagePromptWithFixedContent(fixedContent, row.prompt),
  )).map((row) => row.id));
}
