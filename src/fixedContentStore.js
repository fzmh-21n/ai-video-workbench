export function loadFixedContentByVersion(saved, legacyContent = "", initialVersion = "sd20") {
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    return {
      sd20: String(saved.sd20 || ""),
      sd25: String(saved.sd25 || ""),
    };
  }
  const version = initialVersion === "sd25" ? "sd25" : "sd20";
  return {
    sd20: version === "sd20" ? String(legacyContent || "") : "",
    sd25: version === "sd25" ? String(legacyContent || "") : "",
  };
}

export function withFixedContentForVersion(contents, version, value) {
  const key = version === "sd25" ? "sd25" : "sd20";
  return { ...contents, [key]: String(value ?? "") };
}

export const FIXED_CONTENT_TEMPLATES_KEY = "video-workbench-fixed-content-templates-v1";
export const TASK_PROJECT_FIXED_CONTENT_KEY = "video-workbench-task-project-fixed-content-v1";

function normalizedTemplate(template, index = 0) {
  const id = String(template?.id || "").trim();
  const name = String(template?.name || "").trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    sd20: String(template?.sd20 || ""),
    sd25: String(template?.sd25 || ""),
    createdAtMs: Number(template?.createdAtMs) || index + 1,
  };
}

export function loadFixedContentTemplates(saved, legacyContents = {}) {
  const source = Array.isArray(saved) ? saved : [];
  const templates = source.map(normalizedTemplate).filter(Boolean);
  if (templates.length) return templates;
  return [{
    id: "default-fixed-content",
    name: "默认固定内容",
    sd20: String(legacyContents?.sd20 || ""),
    sd25: String(legacyContents?.sd25 || ""),
    createdAtMs: 1,
  }];
}

export function addFixedContentTemplate(templates, name, id, createdAtMs = Date.now()) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) throw new Error("请填写固定内容名称");
  if ((templates || []).some((item) => item.name === normalizedName)) throw new Error("已经有同名固定内容");
  return [...(templates || []), {
    id: String(id || "").trim(),
    name: normalizedName,
    sd20: "",
    sd25: "",
    createdAtMs,
  }];
}

export function updateFixedContentTemplate(templates, id, changes) {
  const templateId = String(id || "").trim();
  const name = String(changes?.name || "").trim();
  if (!name) throw new Error("请填写固定内容名称");
  if ((templates || []).some((item) => item.id !== templateId && item.name === name))
    throw new Error("已经有同名固定内容");
  return (templates || []).map((item) => item.id === templateId ? {
    ...item,
    name,
    sd20: String(changes?.sd20 || ""),
    sd25: String(changes?.sd25 || ""),
  } : item);
}

export function removeFixedContentTemplate(templates, id) {
  if ((templates || []).length <= 1) throw new Error("至少保留一条固定内容；不需要内容时可以把文本清空");
  return (templates || []).filter((item) => item.id !== id);
}

export function loadTaskProjectFixedContent(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(TASK_PROJECT_FIXED_CONTENT_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([projectName, templateId]) => (
      String(projectName || "").trim() && String(templateId || "").trim()
    )));
  } catch {
    return {};
  }
}

export function withTaskProjectFixedContent(assignments, projectName, templateId) {
  const name = String(projectName || "").trim();
  const id = String(templateId || "").trim();
  if (!name || !id) return { ...(assignments || {}) };
  return { ...(assignments || {}), [name]: id };
}

export function saveFixedContentTemplates(templates, storage = localStorage) {
  storage.setItem(FIXED_CONTENT_TEMPLATES_KEY, JSON.stringify(templates || []));
}

export function saveTaskProjectFixedContent(assignments, storage = localStorage) {
  storage.setItem(TASK_PROJECT_FIXED_CONTENT_KEY, JSON.stringify(assignments || {}));
}
