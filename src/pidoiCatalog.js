export const PIDOI_BASE_URL = "https://pidoi.com";
export const PIDOI_MODELS = [
  "tejiasd",
  "sd-2.0-931-720p",
  "sd-2.0-fast-720p",
  "sd-2.5-720p",
];

export function pidoiCapability(model = "tejiasd") {
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
      duration: Number(input.duration),
      aspect_ratio: input.aspectRatio,
      generate_audio: Boolean(input.syncAudio),
    };
    if (images.length) payload.image_urls = images;
    if (videos.length) payload.video_urls = videos;
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
