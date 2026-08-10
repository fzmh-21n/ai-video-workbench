const SECTION_RULES = [
  { heading: "本段角色声线锁定", kind: "audio", role: "voice" },
  { heading: "本节出场的所有人物", kind: "image", role: "people" },
  { heading: "本节的所有背景", kind: "image", role: "background" },
];

export function fileStem(name = "") {
  return cleanMatchValue(name).replace(/\.[^.]+$/, "");
}

export function cleanMatchValue(value = "") {
  return String(value)
    .trim()
    .replace(/[\r\n]/g, "")
    .replace(/[０-９＿]/g, (character) => {
      if (character === "＿") return "_";
      return String.fromCharCode(character.charCodeAt(0) - 0xfee0);
    })
    .trim();
}

function sectionRange(prompt, heading) {
  const marker = `【${heading}】`;
  const markerStart = prompt.indexOf(marker);
  if (markerStart < 0) return null;
  const contentStart = markerStart + marker.length;
  const nextHeading = prompt.slice(contentStart).search(/(?:^|\r?\n)\s*【[^】]+】/);
  const end = nextHeading < 0 ? prompt.length : contentStart + nextHeading;
  return { markerStart, contentStart, end, content: prompt.slice(contentStart, end) };
}

function uniqueEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry.requested || seen.has(entry.requested)) return false;
    seen.add(entry.requested);
    return true;
  });
}

function cleanRequestedName(value) {
  const source = String(value).trim();
  const requestedSource = source.replace(/^@[^=]+=/, "");
  return { source, requested: cleanMatchValue(requestedSource) };
}

function requestedNames(content, role) {
  const meaningfulLines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (role === "voice") {
    return uniqueEntries(
      meaningfulLines.map((line) => {
        const voiceLabel = line
          .split(/[：:]/, 1)[0]
          .replace(/\s*【声音[0-9０-９]+】\s*$/, "")
          .trim();
        return cleanRequestedName(voiceLabel);
      }),
    );
  }
  if (role === "people") {
    return uniqueEntries(
      meaningfulLines.flatMap((line) =>
        line.split(/[、，,；;]/).map((part) => cleanRequestedName(part.split(/[：:]/, 1)[0])),
      ),
    );
  }

  // 背景模块的每一行都可能是独立场景；每个词条必须与文件名精准匹配。
  return uniqueEntries(
    meaningfulLines.flatMap((line) =>
      line.split(/[、，,；;]/).map((part) => cleanRequestedName(part)),
    ),
  );
}

function assetFileName(asset) {
  return cleanMatchValue(asset.file?.name || asset.name || "");
}

function bestAsset(requested, kind, assets) {
  const target = cleanMatchValue(requested);
  if (!target) return null;
  const candidates = assets.filter((asset) => asset.kind === kind);
  const fullNameMatches = candidates.filter((asset) => assetFileName(asset) === target);
  if (fullNameMatches.length === 1) return fullNameMatches[0];
  if (fullNameMatches.length > 1) return null;

  const stemMatches = candidates.filter((asset) => fileStem(assetFileName(asset)) === target);
  return stemMatches.length === 1 ? stemMatches[0] : null;
}

function annotateContent(content, matches) {
  let next = content;
  const ordered = [...matches].sort((a, b) => b.requested.length - a.requested.length);
  for (const match of ordered) {
    const imageName = fileStem(assetFileName(match.asset));
    const visible = `@${imageName}=${match.requested}`;
    if (next.indexOf(visible) >= 0) continue;
    const index = next.indexOf(match.source);
    if (index < 0 || next.slice(Math.max(0, index - imageName.length - 2), index).indexOf("@") >= 0) continue;
    next = `${next.slice(0, index)}${visible}${next.slice(index + match.source.length)}`;
  }
  return next;
}

export function planProjectReferences(prompt, assets) {
  const matches = [];
  const missing = [];
  for (const rule of SECTION_RULES) {
    const range = sectionRange(prompt, rule.heading);
    if (!range) continue;
    const names = requestedNames(range.content, rule.role);
    for (const entry of names) {
      const asset = bestAsset(entry.requested, rule.kind, assets);
      if (asset) matches.push({ ...rule, ...entry, asset });
      else if (entry.requested) missing.push({ ...rule, ...entry });
    }
  }

  let annotatedPrompt = prompt;
  const ranges = SECTION_RULES
    .map((rule) => ({ rule, range: sectionRange(annotatedPrompt, rule.heading) }))
    .filter((item) => item.range)
    .sort((a, b) => b.range.contentStart - a.range.contentStart);
  for (const { rule, range } of ranges) {
    const sectionMatches = matches.filter((match) => match.heading === rule.heading);
    const content = annotateContent(range.content, sectionMatches);
    annotatedPrompt = `${annotatedPrompt.slice(0, range.contentStart)}${content}${annotatedPrompt.slice(range.end)}`;
  }
  return { annotatedPrompt, matches, missing };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function internalizeProjectAliases(prompt, references) {
  let next = prompt;
  const ranges = SECTION_RULES
    .map((rule) => ({ rule, range: sectionRange(next, rule.heading) }))
    .filter((item) => item.range)
    .sort((a, b) => b.range.contentStart - a.range.contentStart);

  for (const { rule, range } of ranges) {
    let content = range.content;
    for (const reference of references.filter((item) => item.kind === rule.kind && item.alias)) {
      const alias = escapeRegExp(reference.alias);
      content = content.replace(new RegExp(`@${alias}(?==|\\s|$)`, "g"), reference.tag);
    }
    next = `${next.slice(0, range.contentStart)}${content}${next.slice(range.end)}`;
  }
  return next;
}
