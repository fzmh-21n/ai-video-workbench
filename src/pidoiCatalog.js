export const PIDOI_BASE_URL = "https://pidoi.com";
export const PIDOI_MODELS = [
  "sora-v3-933-pro",
  "tejiasd",
  "sd-2.0-931-720p",
  "sd-2.0-fast-720p",
  "sd-2.5-720p",
];

export function pidoiCapability(model = "tejiasd") {
  if (model === "sora-v3-933-pro") {
    return {
      images: 9,
      videos: 3,
      audios: 3,
      durations: [15],
      resolutions: ["720p"],
      ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
      seed: false,
      syncAudio: true,
      syncAudioFixed: false,
      _sdVersion: "sd20",
    };
  }
  if (model === "sd-2.5-720p") {
    return {
      images: 30,
      videos: 10,
      audios: 1,
      durations: Array.from({ length: 26 }, (_, index) => index + 4),
      resolutions: ["720p"],
      ratios: ["16:9", "9:16", "1:1"],
      seed: false,
      syncAudio: true,
      syncAudioFixed: false,
      _sdVersion: "sd25",
    };
  }
  if (model === "sd-2.0-931-720p" || model === "sd-2.0-fast-720p") {
    return {
      images: 9,
      videos: 3,
      audios: 1,
      durations: Array.from({ length: 12 }, (_, index) => index + 4),
      resolutions: [model === "sd-2.0-fast-720p" ? "480p" : "720p"],
      ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      seed: false,
      syncAudio: true,
      syncAudioFixed: false,
      _sdVersion: "sd20",
    };
  }
  return {
    images: 9,
    videos: 3,
    audios: 3,
    durations: Array.from({ length: 15 }, (_, index) => index + 1),
    resolutions: ["720p"],
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    seed: true,
    syncAudio: true,
    syncAudioFixed: false,
  };
}

export function pidoiVideoPayload(model, input) {
  const urls = (kind) => input.materials.filter((item) => item.kind === kind).map((item) => item.url);
  const images = urls("image");
  const videos = urls("video");
  const audios = urls("audio");
  if (model !== "tejiasd") {
    const payload = {
      model,
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio,
      resolution: String(input.resolution || pidoiCapability(model).resolutions[0] || "720p").toLowerCase(),
      seconds: String(input.duration),
    };
    if (images.length) payload.image_url = images[0];
    if (images.length > 1) payload.reference_image_urls = images.slice(1);
    if (videos.length) payload.reference_videos = videos;
    if (audios.length) payload.audio_urls = audios;
    return payload;
  }
  const payload = {
    model: "tejiasd",
    prompt: input.prompt,
    duration: Number(input.duration),
    resolution: "720P",
    n: 1,
    metadata: { aspect_ratio: input.aspectRatio },
  };
  if (images.length) payload.images = images;
  if (videos.length) payload.videos = videos;
  if (audios.length) payload.audios = audios;
  if (input.seed !== null && input.seed !== undefined) payload.seed = Number(input.seed);
  return payload;
}

export function pidoiLimitIssue(model, materials = [], duration) {
  if (model !== "sora-v3-933-pro") return "";
  const capability = pidoiCapability(model);
  if (!capability.durations.includes(Number(duration))) return `${model} 当前只支持 15 秒`;
  if (materials.length > 12) return `${model} 单次请求的图片、视频和音频合计最多 12 个，当前为 ${materials.length} 个`;
  if (materials.some((item) => item?.kind === "image" && item?.subType === "last_frame"))
    return `${model} 不支持尾帧图，请改为参考图或删除尾帧素材`;
  for (const kind of ["video", "audio"]) {
    const label = kind === "video" ? "参考视频" : "参考音频";
    const selected = materials.filter((item) => item?.kind === kind);
    const knownDurations = selected.map((item) => Number(item?.durationSeconds)).filter((value) => Number.isFinite(value) && value > 0);
    const invalid = knownDurations.find((value) => value < 2 || value > 15);
    if (invalid != null) return `${label}单条时长必须为 2–15 秒，当前检测到 ${invalid} 秒`;
    const total = knownDurations.reduce((sum, value) => sum + value, 0);
    if (total > 15) return `${label}总时长不能超过 15 秒，当前为 ${total} 秒`;
  }
  return "";
}
