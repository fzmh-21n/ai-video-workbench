export const FMGO_V25_MODEL = "feimiao-v2.5";

export function isFmgoV25Model(modelName) {
  return /^feimiao-v2\.5(?:-(?:480p|720p)-(?:5|10|15|30)s)?$/i.test(String(modelName || ""));
}

export function fmgoV25Capability(modelName = FMGO_V25_MODEL) {
  const encoded = String(modelName || "").toLowerCase().match(/-(480p|720p)-(5|10|15|30)s$/);
  return {
    images: 30,
    videos: 3,
    audios: 3,
    durations: encoded ? [Number(encoded[2])] : [5],
    durationsByResolution: {
      ...(encoded ? { [encoded[1]]: [Number(encoded[2])] } : { "480p": [5] }),
    },
    resolutions: encoded ? [encoded[1]] : ["480p"],
    ratios: ["16:9", "9:16", "1:1"],
    seed: false,
    syncAudio: true,
    syncAudioFixed: false,
    _sdVersion: "sd25",
  };
}

export function fmgoV25ModelName(modelName, duration, resolution) {
  if (String(modelName || "").toLowerCase() !== FMGO_V25_MODEL) return modelName;
  return FMGO_V25_MODEL;
}

export function fmgoV25Payload(modelName, input) {
  const resolution = String(input.resolution || "").toLowerCase();
  const duration = Number(input.duration);
  const encoded = String(modelName || "").toLowerCase().match(/-(480p|720p)-(5|10|15|30)s$/);
  if (encoded && (encoded[1] !== resolution || Number(encoded[2]) !== duration)) {
    throw new Error(`${modelName} 与当前 ${resolution} / ${duration} 秒参数不一致`);
  }
  const allowedDurations = fmgoV25Capability(modelName).durationsByResolution[resolution] || [];
  if (!allowedDurations.includes(duration)) {
    throw new Error(`${FMGO_V25_MODEL} 的 ${resolution || "当前分辨率"} 不支持 ${duration} 秒`);
  }

  const materials = Array.isArray(input.materials) ? input.materials : [];
  const imageMaterials = materials.filter((item) => item.kind === "image");
  const ordinaryImages = imageMaterials.filter((item) => !["first_frame", "last_frame"].includes(item.subType));
  const firstFrame = imageMaterials.find((item) => item.subType === "first_frame");
  const lastFrame = imageMaterials.find((item) => item.subType === "last_frame");
  const videos = materials.filter((item) => item.kind === "video");
  const audios = materials.filter((item) => item.kind === "audio");

  if (imageMaterials.length > 30) throw new Error(`${FMGO_V25_MODEL} 的参考图最多 30 张`);
  if (videos.length > 3) throw new Error(`${FMGO_V25_MODEL} 的视频参考最多 3 个`);
  if (audios.length > 3) throw new Error(`${FMGO_V25_MODEL} 的音频参考最多 3 个`);
  if (lastFrame && !firstFrame) throw new Error(`${FMGO_V25_MODEL} 使用尾帧时必须同时提供首帧`);
  if (audios.length && !ordinaryImages.length && !videos.length) {
    throw new Error(`${FMGO_V25_MODEL} 的音频参考必须同时提供普通参考图或参考视频`);
  }

  const payload = {
    model: fmgoV25ModelName(modelName, duration, resolution),
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio,
    resolution,
    seconds: String(duration),
  };
  if (ordinaryImages.length) payload.images = ordinaryImages.map((item) => item.url);
  if (firstFrame) payload.start_frame = firstFrame.url;
  if (lastFrame) payload.end_frame = lastFrame.url;
  if (videos.length) payload.reference_videos = videos.map((item) => item.url);
  if (audios.length) payload.reference_audios = audios.map((item) => item.url);
  return payload;
}
