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
  const requested = requestedSource.replace(/(\.(?:png|jpe?g|webp)|[）)])\s*[。．.!！?？]+\s*$/i, "$1");
  return { source, requested: cleanMatchValue(requested) };
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

function imageNameEntries(content, assets) {
  // 只扫描三段式图片名；以项目中的完整名字确定跨度，不要求前后有分隔符。
  const text = String(content).replace(/[０-９＿]/g, (character) => character === "＿" ? "_" : String.fromCharCode(character.charCodeAt(0) - 0xfee0));
  const candidates = [...new Set(assets.filter((asset) => asset.kind === "image")
    .flatMap((asset) => [assetFileName(asset), fileStem(assetFileName(asset))])
    .filter((name) => /^(?:角色图|场景图)_\d{3}_.+/.test(name)))].sort((a, b) => b.length - a.length);
  const entries = [];
  for (const token of text.matchAll(/(?:角色图|场景图)_\d{3}_/g)) {
    const start = token.index;
    if (entries.some((entry) => start < entry.start + entry.source.length)) continue;
    const tail = text.slice(start);
    const nextName = tail.slice(token[0].length).search(/(?:角色图|场景图)_\d{3}_/);
    const segment = nextName < 0 ? tail : tail.slice(0, token[0].length + nextName);
    const filename = segment.match(/^[^@\r\n、，,；;。．!！?？【】=→⇒]+?\.(?:png|jpe?g|webp)/i)?.[0];
    const name = filename || candidates.find((candidate) => tail.startsWith(candidate))
      || segment.match(/^[^@\r\n、，,；;。．!！?？【】=→⇒（）()：:]+/)?.[0]?.trim();
    if (!name || name.length <= token[0].length || /^\s*=/.test(tail.slice(name.length))) continue;
    const declaration = text.slice(0, start).match(/@[^@\s=、，,；;。．!！?？【】→⇒]+\s*=\s*$/);
    const sourceStart = declaration ? start - declaration[0].length : text[start - 1] === "@" ? start - 1 : start;
    entries.push({ start: sourceStart, source: content.slice(sourceStart, start + name.length), requested: name });
  }
  return entries;
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
        if (namedVoice) return cleanRequestedName(namedVoice[1]);
        return line.split(/[；;。]/).flatMap((clause) => {
          if (/沉默|无(?:新)?对白|不说话|未开口/.test(clause)) return [];
          return splitOutsideParentheses(clause).flatMap((part) => {
            const numberedName = part.trim().match(/^([\p{Script=Han}]{2,8})\s*([0-9０-９]{1,3})(?![0-9０-９.．])/u);
            if (!numberedName || /^(?:平均|时长|语速|重音|节奏|配音|镜头|场景)$/.test(numberedName[1])) return [];
            return [{ source: numberedName[0], requested: `声音${cleanMatchValue(numberedName[2])}`, voiceName: numberedName[1] }];
          });
        });
      }),
    );
  }
  return [];
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
  if (role !== "voice") {
    let next = content;
    for (const match of [...matches].sort((a, b) => b.start - a.start)) {
      const visible = `@${fileStem(assetFileName(match.asset))}=${match.requested}`;
      next = `${next.slice(0, match.start)}${visible}${next.slice(match.start + match.source.length)}`;
    }
    return next;
  }
  let next = content;
  const ordered = [...matches].sort((a, b) => b.requested.length - a.requested.length);
  for (const match of ordered) {
    const imageName = fileStem(assetFileName(match.asset));
    const visible = `@${imageName}=${match.requested}`;
    let suffix = match.source.startsWith(match.requested)
      ? match.source.slice(match.requested.length)
      : "";
    const existingIndex = next.indexOf(visible);
    if (existingIndex >= 0) {
      continue;
    }
    const index = next.indexOf(match.source);
    if (index < 0 || next.slice(Math.max(0, index - imageName.length - 2), index).indexOf("@") >= 0) continue;
    next = `${next.slice(0, index)}${match.voiceName || ""}${visible}${suffix}${next.slice(index + match.source.length)}`;
  }
  return next;
}

export function planProjectReferences(prompt, assets, includeOutsideImages = true) {
  const matches = [];
  const missing = [];
  for (const rule of SECTION_RULES) {
    const range = sectionRange(prompt, rule.heading);
    if (!range) continue;
    const names = rule.kind === "image" ? imageNameEntries(range.content, assets) : requestedNames(range.content, rule.role);
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
      else if (requested) {
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
  const outsideMatches = [];
  if (includeOutsideImages) {
    const outsideText = ranges.filter(({ rule }) => rule.kind === "image").reduce(
      (text, { range }) => `${text.slice(0, range.contentStart)}${" ".repeat(range.end - range.contentStart)}${text.slice(range.end)}`,
      String(prompt),
    );
    const claimedImages = new Set(matches.filter((match) => match.kind === "image").map((match) => match.asset.key));
    for (const entry of imageNameEntries(outsideText, assets)) {
      const asset = bestAsset(entry.requested, "image", assets);
      if (!asset || claimedImages.has(asset.key)) continue;
      claimedImages.add(asset.key);
      outsideMatches.push({ ...entry, kind: "image", role: "outside", heading: "__outside_image__", noAutoMention: true, asset });
    }
  }
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
  return { annotatedPrompt, matches, missing, outsideMatches };
}

export function imageReferenceIssues(prompt, assets, references) {
  prompt = internalizeProjectAliases(prompt, references || []);
  const attached = (references || []).filter((reference) => reference.kind === "image" || (!reference.kind && reference.projectAssetKey?.startsWith("image:")));
  const validationAssets = [...(assets || []), ...attached.filter((reference) => !(assets || []).some((asset) => asset.kind === "image" && assetFileName(asset) === cleanMatchValue(reference.name)))
    .map((reference) => ({ kind: "image", name: reference.name, key: reference.projectAssetKey }))];
  const plan = planProjectReferences(prompt, validationAssets, false);
  const hasAttachedName = (requested) => {
    const name = withoutParenthesizedDescription(cleanMatchValue(requested));
    return attached.some((reference) => cleanMatchValue(reference.name) === name || fileStem(reference.name) === name);
  };
  const issues = plan.missing
    .filter((item) => item.kind === "image" && !hasAttachedName(item.requested))
    .map((item) => item.requested);
  for (const match of plan.matches.filter((item) => item.kind === "image")) {
    if (!attached.some((reference) => reference.projectAssetKey === match.asset.key || cleanMatchValue(reference.name) === assetFileName(match.asset))) {
      issues.push(assetFileName(match.asset));
    }
  }
  // 有人物/场景模块时，文件名只按模块校验；其他正文提及的道具或旧衣态不是必传图片。
  // 没有这些模块的旧提示词仍保留全文文件名兜底，原生 @Image 编号始终校验全文。
  const filenameFallback = SECTION_RULES.some((rule) => rule.kind === "image" && sectionRange(prompt, rule.heading)) ? "" : prompt;
  for (const token of String(filenameFallback).matchAll(/(?:角色图|场景图)[_＿][0-9０-９]{3}[_＿][^\s、，,；;。．!！?？【】=]+?\.(?:png|jpe?g|webp)/giu)) {
    const requested = cleanMatchValue(token[0]);
    if (!hasAttachedName(requested)) issues.push(requested);
  }
  for (const token of String(prompt).matchAll(/@(?:Image|图片|图)(\d+)([^\s=、，,；;。．!！?？【】→⇒]*)/gi)) {
    if (token[2] || !attached.some((reference) => reference.tag?.match(/^@(?:Image|图片|图)([1-9]\d*)$/i)?.[1] === token[1])) issues.push(token[0]);
  }
  return [...new Set(issues)];
}

export function planProjectAudioReferences(prompt, assets) {
  const plan = planProjectReferences(
    prompt,
    (assets || []).filter((asset) => asset.kind === "audio"),
    false,
  );
  return {
    annotatedPrompt: plan.annotatedPrompt,
    matches: plan.matches.filter((match) => match.kind === "audio"),
    missing: plan.missing.filter((missing) => missing.kind === "audio"),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeImageReferenceBindings(prompt, references) {
  const images = new Map();
  for (const reference of references || []) {
    if (reference.kind !== "image" || !/\.(?:png|jpe?g|webp)$/i.test(reference.name || "")) continue;
    const number = String(reference.tag || "").match(/^@(?:Image|图片|图)([1-9]\d*)$/i)?.[1];
    if (number) images.set(number, reference.name);
  }
  const replacements = new Map();
  const isNamedAlias = (declaration, name) => (references || []).some((reference) =>
    reference.kind === "image" && reference.alias === declaration.match(/^@([^\s=]+)/)?.[1] && reference.name === name);
  const binding = /(@(?:Image|图片|图)(\d+)\s*=\s*)([^@\r\n、，,；;【】=→⇒]+?\.(?:png|jpe?g|webp))(?=$|[\s（(）)、，,；;。．!！?？【】→⇒])/gi;
  const next = String(prompt).replace(
    binding,
    (token, declaration, number, oldName) => {
      const name = images.get(number);
      if (!name || isNamedAlias(declaration, oldName)) return token;
      if (!replacements.has(oldName)) replacements.set(oldName, new Set());
      replacements.get(oldName).add(name);
      return `${declaration}${name}`;
    },
  );
  // 仅同步由明确编号建立的精确文件名映射；冲突映射留给缺图检查，不猜人物变体。
  const names = [...replacements].filter(([oldName, actual]) => actual.size === 1 && !actual.has(oldName));
  if (!names.length) return next;
  const mapping = new Map(names.map(([oldName, actual]) => [oldName, [...actual][0]]));
  const filenames = names.map(([name]) => escapeRegExp(name)).sort((a, b) => b.length - a.length).join("|");
  const pattern = new RegExp(`${binding.source}|(?:(?<![\\p{L}\\p{N}_./-])|(?<=只使用))(?:${filenames})(?=$|[\\s（(）)、，,；;。．!！?？【】→⇒])`, "giu");
  return String(prompt).replace(pattern, (token, declaration, number, oldName) =>
    declaration ? (images.has(number) && !isNamedAlias(declaration, oldName) ? `${declaration}${images.get(number)}` : token) : (mapping.get(token) || token));
}

export function internalizeProjectAliases(prompt, references) {
  let next = prompt;
  const ranges = SECTION_RULES
    .map((rule) => ({ rule, range: sectionRange(next, rule.heading) }))
    .filter((item) => item.range)
    .sort((a, b) => b.range.contentStart - a.range.contentStart);

  for (const { rule, range } of ranges) {
    const aliases = new Map(references.filter((item) => item.kind === rule.kind && item.alias).map((reference) => [reference.alias, reference]));
    if (!aliases.size) continue;
    const pattern = new RegExp(`@(${[...aliases.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})(?==|\\s|$)`, "g");
    const content = range.content.replace(pattern, (token, alias, offset, text) => {
      const reference = aliases.get(alias);
      if (/^(?:Image|Audio|Video|图片|图|音频|声音|视频)\d+$/i.test(alias)) {
        const filename = reference.name || "";
        if (!filename || !new RegExp(`^\\s*=\\s*${escapeRegExp(filename)}(?=$|[\\s（(）)、，,；;。．!！?？【】→⇒])`).test(text.slice(offset + token.length))) return token;
      }
      return reference.tag;
    });
    next = `${next.slice(0, range.contentStart)}${content}${next.slice(range.end)}`;
  }
  return normalizeImageReferenceBindings(next, references);
}
