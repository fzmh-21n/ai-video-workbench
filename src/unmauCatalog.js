export const UNMAU_BASE_URL = "https://newapis.unmau.com";
export const UNMAU_FALLBACK_MODELS = ["ad-seedance-2.0-720p", "ad-seedance-2.5-720p"];

function rowsFrom(body) {
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.models)) return body.models;
  return [];
}

function modelId(row) {
  return String(typeof row === "string" ? row : row?.model_name || row?.id || row?.name || "").trim();
}

function isVideoModel(row) {
  const types = Array.isArray(row?.supported_endpoint_types) ? row.supported_endpoint_types : [];
  return types.includes("openai-video");
}

function integerRange(minimum, maximum, values) {
  if (Array.isArray(values) && values.length) return values.map(Number).filter(Number.isFinite);
  const min = Number(minimum);
  const max = Number(maximum);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [];
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

function capabilityFrom(row) {
  let playground = {};
  try { playground = JSON.parse(row?.playground_config || "{}"); } catch {}
  const live = row?.video_capabilities || {};
  const duration = live.duration || {};
  const references = live.references || {};
  const resolutions = live.resolutions || playground.video_resolutions || [];
  const ratios = live.aspect_ratios || playground.video_aspect_ratios || [];
  const audioTrack = live.audio_track || {};
  const durations = integerRange(
    duration.min ?? playground.video_min_duration,
    duration.max ?? playground.video_max_duration,
    duration.values,
  );
  return {
    images: Number(references.max_images ?? playground.video_max_images) || 0,
    videos: Number(references.max_videos ?? playground.video_max_videos) || 0,
    audios: Number(references.max_audios ?? playground.video_max_audios) || 0,
    durations,
    resolutions: resolutions.map(String),
    ratios: ratios.map(String),
    seed: false,
    syncAudio: audioTrack.default !== false,
    syncAudioFixed: audioTrack.configurable !== true,
    audioTrackSupported: audioTrack.supported === true,
    _sdVersion: durations.some((value) => value > 15) ? "sd25" : "sd20",
    _preserveLimits: true,
  };
}

function capabilityLabel(row, capability) {
  const duration = capability.durations.length
    ? capability.durations[0] === capability.durations.at(-1)
      ? `${capability.durations[0]}秒`
      : `${capability.durations[0]}–${capability.durations.at(-1)}秒`
    : "时长按模型";
  const price = Number(row?.model_price);
  const priceLabel = Number.isFinite(price)
    ? ` · ${price}元/${row?.task_billing_mode === "per_second" ? "秒" : "条"}`
    : "";
  return `${modelId(row)} · ${capability.resolutions.join("/") || "默认清晰度"} · ${duration} · ${capability.images}图/${capability.videos}视频/${capability.audios}音频${priceLabel}`;
}

export function unmauCatalog(pricingBody, authorizedBody) {
  const authorizedRows = rowsFrom(authorizedBody);
  const authorizedIds = new Set(authorizedRows.map(modelId).filter(Boolean));
  const pricingRows = rowsFrom(pricingBody).filter(isVideoModel);
  const rows = authorizedIds.size
    ? pricingRows.filter((row) => authorizedIds.has(modelId(row)))
    : pricingRows;
  const models = [];
  const capabilities = {};
  const labels = {};
  for (const row of rows) {
    const id = modelId(row);
    if (!id || capabilities[id]) continue;
    const capability = capabilityFrom(row);
    models.push(id);
    capabilities[id] = capability;
    labels[id] = capabilityLabel(row, capability);
  }
  return { models, capabilities, labels };
}

export function unmauCapability(model) {
  const sd25 = /(?:seedance|sd)[-.]?2[.-]?5/i.test(String(model || ""));
  return {
    images: sd25 ? 30 : 9,
    videos: sd25 ? 10 : 3,
    audios: sd25 ? 10 : 3,
    durations: Array.from({ length: sd25 ? 27 : 12 }, (_, index) => index + 4),
    resolutions: ["720p"],
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    seed: false,
    syncAudio: true,
    syncAudioFixed: true,
    _sdVersion: sd25 ? "sd25" : "sd20",
    _preserveLimits: true,
  };
}

export function unmauVideoPayload(model, input, capability = {}) {
  const payload = {
    model,
    prompt: input.prompt,
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
  };
  if (capability.audioTrackSupported || /^官方-seedance/i.test(String(model || ""))) {
    payload.audio_track = input.syncAudio;
  }
  for (const kind of ["image", "video", "audio"]) {
    const urls = (input.materials || []).filter((item) => item.kind === kind).map((item) => item.url);
    if (urls.length) payload[`${kind}s`] = urls;
  }
  return payload;
}
