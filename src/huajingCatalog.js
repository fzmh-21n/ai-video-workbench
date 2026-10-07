export const HUAJING_BASE_URL = "https://video.huajings.online";
export const HUAJING_MODELS = ["dlseedance2.5", "zhssseedance2.5-480p", "zhssseedance2.5-720p", "zh00psd2.5"];

export function huajingCapability(cap = {}) {
  return {
    images: cap.inputs?.image ? Number(cap.limits?.images?.maxCount) || 0 : 0,
    audios: cap.inputs?.audio ? Number(cap.limits?.audio?.maxCount) || 0 : 0,
    videos: cap.inputs?.video ? Number(cap.limits?.videos?.maxCount) || 0 : 0,
    durations: cap.durationSeconds?.length ? cap.durationSeconds : [cap.defaults?.durationSeconds || 30],
    resolutions: cap.resolutions?.length ? cap.resolutions : [cap.defaults?.resolution || "720p"],
    ratios: cap.ratios?.length ? cap.ratios : [cap.defaults?.ratio || "16:9"],
    seed: false, syncAudio: false, syncAudioFixed: true,
    _preserveLimits: true, _sdVersion: "sd25",
  };
}

export function huajingPrompt(prompt) {
  return String(prompt).replace(/@(image|audio|video|图片|图|音频|声音|视频)[-]?(\d+)/gi, (_, type, index) => {
    const kind = /^(image|图片|图)$/i.test(type) ? "Image" : /^(audio|音频|声音)$/i.test(type) ? "Audio" : "Video";
    return `@${kind}-${Number(index)}`;
  });
}

export function huajingInputIssue(cap, input) {
  if (cap.enabled === false) return "华镜当前模型已停用";
  for (const [field, value] of [["durationSeconds", input.duration], ["resolutions", input.resolution], ["ratios", input.aspectRatio]]) {
    if (!Array.isArray(cap[field]) || !cap[field].some((option) => String(option) === String(value))) return `华镜模型不支持当前${field}：${value}`;
  }
  if (cap.validCombinations?.length && !cap.validCombinations.some((option) =>
    Number(option.durationSeconds) === Number(input.duration) && option.resolution === input.resolution && option.ratio === input.aspectRatio)) return "华镜模型不支持当前时长、分辨率和比例组合";
  if (cap.limits?.maxPromptBytes && new TextEncoder().encode(input.prompt).length > cap.limits.maxPromptBytes) return "华镜提示词超过 UTF-8 字节上限";
  let totalBytes = 0;
  for (const [kind, field] of [["image", "images"], ["audio", "audio"], ["video", "videos"]]) {
    const items = input.materials.filter((item) => item.kind === kind);
    const limit = cap.limits?.[field] || {};
    if (items.length && (!cap.inputs?.[kind] || !Number.isFinite(Number(limit.maxCount)))) return `华镜当前模型未开放${kind}参考`;
    if (items.length > Number(limit.maxCount || 0)) return `华镜${kind}参考最多 ${limit.maxCount || 0} 个`;
    for (const item of items) {
      const bytes = Number(item.bytes || item.sizeBytes || item.file?.size || item.file?.buffer?.length || 0);
      totalBytes += bytes;
      if (limit.maxBytes && bytes > limit.maxBytes) return `华镜素材超过单文件大小上限：${item.name}`;
      if (item.file && limit.formats?.length) {
        const mime = String(item.file.mimetype || "").toLowerCase();
        const extension = mime.split("/")[1]?.replace(/^x-/, "");
        const aliases = extension === "jpeg" ? ["jpeg", "jpg"] : extension === "mpeg" ? ["mpeg", "mp3"] : extension === "mp4" && kind === "audio" ? ["mp4", "m4a"] : [extension];
        if (!limit.formats.some((format) => [mime, ...aliases].includes(String(format).toLowerCase().replace(/^\./, "")))) return `华镜素材格式不支持：${item.name}`;
      }
      const duration = Number(item.durationSeconds || 0);
      if (limit.maxDurationSeconds && duration > limit.maxDurationSeconds) return `华镜素材超过单条时长上限：${item.name}`;
    }
    if (limit.totalDurationSeconds && items.reduce((sum, item) => sum + Number(item.durationSeconds || 0), 0) > limit.totalDurationSeconds) return `华镜${kind}参考总时长超限`;
  }
  if (cap.limits?.maxUploadBytes && totalBytes > cap.limits.maxUploadBytes) return "华镜参考素材总大小超限";
  const counts = Object.fromEntries(["image", "audio", "video"].map((kind) => [kind, input.materials.filter((item) => item.kind === kind).length]));
  for (const match of huajingPrompt(input.prompt).matchAll(/@(Image|Audio|Video)-(\d+)/g)) {
    if (Number(match[2]) < 1 || Number(match[2]) > counts[match[1].toLowerCase()]) return `华镜素材引用 ${match[0]} 没有对应素材`;
  }
  return "";
}

export function huajingTaskForm(model, input, cap, bytesForFile) {
  const issue = huajingInputIssue(cap, input);
  if (issue) throw new Error(issue);
  const prompt = huajingPrompt(input.prompt);
  const form = new FormData();
  for (const [key, value] of Object.entries({ model, prompt, ratio: input.aspectRatio, resolution: input.resolution, durationSeconds: input.duration })) form.append(key, String(value));
  if (cap.pricingRevision != null && cap.creditCost != null) {
    form.append("expectedPricingRevision", String(cap.pricingRevision));
    form.append("expectedCreditCost", String(cap.creditCost));
  }
  const images = input.materials.filter((item) => item.kind === "image");
  if (images.length) {
    const ids = images.map((item) => item.assetId);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("华镜参考图片必须使用不同的已上传素材 ID");
    form.append("imageReferences", JSON.stringify(images.map((item, index) => ({ id: `image${index + 1}`, assetId: item.assetId, name: `Image-${index + 1}` }))));
    const segments = [];
    let offset = 0;
    for (const match of prompt.matchAll(/@Image-(\d+)/g)) {
      if (match.index > offset) segments.push({ type: "text", value: prompt.slice(offset, match.index) });
      segments.push({ type: "reference", id: `image${match[1]}` });
      offset = match.index + match[0].length;
    }
    if (offset < prompt.length) segments.push({ type: "text", value: prompt.slice(offset) });
    form.append("promptSegments", JSON.stringify(segments));
  } else if (model === "dlseedance2.5") form.append("dola25TextImageContent", prompt);
  // All text fields must precede every file; audio/video URLs are not supported.
  for (const item of input.materials.filter((item) => item.kind !== "image")) {
    if (!item.file) throw new Error(`华镜缺少参考文件：${item.name}`);
    form.append(item.kind === "audio" ? "audio" : "videos", new Blob([bytesForFile(item.file)], { type: item.file.mimetype }), item.file.originalname);
  }
  return form;
}

export function huajingTaskResult(body, baseUrl) {
  if (body?.ok === false || !body?.task?.id) {
    const error = new Error(body?.message || body?.error || "华镜没有返回任务 ID");
    if (body?.ok === false) error.status = 400;
    throw error;
  }
  const task = body.task;
  return { ...task, status: task.status === "interrupted" ? "failed" : task.status,
    videoUrl: task.status === "completed" && task.result?.downloadUrl ? new URL(task.result.downloadUrl, baseUrl).toString() : "" };
}

export async function huajingCreateWithRecovery(request, idempotencyKey, form, baseUrl) {
  try {
    return huajingTaskResult(await request("/v1/tasks", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: form }), baseUrl);
  } catch (error) {
    if (error.status >= 400 && error.status < 500 && error.status !== 408) throw error;
    try {
      return huajingTaskResult(await request(`/v1/tasks/by-idempotency/${encodeURIComponent(idempotencyKey)}`, { method: "GET" }), baseUrl);
    } catch {
      const unknown = new Error(`华镜提交结果未确认，已保存恢复编号 ${idempotencyKey}。为避免重复扣费，不会自动重新提交；请先核对中转后台任务。`);
      unknown.submissionUnknown = true;
      unknown.status = 502;
      throw unknown;
    }
  }
}
