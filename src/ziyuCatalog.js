export const ZIYU_BASE_URL = "https://ziyuai.vip";

export function ziyuCapability(live = {}) {
  const durations = Array.isArray(live.allowedDurations) && live.allowedDurations.length
    ? live.allowedDurations.map(Number).filter(Number.isFinite)
    : [5, 10, 15];
  const ratios = Array.isArray(live.allowedRatios) && live.allowedRatios.length
    ? live.allowedRatios
    : ["16:9", "9:16", "1:1", "3:4", "4:3"];
  return {
    // 工作台不预判 SD2.0 上游素材限制，统一按 9/3/3 放行。
    images: 9,
    videos: 3,
    audios: 3,
    durations,
    resolutions: [String(live.resolution || "720p")],
    ratios,
    seed: false,
    syncAudio: true,
    syncAudioFixed: false,
    _sdVersion: /(?:seedance|sd)[-. ]?2[.-]?5|sd25/i.test(String(live.name || live.id || ""))
      ? "sd25"
      : "sd20",
  };
}

export function ziyuJobPayload(model, input) {
  const assets = { image: [], video: [], audio: [] };
  for (const item of input.materials || []) {
    if (assets[item.kind]) assets[item.kind].push({ url: item.url });
  }
  return {
    modelId: model,
    mode: input.materials?.length ? "i2v" : "t2v",
    prompt: input.prompt,
    ratio: input.aspectRatio,
    duration: `${input.duration}秒`,
    assets,
  };
}

export function ziyuJobFrom(body) {
  return body?.job || body?.data?.job || body;
}

export function ziyuTaskId(body) {
  const job = ziyuJobFrom(body);
  return String(job?.id || job?.jobId || job?.job_id || job?.taskId || job?.task_id || "").trim();
}

export function ziyuModels(body) {
  const rows = Array.isArray(body?.models) ? body.models : [];
  const models = [];
  const capabilities = {};
  const labels = {};
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (!id || (row?.type && row.type !== "video")) continue;
    models.push(id);
    capabilities[id] = ziyuCapability({ ...row, id });
    const details = [row?.name || id, row?.resolution].filter(Boolean);
    labels[id] = details.join(" · ");
  }
  return { models, capabilities, labels };
}
