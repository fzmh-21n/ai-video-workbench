export const GLOBAL_AIOPC_BASE_URL = "https://zcbservice.aizfw.cn/kyyReactApiServer";

export const GLOBAL_AIOPC_MODELS = [
  "videos_933_c1",
  "seedance_2_0",
  "seedance_2_0_fast",
  "seedance_2_0_pro",
  "seedance_2_0_fast_pro",
  "sd_2.0_discount_480p",
  "sd_2.0_discount_480p_with_video_ref",
  "sd_2.0_discount_720p",
  "sd_2.0_discount_720p_with_video_ref",
  "sd_2.0_discount_1080p",
  "sd_2.0_discount_1080p_with_video_ref",
  "sd_2.0_fast_discount_480p",
  "sd_2.0_fast_discount_480p_with_video_ref",
  "sd_2.0_fast_discount_720p",
  "sd_2.0_fast_discount_720p_with_video_ref",
  "sd_2.0_special_720p",
  "sd_2.0_special_720p_with_video_ref",
  "sd_2.0_special_1080p",
  "sd_2.0_special_1080p_with_video_ref",
  "sd_2.0_special_2k",
  "sd_2.0_special_2k_with_video_ref",
  "sd_2.0_special_4k",
  "sd_2.0_special_4k_with_video_ref",
  "sd_2.0_fast_special_720p",
  "sd_2.0_fast_special_720p_with_video_ref",
];

const urlsFor = (materials, kind) => (materials || [])
  .filter((item) => item.kind === kind && item.url)
  .map((item) => item.url);

export function globalAiOpcCapability(modelName) {
  const model = String(modelName || "").toLowerCase();
  if (model === "videos_933_c1") {
    return {
      images: 9,
      videos: 3,
      audios: 3,
      durations: Array.from({ length: 12 }, (_, index) => index + 4),
      resolutions: ["480p", "720p", "1080p"],
      ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      seed: false,
      syncAudio: true,
      syncAudioFixed: false,
    };
  }
  const resolution = model.includes("_480p") ? "480p"
    : model.includes("_720p") ? "720p"
      : model.includes("_1080p") ? "1080p"
        : model.includes("_2k") ? "2K"
          : model.includes("_4k") ? "4K"
            : null;
  return {
    images: 9,
    videos: 3,
    audios: 3,
    durations: Array.from({ length: 12 }, (_, index) => index + 4),
    resolutions: resolution ? [resolution] : ["480p", "720p", "1080p"],
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
    seed: model.includes("discount") || model.includes("special"),
    syncAudio: true,
    syncAudioFixed: false,
  };
}

export function globalAiOpcCreatePath(modelName) {
  const model = String(modelName || "").toLowerCase();
  if (model === "videos_933_c1") return "/v2/model-center/tasks";
  if (model.includes("_discount_")) return "/v1/seedance-discount/videos";
  if (model.includes("_special_")) return "/v1/seedance-special/videos";
  return "/v1/kyyvideo2/videos";
}

export function globalAiOpcStatusPath(modelName, taskId) {
  const id = encodeURIComponent(taskId);
  if (String(modelName || "").toLowerCase() === "videos_933_c1") {
    return `/v2/model-center/tasks/${id}`;
  }
  return globalAiOpcCreatePath(modelName) === "/v1/kyyvideo2/videos"
    ? `/v1/kyyvideo2/videos/${id}`
    : `/v1/result/${id}`;
}

export function globalAiOpcPayload(modelName, input = {}) {
  const model = String(modelName || "");
  const materials = input.materials || [];
  if (model.toLowerCase() === "videos_933_c1") {
    const images = materials.filter((item) => item.kind === "image" && item.url);
    const hasFrame = images.some((item) => ["first_frame", "last_frame"].includes(item.subType));
    return {
      model,
      prompt: input.prompt || "",
      reference_images: images.map((item) => item.url),
      reference_videos: urlsFor(materials, "video"),
      reference_audios: urlsFor(materials, "audio"),
      duration: Number(input.duration),
      aspect_ratio: input.aspectRatio,
      resolution: input.resolution,
      face_processing: true,
      generate_audio: Boolean(input.syncAudio),
      reference_mode: hasFrame ? "frame" : "image",
    };
  }
  if (globalAiOpcCreatePath(model) === "/v1/kyyvideo2/videos") {
    const images = materials.filter((item) => item.kind === "image" && item.url);
    const first = images.find((item) => item.subType === "first_frame");
    const last = images.find((item) => item.subType === "last_frame");
    const referenceImages = images
      .filter((item) => item !== first && item !== last)
      .map((item) => item.url);
    return {
      model,
      prompt: input.prompt || "",
      duration: Number(input.duration),
      aspect_ratio: input.aspectRatio,
      generateAudio: Boolean(input.syncAudio),
      ...(referenceImages.length ? { referenceImages } : {}),
      ...(urlsFor(materials, "video").length ? { referenceVideos: urlsFor(materials, "video") } : {}),
      ...(urlsFor(materials, "audio").length ? { referenceAudios: urlsFor(materials, "audio") } : {}),
      ...(first ? { first_image: first.url } : {}),
      ...(last ? { last_image: last.url } : {}),
    };
  }

  const content = [{ type: "text", text: input.prompt || "" }];
  for (const item of materials) {
    if (!item.url) continue;
    if (item.kind === "image") content.push({
      type: "image_url",
      image_url: { url: item.url },
      role: item.subType === "first_frame" ? "first_frame"
        : item.subType === "last_frame" ? "last_frame" : "reference_image",
    });
    if (item.kind === "video") content.push({
      type: "video_url", video_url: { url: item.url }, role: "reference_video",
    });
    if (item.kind === "audio") content.push({
      type: "audio_url", audio_url: { url: item.url }, role: "reference_audio",
    });
  }
  return {
    model,
    content,
    ratio: input.aspectRatio,
    duration: Number(input.duration),
    generate_audio: Boolean(input.syncAudio),
    ...(input.seed !== "" && input.seed != null ? { seed: Number(input.seed) } : {}),
  };
}
