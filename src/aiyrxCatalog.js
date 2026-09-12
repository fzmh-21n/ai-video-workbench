export const AIYRX_BASE_URL = "https://api.aiyrx.xyz";

const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"];
const range = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => first + index);

const MODEL_CAPABILITIES = {
  "A渠道SD2.0-Fast720P-933不卡脸": { images: 9, videos: 3, audios: 3, durations: range(4, 15), resolutions: ["720p"] },
  "B渠道SD2.0-Fast720p-933不卡脸": { images: 9, videos: 3, audios: 3, durations: range(5, 15), resolutions: ["720p"] },
  "SD2.5-720P-30.0.0": { images: 30, videos: 0, audios: 0, durations: [5, 10, 30], resolutions: ["720p"] },
  "d0-amx-720": { images: 9, videos: 3, audios: 3, durations: range(4, 15), resolutions: ["720p"] },
  "d0-fast-720": { images: 9, videos: 3, audios: 3, durations: range(4, 15), resolutions: ["720p"] },
  "d7-720-fast": { images: 9, videos: 3, audios: 3, durations: range(4, 15), resolutions: ["720p"] },
  "d7-720-max": { images: 9, videos: 3, audios: 3, durations: range(4, 15), resolutions: ["720p"] },
  "官转SD2.0-Fast720p-933不卡脸": { images: 9, videos: 3, audios: 3, durations: range(4, 15), resolutions: ["720p"] },
  "官转SD2.0-满血720p-933不卡脸": { images: 9, videos: 3, audios: 3, durations: range(4, 15), resolutions: ["720p"] },
  "官逆SD2.5-720P-不卡脸30图10视频10音频": { images: 30, videos: 10, audios: 10, durations: range(4, 30), resolutions: ["720p"] },
  "海螺 H3": { images: 9, videos: 0, audios: 3, durations: range(4, 15), resolutions: ["自动"] },
};

export const AIYRX_VIDEO_MODELS = Object.keys(MODEL_CAPABILITIES);

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizedResolutions(values, fallback) {
  const resolutions = Array.isArray(values) ? values : [];
  const normalized = resolutions
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .map((value) => value === "720" ? "720p" : value);
  return normalized.length ? [...new Set(normalized)] : fallback;
}

function liveDurations(row, fallback) {
  const exact = row?.capabilities?.allowed_duration_seconds;
  if (Array.isArray(exact) && exact.length) {
    const values = exact.map(Number).filter(Number.isFinite);
    if (values.length) return [...new Set(values)].sort((left, right) => left - right);
  }
  const minimum = Number(row?.minimum_duration_seconds);
  const maximum = Number(row?.maximum_duration_seconds);
  if (Number.isFinite(minimum) && Number.isFinite(maximum) && maximum >= minimum) return range(minimum, maximum);
  return fallback;
}

export function aiyrxCapability(modelName, live = {}) {
  const fallback = MODEL_CAPABILITIES[modelName] || {
    images: 9,
    videos: 3,
    audios: 3,
    durations: range(4, 15),
    resolutions: ["720p"],
  };
  const source = live?.capabilities || {};
  const sd25 = /SD2\.5/i.test(String(modelName || live?.name || live?.id || ""));
  return {
    images: numberOr(source.maximum_reference_images, fallback.images),
    videos: numberOr(source.maximum_reference_videos, fallback.videos),
    audios: numberOr(source.maximum_reference_audios, fallback.audios),
    durations: liveDurations(live, fallback.durations),
    resolutions: normalizedResolutions(source.resolutions, fallback.resolutions),
    ratios: Array.isArray(source.aspect_ratios) && source.aspect_ratios.length
      ? source.aspect_ratios
      : RATIOS,
    seed: false,
    syncAudio: source.generate_audio_parameter === true,
    syncAudioFixed: source.generate_audio_parameter !== true,
    _sdVersion: sd25 ? "sd25" : "sd20",
    _preserveLimits: true,
  };
}

function durationLabel(durations) {
  if (!durations.length) return "时长以实时目录为准";
  if (durations.length === 1) return `${durations[0]}秒`;
  const continuous = durations.every((value, index) => index === 0 || value === durations[index - 1] + 1);
  return continuous ? `${durations[0]}–${durations.at(-1)}秒` : durations.map((value) => `${value}秒`).join("/");
}

function capabilityLabel(name, capability) {
  return `${name} · ${capability.resolutions.join("/")} · ${durationLabel(capability.durations)} · ${capability.images}图/${capability.videos}视频/${capability.audios}音频`;
}

export const AIYRX_MODEL_LABELS = Object.fromEntries(AIYRX_VIDEO_MODELS.map((model) => {
  const capability = aiyrxCapability(model);
  return [model, capabilityLabel(model, capability)];
}));

export function aiyrxModels(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const models = [];
  const capabilities = {};
  const labels = {};
  for (const row of rows) {
    const id = String(row?.id || row?.name || "").trim();
    if (!id) continue;
    const capability = aiyrxCapability(id, row);
    models.push(id);
    capabilities[id] = capability;
    labels[id] = capabilityLabel(row?.name || id, capability);
  }
  return { models, capabilities, labels };
}

function referenceRole(item) {
  if (item?.subType === "first_frame") return "first_frame";
  if (item?.subType === "last_frame") return "last_frame";
  return "reference";
}

function referenceId(item, kind, index) {
  const tag = String(item?.tag || "").replace(/^@/, "").replace(/[^A-Za-z0-9._-]/g, "_");
  return /^[A-Za-z0-9]/.test(tag) ? tag.slice(0, 64) : `${kind}_${index}`;
}

export function aiyrxVideoPayload(model, input) {
  const materials = Array.isArray(input?.materials) ? input.materials : [];
  const uploaded = materials.filter((item) => item?.assetId);
  const linked = materials.filter((item) => item?.url);
  if (uploaded.length && linked.length) {
    throw new Error("AIYRX 不允许在同一请求中混用已上传 asset_id 和公网 URL 素材");
  }
  const payload = {
    model,
    channel: "auto",
    prompt: input.prompt,
    duration_seconds: input.duration,
    aspect_ratio: input.aspectRatio,
  };
  if (uploaded.length) {
    const counts = { image: 0, video: 0, audio: 0 };
    payload.references = uploaded.map((item) => {
      const kind = ["image", "video", "audio"].includes(item.kind) ? item.kind : "image";
      counts[kind] += 1;
      return {
        id: referenceId(item, kind, counts[kind]),
        asset_id: item.assetId,
        role: referenceRole({ ...item, kind }),
      };
    });
  } else {
    for (const kind of ["image", "video", "audio"]) {
      const values = linked.filter((item) => item.kind === kind).map((item) => item.url);
      if (values.length) payload[`${kind}_urls`] = values;
    }
  }
  return payload;
}
