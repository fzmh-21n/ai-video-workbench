export const SUANLIAI_BASE_URL = "https://suanliai.top";

const range = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);

export const SUANLIAI_004_MODELS = [
  "004系列/minimax_h3(8图3音频)",
  "004系列/minimax-h3 2k",
  "004系列/minimax-h3 768p",
  "004系列/Minimax-H3(933/10-15秒768P)",
  "004系列/seedance-2.0-fast-deal(903不卡人脸480P)",
  "004系列/seedance-2.0-fast-deal(903不卡人脸720P)",
  "004系列/sd2.0(满血5-15秒720P)",
  "004系列/sd2.0(支持过人脸5/10秒720P)",
  "004系列/sd2.0(支持过人脸全系4-15秒720P)",
  "004系列/sd2.0(933/4-15秒支持过人脸720P)",
  "004系列/sd2.0(933/10-15秒720P)",
  "004系列/sd2.0(933/480p最多15秒/720p最多12秒)",
  "004系列/sd2.5(全系支持过人脸4-30秒/720P)",
  "004系列/sd2.5(全系支持过人脸4-30秒720P)",
  "004系列/sd2.5(原生过人脸9图720P)",
  "004系列/sd2.5(30图4-30秒480P/720P)",
  "004系列/sd2.5(10-10-10支持过人脸4-30秒720P)",
  "004系列/sd2.5(30-10-10支持过人脸4-30秒720P)",
  "004系列/video-editing(换脸/视频编辑必须上传1视频1图换脸用)",
  "004系列/grok(支持文生首帧图片参考)",
  "004系列/grok(文生首尾帧图2-7图参考)",
];

export const SUANLIAI_ALL_MODELS = [
  "全能sd2.0(不卡脸mini933-12s)",
  "全能sd2.0(首转专线原生过脸fast-933-720p)",
  "全能sd2.0(首转专线满血原生过脸-933-720p)",
  "全能sd2.0(满血原生过脸-933-480p)",
  "全能sd2.0(满血原生过脸-933-720p)",
  "全能sd2.5(满血内置过脸-30图-720p)",
  "全能sd2.0(原生过脸mini-930-480p)",
  "全能sd2.0(满血内置过脸-900-720p)",
  "全能sd2.0(原生过脸mini2-930-480p)",
  "MINIMAX-H3-2K(原生过脸9-3-3)",
  "MINIMAX-H3-769p(原生过脸9-3-3)",
  "Wan3-480p(满血原生过脸4-30秒10-5-5)",
  "Wan3-720p(满血原生过脸4-30秒10-5-5)",
  "veo-omni-video",
  "全能sd2.5(满血内置过脸30图超分1080P)",
  "全能sd2.5(满血原生过脸30-10-10/480P)",
  "全能sd2.5(原生过脸30-10-10超分720P)",
  "首转长期稳定全能sd2.5(只卡真人30-10-10/480P)",
  "首转长期稳定全能sd2.5(只卡真人30-10-10/720P)",
];

export const SUANLIAI_DEAL_MODELS = [
  "官转稳定sd2.0(933原生过真人480P)",
  "官转稳定sd2.0(933原生过真人720P)",
  "官转稳定sd2.5(满血30-10-10不卡脸1080P)",
  "sd2.0(满血9-3-3不卡脸720P)",
  "sd2.5(满血30-10-10不卡脸720P)",
  "特价/sd-2.5",
  "特价/官方h3-720p",
  "特价/官方h3-1080p",
  "特价/官方h3-2k",
  "特价/h3-480p（特惠）",
  "特价/h3-768p（特惠）",
  "特价/minimax_h3-768p",
  "特价/minimax_h3-1080p",
  "特价/minimax_h3-2K",
  "特价/wan3.0-video",
  "特价/wan3.0-video-480p",
  "特价/wan3.0-video-720p",
  "特价/wan3.0-video-1080p",
  "特价/wan3.0-video-prime",
  "特价/wan3.0-video-prime-480p",
  "特价/wan3.0-video-prime-720p",
  "特价/wan3.0-video-prime-1080p",
  "特价/wan3.0-image",
  "特价/wan3.0-image-480p",
  "特价/wan3.0-image-720p",
  "特价/wan3.0-image-1080p",
  "特价/wan3.0-image-prime",
  "特价/wan3.0-image-prime-480p",
  "特价/wan3.0-image-prime-720p",
  "特价/wan3.0-image-prime-1080p",
  "特价/grok-imagine-video-1.5（按次）",
];

export const SUANLIAI_OFFICIAL_MODELS = [
  "官转稳定-sd2-480p(933满血不卡脸)",
  "官转稳定-sd2-1080p(933满血不卡脸)",
  "官转稳定-sd2-720p(933满血不卡脸)",
  "官转稳定-sd2-4k(933满血不卡脸4K)",
  "官转稳定-sd2.5-480p(30-10-10/4-30秒不卡真人无限并发速度极快)",
  "官转稳定-sd2.5-720p(30-10-10/4-30秒不卡真人无限并发速度极快)",
  "官转稳定-sd2.5-1080p(30-10-10/4-30秒不卡真人无限并发速度极快)",
  "推荐稳定sd2.0vip720p(933不卡脸不排队满血)",
  "热门稳定SD2.5-720p(30-10-10不卡脸/4-30秒)",
  "sd2.5-720p-ch3(30-10-10不卡脸/4-30秒无限并发)",
  "长期稳定sd2.5-720p-ch2(30-10-10不卡脸满血不支持视频参考速度快)",
  "rd2.0-480p(933不排队速度极快概率不卡真人不卡3D)",
  "SD2.5-480p(30-10-10不卡脸4-30秒)",
  "SD2.5-1080p(30-10-10不卡脸/4-30秒)",
  "sd2-福利(8点-20点可用/4-3-1不卡脸不排队)",
  "SD2.0-720P(9图不卡脸不排队云端过彩绘)",
  "特价稳定-sd2.5-720p-ch1(9图30秒小几率卡脸内置彩绘过脸)",
  "sp2.5-720p-15s(10图不卡脸4-30秒不支持视频音频参考)",
  "sp2.5-720p-30s(10图不卡脸4-30秒不支持视频音频参考)",
  "sd2.5-cf-720p(30图10音不卡脸4-30秒超分模型)",
  "特价稳定quanneng2.0(933不卡脸不排队满血)",
  "特价稳定B-quannengship2.0(933不卡脸不排队满血)",
  "优质rd2.0-720p(933不排队速度极快不卡脸满血)",
  "优质rd2.0-1080p(933不排队速度极快不卡脸满血)",
  "优质sd2.0vip4k(9-3-3不排队速度极快不卡脸4K满血)",
  "rd2.5-480p(30-10-10/4-30秒无限并发)",
  "稳定-wan3.0-720p(10-5-5不卡脸30秒无限并发)",
  "特价稳定-sp2.5(30图30秒720P)",
  "rd2.5-720p(30-10-10/4-30秒无限并发)",
  "wan3.0-480p(10-5-5不卡脸30秒无限并发)",
  "wan3.0-720p(10-5-5不卡脸30秒无限并发)",
  "wan3.0-1080p(10-5-5不卡脸30秒无限并发)",
  "稳定minimax-h3-pro-768p(930不排队不卡脸)",
  "minimax-h3-pro-2k(9-3-3不排队速度极快2K)",
  "minimax-h3-4k(9-3-3不排队速度极快2K)",
  "特价稳定sdquan-2-miao(930不排队不卡脸满血)",
  "wan3.0-1080p(10-5-5不卡脸无限并发)",
  "稳定sd2.0vip1080p(9-3-3不排队不卡真人)",
  "稳定hailuo-h3-2k(9图3音不排队速度极快2K)",
  "SD2.0-720p-fast(933不卡脸不排队)",
  "sd2-vip720p(900不排队云端彩绘过脸)",
  "快乐马-kuaile1.0",
];

export const SUANLIAI_VIDEO_MODELS = [...new Set([
  ...SUANLIAI_004_MODELS,
  ...SUANLIAI_ALL_MODELS,
  ...SUANLIAI_DEAL_MODELS,
  ...SUANLIAI_OFFICIAL_MODELS,
])];

const documentedModels = new Set(SUANLIAI_VIDEO_MODELS);
const allModels = new Set(SUANLIAI_ALL_MODELS);
const dealModels = new Set(SUANLIAI_DEAL_MODELS);

export function suanliaiSeries(modelName) {
  const model = String(modelName || "");
  if (model.startsWith("004系列/")) return "004";
  if (model.startsWith("003系列/")) return "003";
  if (model.startsWith("002系列/")) return "002";
  if (allModels.has(model) || model.startsWith("全能") || model.startsWith("首转长期稳定全能")) return "all";
  if (dealModels.has(model) || model.startsWith("特价/")) return "deal";
  return "official";
}

export function suanliaiRoutes(modelName) {
  const series = suanliaiSeries(modelName);
  if (series === "all") return { createPath: "/api/v1/videos", statusBasePath: "/api/v1/videos", content: false };
  if (series === "official") return { createPath: "/v1/video/generations", statusBasePath: "/v1/video/generations", content: false };
  if (series === "003") return { createPath: "/v1/videos", statusBasePath: "/v1/tasks", content: false };
  return { createPath: "/v1/videos", statusBasePath: "/v1/videos", content: series === "004" || series === "deal" };
}

export function suanliaiUploadPath(modelName) {
  const series = suanliaiSeries(modelName);
  if (series === "003") return "/v1/media";
  if (series === "official") return "/v1/assets/uploads";
  return "";
}

const urlsFor = (materials, kind) => (materials || [])
  .filter((item) => item.kind === kind)
  .map((item) => item.url)
  .filter(Boolean);

const addArrays = (payload, names, values) => {
  for (const [name, list] of Object.entries(names)) if (list.length) payload[name] = values(list);
  return payload;
};

export function suanliaiVideoPayload(modelName, input) {
  const series = suanliaiSeries(modelName);
  const images = urlsFor(input.materials, "image");
  const videos = urlsFor(input.materials, "video");
  const audios = urlsFor(input.materials, "audio");
  const base = { model: modelName, prompt: input.prompt };

  if (series === "004") {
    return addArrays({ ...base, seconds: input.duration, ratio: input.aspectRatio, resolution: input.resolution },
      { images, videos, audios }, (list) => list);
  }
  if (series === "all") {
    return addArrays({ ...base, seconds: String(input.duration), aspect_ratio: input.aspectRatio, resolution: input.resolution },
      { images, videos, audios }, (list) => list);
  }
  if (series === "002") {
    return addArrays({ ...base, duration: input.duration, ratio: input.aspectRatio, resolution: input.resolution },
      { referenceImages: images, referenceVideos: videos, referenceAudios: audios }, (list) => list);
  }
  if (series === "003") {
    return addArrays({
      ...base,
      duration: input.duration,
      ratio: input.aspectRatio,
      resolution: input.resolution,
      generate_audio: input.syncAudio,
    }, { images, reference_videos: videos, reference_audios: audios }, (list) => list);
  }
  if (series === "deal") {
    if (modelName === "特价/sd-2.5") {
      return addArrays({ ...base, resolution: "720p", aspect_ratio: input.aspectRatio }, { images }, (list) => list);
    }
    const material = (url, role, index) => ({
      url,
      ...(role ? { role } : {}),
      ...(role === "reference_video" && Number(input.materials?.filter((item) => item.kind === "video")?.[index]?.durationSeconds) > 0
        ? { duration: Math.ceil(Number(input.materials.filter((item) => item.kind === "video")[index].durationSeconds)) }
        : {}),
    });
    return addArrays({ ...base, seconds: input.duration, aspect_ratio: input.aspectRatio, resolution: input.resolution }, {
      reference_images: images,
      reference_videos: videos,
      reference_audios: audios,
    }, (list) => list.map((url, index) => material(url,
      list === images ? "reference_image" : list === videos ? "reference_video" : "reference_audio", index)));
  }
  return addArrays({
    ...base,
    duration: input.duration,
    ratio: input.aspectRatio,
    resolution: input.resolution,
    generate_audio: input.syncAudio,
  }, { images, reference_videos: videos, reference_audios: audios }, (list) => list);
}

export function suanliaiReferencePrompt(modelName, prompt, materials, enabled) {
  if (!enabled || !(materials || []).length) return prompt;
  const series = suanliaiSeries(modelName);
  const counters = { image: 0, video: 0, audio: 0 };
  const normalized = series === "004"
    ? String(prompt || "")
      .replace(/@(?:image|图片)(\d+)/gi, "Image $1")
      .replace(/@video(\d+)/gi, "Video $1")
      .replace(/@audio(\d+)/gi, "Audio $1")
    : series === "002"
      ? String(prompt || "")
      .replace(/@(?:image|图片)(\d+)/gi, "@图$1")
      .replace(/@video(\d+)/gi, "@视频$1")
      .replace(/@audio(\d+)/gi, "@音频$1")
      : String(prompt || "");
  const lines = materials.map((item) => {
    counters[item.kind] = (counters[item.kind] || 0) + 1;
    const index = counters[item.kind];
    const label = item.kind === "image" ? "图" : item.kind === "video" ? "视频" : "音频";
    return series === "004"
      ? `${item.kind === "image" ? "Image" : item.kind === "video" ? "Video" : "Audio"} ${index} = ${item.name || "参考素材"}`
      : series === "002"
        ? `@${label}${index}=${item.name || "参考素材"}`
        : `@${item.kind === "image" ? "Image" : item.kind === "video" ? "Video" : "Audio"}${index}=${item.name || "参考素材"}`;
  });
  return `${normalized}\n\n参考素材映射：\n${lines.join("\n")}`;
}

function resolutionFromName(model) {
  const value = String(model).match(/(?:^|[^0-9])(480p|720p|768p|769p|1080p|2k|4k)(?:[^0-9]|$)/i)?.[1]?.toLowerCase();
  if (value === "769p") return "768p";
  return value || "720p";
}

export function suanliaiCapability(modelName) {
  const model = String(modelName || "");
  const lower = model.toLowerCase();
  const series = suanliaiSeries(model);
  let images = 9;
  let videos = 3;
  let audios = 3;
  let durations = lower.includes("2.5") || lower.includes("wan3") ? range(4, 30) : range(4, 15);
  let resolutions = [resolutionFromName(model)];

  const triplet = model.match(/(30|10|9|8|5|4)-(10|5|3|0)-(10|5|3|1|0)/);
  if (triplet) [images, videos, audios] = triplet.slice(1).map(Number);
  if (/30图/.test(model)) images = 30;
  if (/10图/.test(model)) images = 10;
  if (/9图/.test(model)) images = 9;
  if (/8图/.test(model)) images = 8;
  if (/3音/.test(model)) audios = 3;
  if (/10音/.test(model)) audios = 10;
  if (/不支持视频/.test(model)) videos = 0;
  if (/不支持(?:参考)?视频(?:和|、)?音频|不支持视频音频/.test(model)) videos = audios = 0;
  if (/9图不卡脸/.test(model) || /900/.test(model)) videos = audios = 0;
  if (/30图.*(?:内置|固定30秒)|特价\/sd-2\.5/.test(model)) videos = audios = 0;
  if (/minimax|h3/i.test(model) && !/(?:9-3-3|视频)/.test(model)) videos = 0;
  if (/grok/i.test(model)) {
    images = model.includes("2-7图") ? 7 : 1;
    videos = audios = 0;
  }
  if (/video-editing/.test(model)) {
    images = 1;
    videos = 1;
    audios = 0;
    durations = range(4, 30);
  }
  if (model === "特价/sd-2.5") {
    images = 10;
    videos = audios = 0;
    durations = [30];
  }
  if (model === "全能sd2.0(不卡脸mini933-12s)") durations = [12];
  if (model === "全能sd2.0(原生过脸mini-930-480p)") {
    images = 9;
    videos = 3;
    audios = 0;
  }
  if (model === "全能sd2.0(原生过脸mini2-930-480p)") {
    images = 30;
    videos = audios = 0;
  }
  if (/^全能sd2\.5\(满血内置过脸/.test(model)) {
    images = 30;
    videos = audios = 0;
    durations = [30];
  }
  if (/固定 ?30秒|30秒小|30图30秒|9-0-0\/30秒/.test(model)) durations = [30];
  else if (/15s\(/i.test(model)) durations = range(4, 15);
  else if (/30s\(/i.test(model)) durations = range(16, 30);
  else if (/固定 ?15秒|quanneng2\.0|quannengship2\.0|sd2-vip720p/.test(model)) durations = [15];
  else if (/5\/10\/15秒|5\/10\/15/.test(model)) durations = [5, 10, 15];
  else if (/5\/10秒/.test(model)) durations = [5, 10];
  else if (/6\/10秒/.test(model)) durations = [6, 10];
  else if (/10-15秒/.test(model)) durations = range(10, 15);
  else if (/5-15秒|5～15秒/.test(model)) durations = range(5, 15);
  else if (/4-30秒/.test(model)) durations = range(4, 30);
  else if (/5-30秒/.test(model)) durations = range(5, 30);
  else if (/4-15秒/.test(model)) durations = range(4, 15);
  if (model.includes("480P/720P") || model.includes("480p / 720p")) resolutions = ["480p", "720p"];
  if (model.includes("720P/1080P")) resolutions = ["720p", "1080p"];
  if (series === "deal" && /wan3\.0-(?:video|image)(?:-prime)?$/.test(model)) resolutions = ["480p", "720p", "1080p"];

  return {
    images,
    videos,
    audios,
    durations,
    resolutions,
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    seed: false,
    syncAudio: true,
    syncAudioFixed: false,
    _sdVersion: lower.includes("2.5") || lower.includes("wan3") ? "sd25" : "sd20",
    _preserveLimits: true,
  };
}

function modelItems(body) {
  const candidates = [body?.data?.models, body?.data, body?.models];
  return candidates.find(Array.isArray) || [];
}

function isVideoItem(item) {
  if (typeof item === "string") return documentedModels.has(item) || /(?:video|seedance|sd2|wan3|minimax|h3|grok|全能|官转|rd2|sp2|quanneng|hailuo|快乐马)/i.test(item);
  const type = String(item?.type || item?.object || "").toLowerCase();
  const endpointTypes = Array.isArray(item?.supported_endpoint_types) ? item.supported_endpoint_types.join(" ").toLowerCase() : "";
  const taskKinds = Array.isArray(item?.tasks) ? item.tasks.map((task) => task?.taskKind).join(" ").toLowerCase() : "";
  if (type || endpointTypes || taskKinds) return /video/.test(`${type} ${endpointTypes} ${taskKinds}`);
  return isVideoItem(String(item?.id || item?.name || ""));
}

export function suanliaiCatalog(...bodies) {
  const items = bodies.flatMap(modelItems).filter(isVideoItem);
  const models = [...new Set(items.map((item) => typeof item === "string" ? item : item?.id || item?.name).filter(Boolean))];
  const capabilities = {};
  const labels = {};
  for (const item of items) {
    const id = typeof item === "string" ? item : item?.id || item?.name;
    if (!id) continue;
    const documented = suanliaiCapability(id);
    const live = typeof item === "object" ? item.capabilities || {} : {};
    capabilities[id] = {
      ...documented,
      ...(Array.isArray(live.aspect_ratios) ? { ratios: live.aspect_ratios } : {}),
      ...(Array.isArray(live.resolutions) ? { resolutions: live.resolutions } : {}),
    };
    labels[id] = typeof item === "object" && item.name && item.name !== id ? `${item.name} · ${id}` : id;
  }
  return { models, capabilities, labels };
}
