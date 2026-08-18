export const CLMM_BASE_URL = "https://clmm-mall.top";

const range = (start, end) => Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);

export function clmmModels(body) {
  const source = body?.models ?? body?.data?.models ?? body?.data ?? body?.pricing ?? body;
  const rows = Array.isArray(source) ? source : source && typeof source === "object" ? Object.entries(source) : [];
  const values = [];
  for (const row of rows) {
    if (typeof row === "string") values.push(row);
    else if (Array.isArray(row)) {
      const [key, value] = row;
      if (value && typeof value === "object") values.push(value.model || value.id || value.name || key);
    } else if (row && typeof row === "object") values.push(row.model || row.id || row.name);
  }
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function clmmModelRules(modelName) {
  const model = String(modelName || "").trim();
  const secondsMatch = model.match(/(?:^|-)(\d+)s(?:-|$)/i);
  const resolutionMatch = model.match(/(?:^|-)(\d{3,4})([pP])(?:-|$)/);
  const imageMatch = model.match(/(?:^|-)(\d+)img(?:-|$)/i);
  const fixed = /(?:^|-)gz(?:-|$)/i.test(model);
  const noVideos = /(?:^|-)nv(?:-|$)/i.test(model);
  const maxSeconds = secondsMatch ? Number(secondsMatch[1]) : null;
  return {
    model,
    maxSeconds,
    fixed,
    resolution: resolutionMatch ? `${resolutionMatch[1]}${resolutionMatch[2]}` : "480p",
    minImages: imageMatch ? Number(imageMatch[1]) : 0,
    noVideos,
    invalid: fixed && !maxSeconds,
  };
}

export function clmmCapability(model) {
  const rules = clmmModelRules(model);
  return {
    images: 9,
    videos: rules.noVideos ? 0 : 3,
    audios: 3,
    durations: rules.fixed && rules.maxSeconds
      ? [rules.maxSeconds]
      : rules.maxSeconds
        ? range(1, rules.maxSeconds)
        : range(1, 15),
    resolutions: [rules.resolution],
    ratios: ["16:9", "9:16"],
    seed: false,
    syncAudio: true,
    syncAudioFixed: false,
  };
}

export function clmmLimitIssue(model, materials, duration) {
  const rules = clmmModelRules(model);
  if (!rules.model) return "请选择 CLMM Mall 视频模型";
  if (rules.invalid) return `${rules.model} 包含 -gz，但缺少 -Ns 固定时长后缀`;
  const images = materials.filter((item) => item?.kind === "image").length;
  const videos = materials.filter((item) => item?.kind === "video").length;
  if (images < rules.minImages) return `${rules.model} 至少需要 ${rules.minImages} 张参考图，当前只有 ${images} 张`;
  if (rules.noVideos && videos) return `${rules.model} 带 -nv，不能提交参考视频`;
  if (rules.maxSeconds && (!Number.isInteger(duration) || duration < 1 || duration > rules.maxSeconds))
    return `${rules.model} 仅支持 1–${rules.maxSeconds} 秒`;
  if (rules.fixed && duration !== rules.maxSeconds) return `${rules.model} 是固定 ${rules.maxSeconds} 秒模型`;
  return "";
}

export function clmmVideoPayload(model, input) {
  const rules = clmmModelRules(model);
  const issue = clmmLimitIssue(model, input.materials, Number(input.duration));
  if (issue) throw new Error(issue);
  const images = input.materials.filter((item) => item.kind === "image").map((item) => item.url);
  const videos = input.materials.filter((item) => item.kind === "video").map((item) => item.url);
  const audios = input.materials.filter((item) => item.kind === "audio").map((item) => item.url);
  const payload = {
    model,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio,
    resolution: rules.resolution,
    size: input.aspectRatio === "9:16" ? "720x1280" : "1280x720",
    seconds: rules.maxSeconds ? "1" : String(input.duration),
    reference_image_urls: images.length ? images : null,
    reference_videos: rules.noVideos || !videos.length ? null : videos,
    reference_audios: audios.length ? audios : null,
    persist: false,
  };
  if (rules.maxSeconds) payload.mySeconds = String(rules.fixed ? rules.maxSeconds : input.duration);
  return payload;
}
