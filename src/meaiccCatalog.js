export const MEAICC_VIDEO_MODELS = ["seedance-2.0"];

export function meaiccCapability(model = "") {
  const isSd25 = /(?:^|[-_.])(?:sd|seedance)[-_.]?2[-_.]?5(?:[-_.]|$)/i.test(String(model));
  if (isSd25) {
    return {
      images: 30,
      videos: 10,
      audios: 10,
      durations: Array.from({ length: 27 }, (_, index) => index + 4),
      resolutions: ["720p"],
      ratios: ["16:9", "9:16", "1:1"],
      seed: false,
      syncAudio: false,
      syncAudioFixed: false,
      _sdVersion: "sd25",
    };
  }
  return {
    images: 9,
    videos: 3,
    audios: 3,
    durations: [10, 15],
    resolutions: ["720p"],
    ratios: ["16:9", "9:16", "1:1"],
    seed: false,
    syncAudio: false,
    syncAudioFixed: false,
    _sdVersion: "sd20",
  };
}

export function meaiccVideoPayload(model, input) {
  const media = input.materials.map((item) => ({
    type: item.kind === "audio"
      ? "reference_voice"
      : item.kind === "video"
        ? "reference_video"
        : item.subType === "first_frame" || item.subType === "last_frame"
          ? item.subType
          : "reference_image",
    url: item.url,
  }));
  return {
    model,
    input: {
      prompt: input.prompt,
      ...(media.length ? { media } : {}),
    },
    parameters: {
      resolution: input.resolution,
      ratio: input.aspectRatio,
      duration: input.duration,
    },
  };
}

export function meaiccLimitIssue(model, materials, duration) {
  if (!String(model || "").trim()) return "请选择 MEAICC 视频模型";
  const capability = meaiccCapability(model);
  const counts = (materials || []).reduce(
    (result, item) => {
      const kind = ["image", "audio", "video"].includes(item?.kind) ? item.kind : "image";
      result[kind] += 1;
      return result;
    },
    { image: 0, audio: 0, video: 0 },
  );
  for (const kind of ["image", "audio", "video"]) {
    const limit = capability[`${kind}s`];
    if (counts[kind] > limit) {
      const label = kind === "image" ? "图片" : kind === "audio" ? "音频" : "视频";
      return `${model} 的${label}参考最多 ${limit} 个，当前提交了 ${counts[kind]} 个`;
    }
  }
  if (!capability.durations.includes(duration)) {
    const first = capability.durations[0];
    const last = capability.durations.at(-1);
    return `${model} 不支持 ${duration} 秒，请选择 ${first === last ? `${first} 秒` : `${first}–${last} 秒`}`;
  }
  const inputVideoSeconds = (materials || [])
    .filter((item) => item?.kind === "video")
    .reduce((total, item) => total + (Number(item.durationSeconds) || 0), 0);
  if (capability._sdVersion !== "sd25" && inputVideoSeconds + duration > 25) {
    return `输入视频与输出视频总时长不能超过 25 秒；当前为 ${inputVideoSeconds + duration} 秒`;
  }
  return "";
}
