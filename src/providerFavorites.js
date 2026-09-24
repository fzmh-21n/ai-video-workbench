export const UNCOMMON_PROVIDER_IDS_KEY = "video-workbench-uncommon-provider-ids-v1";

export function loadUncommonProviderIds(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(UNCOMMON_PROVIDER_IDS_KEY) || "[]");
    return [...new Set((Array.isArray(parsed) ? parsed : []).map(String).filter(Boolean))];
  } catch {
    return [];
  }
}

export function saveUncommonProviderIds(ids, storage = localStorage) {
  storage.setItem(UNCOMMON_PROVIDER_IDS_KEY, JSON.stringify([...new Set((ids || []).map(String).filter(Boolean))]));
}

export function withProviderCommonState(ids, profileId, common) {
  const current = new Set((ids || []).map(String));
  const id = String(profileId || "").trim();
  if (!id) return [...current];
  if (common) current.delete(id);
  else current.add(id);
  return [...current];
}

export function partitionProviders(profiles, uncommonIds) {
  const uncommon = new Set((uncommonIds || []).map(String));
  return {
    common: (profiles || []).filter((profile) => !uncommon.has(String(profile.id))),
    other: (profiles || []).filter((profile) => uncommon.has(String(profile.id))),
  };
}
