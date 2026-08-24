export const FMGO_IMAGE_MODELS = [
  "gpt-image-2",
  "gpt-image-2-plus",
  "gpt-image-2-pro",
  "gemini-3.0-pro-image-2k",
  "gemini-3.0-pro-image-4k",
  "gemini-3.1-flash-image",
];

export const CANSEEDREAM_IMAGE_MODELS = ["GPT Image 2", "Nano2", "Nano2 Pro"];

export const IMAGE_PROVIDER_PROFILES = [
  { id: "image-fmgo", name: "FMGO / 飞猫", adapter: "fmgo", baseUrl: "https://api.fmgo.top", model: FMGO_IMAGE_MODELS[0] },
  { id: "image-cansee", name: "CanSeeDream / 看见梦想", adapter: "canseedream", baseUrl: "https://see.ximeiedu.org", model: CANSEEDREAM_IMAGE_MODELS[0] },
];

const FMGO_RATIOS = ["16:9", "1:1", "9:16", "2:3", "3:2", "4:3", "3:4"];
export const CANSEEDREAM_IMAGE_SIZES = [
  "auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160", "2160x3840",
];

export const CANSEEDREAM_IMAGE_SIZE_LABELS = {
  auto: "自动（由模型决定）",
  "1024x1024": "1024x1024 (1K · 1:1)",
  "1536x1024": "1536x1024 (1.5K · 3:2)",
  "1024x1536": "1024x1536 (1.5K · 2:3)",
  "2048x2048": "2048x2048 (2K · 1:1)",
  "2048x1152": "2048x1152 (2K · 16:9)",
  "3840x2160": "3840x2160 (4K · 16:9) +6积分",
  "2160x3840": "2160x3840 (4K · 9:16) +6积分",
};

const CANSEEDREAM_NANO_PROFILES = {
  Nano2: {
    route: "nano2",
    references: 14,
    resolutions: ["1K", "2K", "4K"],
    resolutionLabels: { "1K": "1K · 15积分", "2K": "2K · 25积分", "4K": "4K · 40积分" },
    ratios: ["Default", "8:1", "4:1", "21:9", "16:9", "5:4", "4:3", "3:2", "1:1", "2:3", "3:4", "4:5", "9:16", "1:4", "1:8"],
    defaultRatio: "Default",
  },
  "Nano2 Pro": {
    route: "nano2pro",
    references: 14,
    resolutions: ["1K", "2K", "4K"],
    resolutionLabels: { "1K": "1K · 25积分", "2K": "2K · 35积分", "4K": "4K · 55积分" },
    ratios: ["auto", "1:1", "21:9", "16:9", "3:2", "4:3", "5:4", "4:5", "3:4", "2:3", "9:16"],
    defaultRatio: "auto",
  },
};

export function imageModelLabel(adapter, model) {
  if (adapter === "canseedream" && model === "GPT Image 2") return "Gpt Img2";
  return model;
}

export function imageModelsFor(adapter) {
  return adapter === "fmgo" ? FMGO_IMAGE_MODELS : adapter === "canseedream" ? CANSEEDREAM_IMAGE_MODELS : [];
}

export function imageModelCapability(adapter, model) {
  if (adapter === "canseedream") {
    const nano = CANSEEDREAM_NANO_PROFILES[model];
    if (nano) return { ...nano, kind: "nano" };
    return { references: 16, sizes: CANSEEDREAM_IMAGE_SIZES, qualities: ["auto", "medium"] };
  }
  const value = String(model || "").toLowerCase();
  const imageSize = value.endsWith("-pro") || value.endsWith("-4k")
    ? (value.startsWith("gemini") ? "4K" : "4k")
    : value.endsWith("-plus") || value.endsWith("-2k")
      ? (value.startsWith("gemini") ? "2K" : "2k")
      : (value.startsWith("gemini") ? "1K" : "1k");
  return { references: 16, ratios: FMGO_RATIOS, imageSize };
}

function promptWithRatio(prompt, aspectRatio) {
  const text = String(prompt || "").trim();
  return new RegExp(`比例\\s*${String(aspectRatio).replace(":", "\\s*:\\s*")}`, "i").test(text)
    ? text
    : `比例${aspectRatio}, ${text}`;
}

export function isFmgoGptImageModel(model) {
  return /^gpt-image-2(?:-plus|-pro)?$/i.test(String(model || ""));
}

export function isFmgoGeminiImageModel(model) {
  return /^gemini-3\.(?:0-pro|1-flash)-image(?:-(?:2k|4k))?$/i.test(String(model || ""));
}

export function fmgoGptImagePayload(model, input) {
  const imageSize = imageModelCapability("fmgo", model).imageSize;
  return {
    model,
    prompt: promptWithRatio(input.prompt, input.aspectRatio),
    aspect_ratio: input.aspectRatio,
    image_size: imageSize,
  };
}

export function fmgoGeminiImagePayload(model, input) {
  const images = Array.isArray(input.images) ? input.images : [];
  return {
    model,
    messages: [{
      role: "user",
      content: images.length
        ? [
            { type: "text", text: input.prompt },
            ...images.map((url) => ({ type: "image_url", image_url: { url } })),
          ]
        : input.prompt,
    }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: input.aspectRatio,
        imageSize: imageModelCapability("fmgo", model).imageSize,
      },
    },
    stream: false,
  };
}

export function canSeeDreamImagePayload(input) {
  const images = (Array.isArray(input.images) ? input.images : []).map((image) => (
    typeof image === "string" && image.startsWith("data:image/") ? { data_url: image } : image
  ));
  const nano = CANSEEDREAM_NANO_PROFILES[input.model];
  return {
    model: "GPT Image 2",
    provider_route: nano?.route || "weavy_pool",
    prompt: input.prompt,
    ...(images.length ? { images } : {}),
    ...(nano
      ? {
          resolution: nano.resolutions.includes(input.size) ? input.size : "1K",
          aspect_ratio: nano.ratios.includes(input.aspectRatio) ? input.aspectRatio : nano.defaultRatio,
          quality: "auto",
        }
      : {
          size: CANSEEDREAM_IMAGE_SIZES.includes(input.size) ? input.size : "auto",
          quality: ["auto", "medium"].includes(input.quality) ? input.quality : "auto",
        }),
    background: "opaque",
    n: 1,
  };
}
