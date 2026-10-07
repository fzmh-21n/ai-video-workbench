export const BAILING_BASE_URL = "https://bailingapi.top";
export const BAILING_EXAMPLE_MODEL = "d1-min-c1";

export function bailingModels(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return [...new Set(list.map((item) => typeof item === "string" ? item : item?.id || item?.name).filter(Boolean))];
}

export function bailingVideoPayload(model, input) {
  const payload = {
    model,
    prompt: input.prompt,
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
  };
  for (const [kind, field] of [
    ["image", "reference_images"],
    ["video", "reference_videos"],
    ["audio", "reference_audios"],
  ]) {
    const urls = input.materials.filter((item) => item.kind === kind).map((item) => item.url);
    if (urls.length) payload[field] = urls;
  }
  return payload;
}
