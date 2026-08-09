const SECTION_RULES = [
  { heading: "本段角色声线锁定", kind: "audio", role: "voice" },
  { heading: "本节出场的所有人物", kind: "image", role: "people" },
  { heading: "本节的所有背景", kind: "image", role: "background" },
];

export function fileStem(name = "") {
  return String(name).replace(/\.[^.]+$/, "").trim();
}

function normalized(value = "") {
  return String(value)
    .normalize("NFKC")
    .replace(/^@[^=]+=/, "")
    .replace(/[\s“”"'‘’【】\[\]（）()《》<>·._-]+/g, "")
    .toLowerCase();
}

function sectionRange(prompt, heading) {
  const marker = `【${heading}】`;
  const markerStart = prompt.indexOf(marker);
  if (markerStart < 0) return null;
  const contentStart = markerStart + marker.length;
  const nextHeading = prompt.slice(contentStart).search(/【[^】]+】/);
  const end = nextHeading < 0 ? prompt.length : contentStart + nextHeading;
  return { markerStart, contentStart, end, content: prompt.slice(contentStart, end) };
}

function unique(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function cleanRequestedName(value) {
  return String(value)
    .trim()
    .replace(/^[-*•\d.、\s]+/, "")
    .replace(/^@[^=]+=/, "")
    .replace(/[。；;，,]+$/, "")
    .trim();
}

function requestedNames(content, role, assets) {
  const meaningfulLines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (role === "voice") {
    return unique(meaningfulLines.map((line) => cleanRequestedName(line.split(/[：:]/, 1)[0])));
  }
  if (role === "people") {
    return unique(
      meaningfulLines.flatMap((line) =>
        line.split(/[、，,；;]/).map((part) => cleanRequestedName(part.split(/[：:]/, 1)[0])),
      ),
    );
  }

  // 背景列表通常写在标题后的第一行。最后一个场景后面可以直接连着说明，
  // 因此用项目内的图片文件名取这一段的最长前缀，不分析后面的场景解释。
  const firstLine = meaningfulLines[0] || "";
  return unique(
    firstLine.split(/[、，,；;]/).map((part) => {
      const value = cleanRequestedName(part);
      const prefix = assets
        .filter((asset) => asset.kind === "image" && value.startsWith(asset.stem))
        .sort((a, b) => b.stem.length - a.stem.length)[0];
      return prefix?.stem || value;
    }),
  );
}

function similarity(a, b) {
  const left = normalized(a);
  const right = normalized(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const leftChars = new Map();
  for (const char of left) leftChars.set(char, (leftChars.get(char) || 0) + 1);
  let shared = 0;
  for (const char of right) {
    const count = leftChars.get(char) || 0;
    if (count) {
      shared += 1;
      leftChars.set(char, count - 1);
    }
  }
  return (2 * shared) / (left.length + right.length);
}

function bestAsset(requested, kind, assets) {
  const candidates = assets.filter((asset) => asset.kind === kind);
  const exact = candidates.filter((asset) => normalized(asset.stem) === normalized(requested));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const scored = candidates
    .map((asset) => ({ asset, score: similarity(requested, asset.stem) }))
    .filter((item) => item.score >= 0.72)
    .sort((a, b) => b.score - a.score || b.asset.stem.length - a.asset.stem.length);
  if (!scored.length) return null;
  if (scored[1] && Math.abs(scored[0].score - scored[1].score) < 0.03) return null;
  return scored[0].asset;
}

function annotateContent(content, matches) {
  let next = content;
  const ordered = [...matches].sort((a, b) => b.requested.length - a.requested.length);
  for (const match of ordered) {
    const visible = `@${match.asset.stem}=${match.requested}`;
    if (next.includes(visible)) continue;
    const index = next.indexOf(match.requested);
    if (index < 0 || next.slice(Math.max(0, index - match.asset.stem.length - 2), index).includes("@")) continue;
    next = `${next.slice(0, index)}${visible}${next.slice(index + match.requested.length)}`;
  }
  return next;
}

export function planProjectReferences(prompt, assets) {
  const matches = [];
  const missing = [];
  for (const rule of SECTION_RULES) {
    const range = sectionRange(prompt, rule.heading);
    if (!range) continue;
    const names = requestedNames(range.content, rule.role, assets);
    for (const requested of names) {
      const asset = bestAsset(requested, rule.kind, assets);
      if (asset) matches.push({ ...rule, requested, asset });
      else if (requested) missing.push({ ...rule, requested });
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
