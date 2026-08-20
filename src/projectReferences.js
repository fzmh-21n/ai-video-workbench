const SECTION_RULES = [
  { heading: "角色声线", kind: "audio", role: "voice" },
  { heading: "配音指令", kind: "audio", role: "voice" },
  { heading: "声音锁定", kind: "audio", role: "voice" },
  { heading: "声音编号锁定", kind: "audio", role: "voice" },
  { heading: "出场人物", kind: "image", role: "people" },
  { heading: "出场场景", kind: "image", role: "background" },
  // 兼容已经保存的旧提示词；新提示词统一使用上面的简化标题。
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
  // 新模板会把两个声音标题紧挨着写成【角色声线】【配音指令】。
  // 前一个标题没有正文，真正的声音内容由后一个标题负责解析。
  if (heading === "角色声线" && prompt.slice(contentStart).startsWith("【配音指令】")) {
    return { markerStart, contentStart, end: contentStart, content: "" };
  }
  // 标题既可能独占一行，也可能像单条提示词一样全部写在同一行。
  // 【声音1】是声线内容里的编号，不是新模块标题。
  const nextHeading = prompt.slice(contentStart).search(/【(?!声音[0-9０-９]+】)[^】]+】/);
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

function splitOutsideParentheses(value) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const character of String(value)) {
    if (character === "（" || character === "(") depth += 1;
    if (character === "）" || character === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /[、，,；;]/.test(character)) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function withoutParenthesizedDescription(value) {
  return String(value).replace(/\s*[（(][\s\S]*[）)]\s*$/, "").trim();
}

function requestedNames(content, role) {
  const meaningfulLines = content
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[：:]\s*/, ""))
    .filter((line) => line && !/^[：:，,；;。.\s]+$/.test(line));
  if (role === "voice") {
    return uniqueEntries(
      meaningfulLines.flatMap((line) => {
        const mappedVoiceNumbers = [...line.matchAll(/=\s*(声音[0-9０-９]+)/g)];
        if (mappedVoiceNumbers.length) {
          return mappedVoiceNumbers.map((match) => cleanRequestedName(match[1]));
        }
        const compactVoiceNumbers = [...line.matchAll(/声音[0-9０-９]+/g)];
        if (compactVoiceNumbers.length && !/^[^【：:]+【声音[0-9０-９]+】\s*[：:]/.test(line)) {
          return compactVoiceNumbers.map((match) => cleanRequestedName(match[0]));
        }
        const leadingVoiceNumber = line.match(/^[（(]\s*(声音[0-9０-９]+)\s*[）)]/);
        if (leadingVoiceNumber) return cleanRequestedName(leadingVoiceNumber[1]);
        const assignedVoiceNumber = line.match(/^(声音[0-9０-９]+)\s*=/);
        if (assignedVoiceNumber) return cleanRequestedName(assignedVoiceNumber[1]);
        const namedVoice = line.match(/^([^【：:]+?)\s*【声音[0-9０-９]+】\s*[：:]/);
        return namedVoice ? cleanRequestedName(namedVoice[1]) : [];
      }),
    );
  }
  if (role === "people") {
    return uniqueEntries(
      meaningfulLines.flatMap((line) =>
        splitOutsideParentheses(line).map((part) =>
          cleanRequestedName(part.split(/[：:]/, 1)[0]),
        ),
      ),
    );
  }

  // 背景模块的每一行都可能是独立场景；每个词条必须与文件名精准匹配。
  return uniqueEntries(
    meaningfulLines.flatMap((line) =>
      splitOutsideParentheses(line).map((part) =>
        cleanRequestedName(part),
      ),
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

function legacyNumberedReferences(prompt, assets) {
  const matches = [];
  const pattern = /@(Image|Audio)\d+\s*=\s*([^、，,；;）)\]\}\r\n]+)/g;
  for (const token of String(prompt).matchAll(pattern)) {
    const kind = token[1] === "Image" ? "image" : "audio";
    const role = kind === "image" ? "people" : "voice";
    const requested = cleanMatchValue(token[2]);
    const asset = bestAsset(requested, kind, assets);
    if (asset) matches.push({ kind, role, requested, asset, token: token[0] });
  }
  return matches;
}

function inlineVoiceReferences(prompt, assets, claimedAssetKeys) {
  const matches = [];
  const seen = new Set();
  const pattern = /[（(]\s*(声音[0-9０-９]+)\s*[）)]/g;
  for (const token of String(prompt).matchAll(pattern)) {
    const requested = cleanMatchValue(token[1]);
    if (seen.has(requested)) continue;
    seen.add(requested);
    const asset = bestAsset(requested, "audio", assets);
    if (!asset || claimedAssetKeys.has(asset.key)) continue;
    matches.push({ kind: "audio", role: "voice", requested, asset, token: token[0] });
  }
  return matches;
}

function annotateContent(content, matches, role) {
  let next = content;
  const ordered = [...matches].sort((a, b) => b.requested.length - a.requested.length);
  for (const match of ordered) {
    const imageName = fileStem(assetFileName(match.asset));
    const visible = `@${imageName}=${match.requested}`;
    let suffix = match.source.startsWith(match.requested)
      ? match.source.slice(match.requested.length)
      : "";
    if (role === "background") suffix = "，";
    if (role === "people") suffix = `${suffix.replace(/[，,]\s*$/, "")}，`;
    const existingIndex = next.indexOf(visible);
    if (existingIndex >= 0) {
      if (role === "people") {
        const lineEnd = next.indexOf("\n", existingIndex);
        const end = lineEnd < 0 ? next.length : lineEnd;
        const line = next.slice(existingIndex, end).replace(/[，,]\s*$/, "");
        next = `${next.slice(0, existingIndex)}${line}，${next.slice(end)}`;
      }
      if (role === "background") {
        const afterVisible = existingIndex + visible.length;
        const trailingDescription = next.slice(afterVisible).match(/^\s*[（(][^\r\n）)]*[）)]/);
        if (trailingDescription) {
          next = `${next.slice(0, afterVisible)}${next.slice(afterVisible + trailingDescription[0].length)}`;
        }
        const currentAfterVisible = next.slice(afterVisible);
        if (!/^[，,]/.test(currentAfterVisible)) {
          next = `${next.slice(0, afterVisible)}，${next.slice(afterVisible)}`;
        } else if (currentAfterVisible.startsWith(",")) {
          next = `${next.slice(0, afterVisible)}，${next.slice(afterVisible + 1)}`;
        }
      }
      continue;
    }
    const index = next.indexOf(match.source);
    if (index < 0 || next.slice(Math.max(0, index - imageName.length - 2), index).indexOf("@") >= 0) continue;
    next = `${next.slice(0, index)}${visible}${suffix}${next.slice(index + match.source.length)}`;
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
      let requested = entry.requested;
      let asset = bestAsset(requested, rule.kind, assets);
      if (!asset && rule.kind === "image") {
        const withoutDescription = withoutParenthesizedDescription(requested);
        if (withoutDescription !== requested) {
          asset = bestAsset(withoutDescription, rule.kind, assets);
          if (asset) requested = withoutDescription;
        }
      }
      if (asset) matches.push({ ...rule, ...entry, requested, asset });
      else if (requested && (rule.role !== "background" || /^\d{3}[_-]/.test(requested))) {
        missing.push({ ...rule, ...entry, requested });
      }
    }
  }

  // 复用任务或手动复制的提示词可能已经带有 @Image1/@Audio1。
  // 仍按等号后的项目文件名重新认领素材，并换回可读的项目别名。
  const legacyMatches = legacyNumberedReferences(prompt, assets);
  for (const legacy of legacyMatches) {
    if (!matches.some((match) => match.kind === legacy.kind && match.asset.key === legacy.asset.key)) {
      matches.push({ ...legacy, heading: "__legacy__" });
    }
  }
  const claimedAudioKeys = new Set(matches.filter((match) => match.kind === "audio").map((match) => match.asset.key));
  const inlineVoiceMatches = inlineVoiceReferences(prompt, assets, claimedAudioKeys);
  for (const voice of inlineVoiceMatches) matches.push({ ...voice, heading: "__inline_voice__" });

  let annotatedPrompt = prompt;
  const ranges = SECTION_RULES
    .map((rule) => ({ rule, range: sectionRange(annotatedPrompt, rule.heading) }))
    .filter((item) => item.range)
    .sort((a, b) => b.range.contentStart - a.range.contentStart);
  for (const { rule, range } of ranges) {
    const sectionMatches = matches.filter((match) => match.heading === rule.heading);
    const content = annotateContent(range.content, sectionMatches, rule.role);
    annotatedPrompt = `${annotatedPrompt.slice(0, range.contentStart)}${content}${annotatedPrompt.slice(range.end)}`;
  }
  for (const legacy of legacyMatches) {
    const alias = fileStem(assetFileName(legacy.asset));
    annotatedPrompt = annotatedPrompt.split(legacy.token).join(`@${alias}=${legacy.requested}`);
  }
  for (const voice of inlineVoiceMatches) {
    const alias = fileStem(assetFileName(voice.asset));
    annotatedPrompt = annotatedPrompt.replace(voice.token, `（@${alias}=${voice.requested}）`);
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
