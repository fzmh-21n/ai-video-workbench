export function reusableReferenceSnapshot(references = []) {
  return references.map((reference) => ({
    kind: reference.kind,
    name: reference.name || reference.file?.name || "",
    alias: reference.alias || "",
    subType: reference.subType || "reference",
    durationSeconds: reference.durationSeconds || null,
    projectAssetKey: reference.projectAssetKey || "",
    url: reference.url || "",
  }));
}

export function taskReuseSnapshot({ prompt, references, duration, resolution, ratio, seed, quantity, syncAudio, autoReference }) {
  return {
    prompt: String(prompt || ""),
    references: reusableReferenceSnapshot(references),
    duration,
    resolution,
    ratio,
    seed: seed ?? "",
    quantity,
    syncAudio: Boolean(syncAudio),
    autoReference: Boolean(autoReference),
  };
}

export function reusableAssetFor(reference, projectAssets = []) {
  if (reference?.projectAssetKey) {
    const exactKey = projectAssets.find((asset) => asset.key === reference.projectAssetKey);
    if (exactKey) return exactKey;
  }
  const name = String(reference?.name || "").trim().toLocaleLowerCase("zh-CN");
  if (!name) return null;
  const matches = projectAssets.filter((asset) => (
    String(asset.file?.name || "").trim().toLocaleLowerCase("zh-CN") === name
    && (!reference.kind || asset.kind === reference.kind)
  ));
  return matches.length === 1 ? matches[0] : null;
}
