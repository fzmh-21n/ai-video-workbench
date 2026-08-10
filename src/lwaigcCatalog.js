export const LWAIGC_VIDEO_MODELS = [
  "firefly-seedance2-1080p",
  "firefly-seedance2-720p",
  "firefly-seedance2-480p",
  "firefly-seedance2-fast-720p",
  "firefly-seedance2-fast-480p",
  "ft-seedance2.0-pro",
  "sd2-431-720p-fast",
  "sd2-431-720p-pro",
  "mg-sd431-mini",
  "mg-sd431-fast",
  "mg-sd431-Pro",
  "dbb-Q933-pro",
  "dbb-H933-pro",
  "dbb-Q933-pro-face",
  "dbb-sd431-720p-fast",
  "hn-sd官渠903-pro",
  "hn-sd903-pro",
  "hn-sd431-pro",
  "hn-sd431-fast",
  "mf-seedance2.5",
  "wf-sd2.5-720p",
  "MiniMax-H3",
  "grok-imagine-video-1.5-preview",
];

const range = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);

export function lwaigcCapability(modelName) {
  const model = String(modelName || "");
  const fixedResolution = model.match(/-(480p|720p|1080p)(?:-|$)/i)?.[1]?.toLowerCase() || "720p";
  const common = {
    images: 9,
    videos: 3,
    audios: 3,
    durations: range(4, 15),
    resolutions: [fixedResolution],
    ratios: ["16:9", "9:16", "1:1"],
    seed: false,
    syncAudio: false,
    syncAudioFixed: false,
  };

  if (model === "ft-seedance2.0-pro") {
    return { ...common, videos: 0, resolutions: ["720p"], ratios: ["9:16", "16:9", "1:1", "4:3", "3:4"] };
  }
  if (["sd2-431-720p-fast", "sd2-431-720p-pro"].includes(model)) {
    return { ...common, images: 4, audios: 1, resolutions: ["720p"] };
  }
  if (["mg-sd431-mini", "mg-sd431-fast", "mg-sd431-Pro"].includes(model)) {
    return { ...common, images: 4, audios: 1, resolutions: ["480p", "720p"] };
  }
  if (["dbb-Q933-pro", "dbb-H933-pro", "dbb-Q933-pro-face"].includes(model)) {
    return { ...common, durations: [10, 15], resolutions: ["720p"] };
  }
  if (model === "dbb-sd431-720p-fast") {
    return { ...common, images: 4, audios: 1, durations: [5, 10, 15], resolutions: ["720p"] };
  }
  if (["hn-sd官渠903-pro", "hn-sd903-pro"].includes(model)) {
    return { ...common, videos: 0, durations: [15], resolutions: ["720p"] };
  }
  if (["hn-sd431-pro", "hn-sd431-fast"].includes(model)) {
    return { ...common, images: 4, audios: 1, durations: [10, 15], resolutions: ["720p"] };
  }
  if (model === "mf-seedance2.5") {
    return { ...common, images: 30, videos: 10, audios: 10, durations: range(4, 30), resolutions: ["480p", "720p"] };
  }
  if (model === "wf-sd2.5-720p") {
    return { ...common, images: 30, videos: 10, audios: 10, durations: range(4, 29), resolutions: ["720p"] };
  }
  if (model === "MiniMax-H3") {
    return { ...common, videos: 0, durations: range(5, 15), resolutions: ["2K"] };
  }
  if (model === "grok-imagine-video-1.5-preview") {
    return { ...common, images: 1, videos: 0, audios: 0, durations: [6, 10, 15], resolutions: ["720p"] };
  }
  return common;
}

export function lwaigcVideoPayload(model, input, clientTaskId) {
  const images = input.materials.filter((item) => item.kind === "image").map((item) => item.url);
  const videos = input.materials.filter((item) => item.kind === "video").map((item) => item.url);
  const audios = input.materials.filter((item) => item.kind === "audio").map((item) => item.url);
  const payload = {
    model,
    client_task_id: clientTaskId,
    prompt: input.prompt,
    seconds: input.duration,
  };

  if (model === "grok-imagine-video-1.5-preview") {
    payload.images = images.slice(0, 1);
    payload.size = {
      "9:16": "720x1280",
      "1:1": "1024x1024",
    }[input.aspectRatio] || "1280x720";
    return payload;
  }

  payload.aspect_ratio = input.aspectRatio;
  if (["mg-sd431-mini", "mg-sd431-fast", "mg-sd431-Pro", "mf-seedance2.5"].includes(model)) {
    payload.resolution = input.resolution;
  }
  if (images.length) payload.image_urls = images;
  if (videos.length) payload.video_urls = videos;
  if (audios.length) payload.audio_urls = audios;
  return payload;
}

export function lwaigcLimitIssue(model, materials, duration) {
  if (!LWAIGC_VIDEO_MODELS.includes(model)) return "请选择 LWAIGC 视频模型";
  const capability = lwaigcCapability(model);
  const counts = (materials || []).reduce(
    (result, item) => {
      const kind = ["image", "audio", "video"].includes(item?.kind) ? item.kind : "image";
      result[kind] += 1;
      return result;
    },
    { image: 0, audio: 0, video: 0 },
  );
  for (const kind of ["image", "audio", "video"]) {
    const limit = capability[`${kind}s`] ?? 0;
    if (counts[kind] > limit) {
      const label = kind === "image" ? "图片" : kind === "audio" ? "音频" : "视频";
      return `${model} 的${label}参考最多 ${limit} 个，当前提交了 ${counts[kind]} 个`;
    }
  }
  if (!capability.durations.includes(duration)) {
    return `${model} 不支持 ${duration} 秒，请选择模型允许的时长`;
  }
  return "";
}
