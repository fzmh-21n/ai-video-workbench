export const SEEDANCE_VIDEO_BASE_URL = "https://772808.xyz";

const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

function numericValues(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

function resolutionValues(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item?.value || "").trim())
    .filter(Boolean))];
}

function durationLabel(durations) {
  if (!durations.length) return "时长以实时模型列表为准";
  return durations.map((value) => `${value}秒`).join("/");
}

function resolutionLabel(row) {
  const billingMode = row?.billingMode || row?.billing_mode || "per_task";
  const unit = billingMode === "per_second" ? "积分/秒" : "积分/次";
  const values = Array.isArray(row?.resolutions) ? row.resolutions : [];
  return values.map((item) => {
    const name = String(item?.label || item?.value || "").trim();
    const price = Number(item?.price);
    return Number.isFinite(price) ? `${name} ${price}${unit}` : name;
  }).filter(Boolean).join("/");
}

export function seedanceVideoCapability(row = {}) {
  const durations = numericValues(row?.durations);
  const resolutions = resolutionValues(row?.resolutions);
  const text = `${row?.id || ""} ${row?.name || ""}`;
  return {
    // 文档没有公布参考素材数量上限，工作台只保留自己的单次总素材上限，
    // 不额外捏造更小的模型限制；明确不支持的类型则禁用。
    images: 50,
    videos: row?.supports_reference_video === false ? 0 : 50,
    audios: row?.supports_reference_audio === false ? 0 : 50,
    durations,
    resolutions,
    ratios: RATIOS,
    seed: false,
    syncAudio: false,
    syncAudioFixed: true,
    _sdVersion: /(?:seedance|sd)[-. ]?2[.-]?5/i.test(text) || Math.max(0, ...durations) > 15 ? "sd25" : "sd20",
    _preserveLimits: true,
  };
}

export function seedanceVideoModels(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const models = [];
  const capabilities = {};
  const labels = {};
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    const capability = seedanceVideoCapability(row);
    models.push(id);
    capabilities[id] = capability;
    const details = [
      String(row?.name || id).trim(),
      resolutionLabel(row),
      durationLabel(capability.durations),
      row?.supports_reference_video === false ? "不支持视频参考" : "",
      row?.supports_reference_audio === false ? "不支持音频参考" : "",
    ].filter(Boolean);
    labels[id] = details.join(" · ");
  }
  return { models, capabilities, labels };
}

export function seedanceVideoPayload(model, input) {
  const media = (Array.isArray(input?.materials) ? input.materials : [])
    .filter((item) => item?.url)
    .map((item) => ({
      type: item.kind === "audio"
        ? "reference_voice"
        : item.kind === "video"
          ? "reference_video"
          : "reference_image",
      url: item.url,
    }));
  const parameters = {
    resolution: input.resolution,
    ratio: input.aspectRatio,
    duration: input.duration,
  };
  if (!parameters.resolution) delete parameters.resolution;
  if (!parameters.ratio) delete parameters.ratio;
  if (!Number.isInteger(parameters.duration)) delete parameters.duration;
  return {
    model,
    input: {
      prompt: input.prompt,
      ...(media.length ? { media } : {}),
    },
    parameters,
  };
}
