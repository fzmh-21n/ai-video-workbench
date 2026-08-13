export function syncAudioForProfile(preferences, profileId) {
  return preferences?.[profileId] !== false;
}

export function withSyncAudioPreference(preferences, profileId, nextValue) {
  const current = syncAudioForProfile(preferences, profileId);
  const resolved = typeof nextValue === "function" ? nextValue(current) : nextValue;
  return {
    ...(preferences || {}),
    [profileId]: Boolean(resolved),
  };
}
