import { imageReferenceIssues } from "./projectReferences.js";

export function batchImageReferenceIssues(item, assets, imageLimit, knownMissingImages) {
  const imageCount = (item.references || []).filter((reference) => reference.kind === "image").length;
  if (item.status === "unmatched" || (imageLimit > 0 && imageCount >= imageLimit)) return [];
  return Array.isArray(knownMissingImages) ? knownMissingImages : imageReferenceIssues(item.prompt, assets, item.references);
}

const TAG_KINDS = {
  image: "image", audio: "audio", video: "video",
  图: "image", 图片: "image", 音频: "audio", 声音: "audio", 视频: "video",
};

function parsedTag(tag) {
  const match = String(tag || "").match(/^@(Image|Audio|Video|图片|图|音频|声音|视频)([1-9]\d*)$/i);
  return match ? { kind: TAG_KINDS[match[1].toLowerCase()], number: match[2] } : null;
}

export function reindexBatchReferences(references = []) {
  const counts = { image: 0, audio: 0, video: 0 };
  return references.map((reference) => {
    counts[reference.kind] += 1;
    const label = reference.kind[0].toUpperCase() + reference.kind.slice(1);
    return { ...reference, tag: `@${label}${counts[reference.kind]}` };
  });
}

export function reconcileBatchReferenceTags(prompt, previous = [], next = []) {
  const replacements = new Map();
  const aliases = new Set(previous.map((reference) => reference.alias).filter(Boolean));
  for (const reference of previous) {
    const oldTag = parsedTag(reference.tag);
    if (!oldTag) continue;
    const target = next.find((item) => item.kind === reference.kind && reference.id && item.id === reference.id)
      || next.find((item) => item.kind === reference.kind && reference.projectAssetKey && item.projectAssetKey === reference.projectAssetKey);
    const nextTag = target && parsedTag(target.tag);
    replacements.set(`${oldTag.kind}:${oldTag.number}`, nextTag
      ? { number: nextTag.number }
      : { name: reference.alias || String(reference.name || "").replace(/\.[^.]+$/, "") || reference.tag.slice(1) });
  }
  return String(prompt || "").replace(/@(Image|Audio|Video|图片|图|音频|声音|视频)([1-9]\d*)(?!\d)/gi, (tag, label, number, offset, text) => {
    if (aliases.has(`${label}${number}`) && /^\s*=/.test(text.slice(offset + tag.length))) return tag;
    const replacement = replacements.get(`${TAG_KINDS[label.toLowerCase()]}:${number}`);
    if (!replacement) return tag;
    return replacement.number ? `@${label}${replacement.number}` : replacement.name;
  });
}
