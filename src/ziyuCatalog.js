export const ZIYU_BASE_URL = "https://ziyuai.vip";

export function ziyuCapability(live = {}) {
  const sd25 = /(?:seedance|sd)[-. ]?2[.-]?5|sd25/i.test(String(live.name || live.id || ""));
  const durations = Array.isArray(live.allowedDurations) && live.allowedDurations.length
    ? live.allowedDurations.map(Number).filter(Number.isFinite)
    : sd25 ? Array.from({ length: 27 }, (_, index) => index + 4) : [5, 10, 15];
  const ratios = Array.isArray(live.allowedRatios) && live.allowedRatios.length
    ? live.allowedRatios
    : ["16:9", "9:16", "1:1", "3:4", "4:3"];
  return {
    images: sd25 ? 30 : 9,
    videos: sd25 ? 10 : 3,
    audios: sd25 ? 10 : 3,
    durations,
    resolutions: [String(live.resolution || "720p")],
    ratios,
    seed: false,
    syncAudio: true,
    syncAudioFixed: false,
    _sdVersion: sd25 ? "sd25" : "sd20",
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
