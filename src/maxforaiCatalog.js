export const MAXFORAI_BASE_URL = "https://maxforai.top";

export const MAXFORAI_VIDEO_MODELS = [
  "mg-sd431-fast", "mg-sd431-mini", "mg-sd431-Pro", "mg-seedance-2.5",
  "zy-特价豆包900", "zy-SD满血933",
  "firefly-seedance2-1080p", "firefly-seedance2-480p", "firefly-seedance2-720p",
  "firefly-seedance2-fast-480p", "firefly-seedance2-fast-720p", "MiniMax_H3",
  "sd2-431-720p-fast", "sd2-431-720p-pro", "wf-900-720p-fast", "wf-sd2-5-720p",
  "特价ft-sd2.0fast", "特价ft-sd2.0满血",
  "sd-2.0-1080p", "sd-2.0-480p", "sd-2.0-4k", "sd-2.0-720p",
  "sd-fast-480p", "sd-fast-720p", "sd-mini-480p", "sd-mini-720p",
  "X-miniMAX-H3",
];

function resolutionFor(model) {
  const value = String(model || "").toLowerCase();
  if (value.includes("minimax_h3") || value.includes("minimax-h3")) return ["2K"];
  if (value.includes("1080p")) return ["1080p"];
  if (value.includes("4k")) return ["4K"];
  if (value.includes("480p")) return ["480p"];
  return ["720p"];
}

export function maxforaiCapability(model) {
  const value = String(model || "").toLowerCase();
  const sd25 = value.includes("2.5") || value.includes("sd2-5");
  const h3 = value.includes("minimax_h3") || value.includes("minimax-h3");
  const fixed933 = value === "zy-sd满血933";
  const imageOnly = value === "zy-特价豆包900" || value.includes("900-720p-fast") || value.startsWith("特价ft-");
  return {
    images: sd25 ? 30 : 9,
    videos: sd25 ? 10 : h3 || imageOnly ? 0 : 3,
    audios: sd25 ? 10 : imageOnly ? 0 : 3,
    durations: fixed933 || value === "x-minimax-h3"
      ? [15]
      : imageOnly
        ? [5, 10, 15]
        : Array.from({ length: sd25 ? 27 : 12 }, (_, index) => index + 4),
    resolutions: resolutionFor(model),
    ratios: h3
      ? ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "auto"]
      : ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    seed: false,
    syncAudio: true,
    syncAudioFixed: false,
    _sdVersion: sd25 ? "sd25" : "sd20",
  };
}

export function maxforaiVideoPayload(model, input) {
  const officialSeedance = /^sd-(?:2\.0|fast|mini)-/i.test(model);
  const payload = officialSeedance
    ? {
        model,
        prompt: input.prompt,
        seconds: String(input.duration),
        ratio: input.aspectRatio,
        generate_audio: Boolean(input.syncAudio),
      }
    : {
        model,
        prompt: input.prompt,
        duration: input.duration,
        aspect_ratio: input.aspectRatio,
        resolution: input.resolution,
      };
  if (/^(?:firefly-seedance2|sd2-431)/i.test(model)) payload.generateAudio = Boolean(input.syncAudio);
  for (const kind of ["image", "video", "audio"]) {
    const urls = input.materials.filter((item) => item.kind === kind).map((item) => item.url);
    if (urls.length) payload[`${kind}s`] = urls;
  }
  return payload;
}
