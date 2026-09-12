import assert from "node:assert/strict";
import test from "node:test";

import {
  CANSEEDREAM_IMAGE_MODELS,
  CANSEEDREAM_IMAGE_SIZE_LABELS,
  FMGO_IMAGE_MODELS,
  IMAGE_PROVIDER_PROFILES,
  QIQI_IMAGE_BASE_URL,
  QIQI_IMAGE_MODELS,
  QIQI_IMAGE_SIZE_LABELS,
  canSeeDreamImagePayload,
  fmgoGeminiImagePayload,
  fmgoGptImagePayload,
  imageModelCapability,
  imageModelsFor,
  qiqiImagePayload,
} from "../src/imageCatalog.js";

test("lists the documented FMGO and CanSeeDream image models", () => {
  assert.deepEqual(FMGO_IMAGE_MODELS, [
    "gpt-image-2",
    "gpt-image-2-plus",
    "gpt-image-2-pro",
    "gemini-3.0-pro-image-2k",
    "gemini-3.0-pro-image-4k",
    "gemini-3.1-flash-image",
  ]);
  assert.deepEqual(CANSEEDREAM_IMAGE_MODELS, ["GPT Image 2", "Nano2", "Nano2 Pro"]);
});

test("maps FMGO image output size and ratios", () => {
  assert.deepEqual(imageModelCapability("fmgo", "gpt-image-2-plus"), {
    references: 16,
    ratios: ["16:9", "1:1", "9:16", "2:3", "3:2", "4:3", "3:4"],
    imageSize: "2k",
  });
  assert.equal(imageModelCapability("fmgo", "gemini-3.0-pro-image-4k").imageSize, "4K");
  assert.equal(imageModelCapability("fmgo", "gemini-3.1-flash-image").imageSize, "1K");
});

test("builds FMGO GPT image JSON fields", () => {
  assert.deepEqual(fmgoGptImagePayload("gpt-image-2-plus", {
    prompt: "电影感人物海报",
    aspectRatio: "16:9",
  }), {
    model: "gpt-image-2-plus",
    prompt: "比例16:9, 电影感人物海报",
    aspect_ratio: "16:9",
    image_size: "2k",
  });
});

test("builds FMGO Gemini image JSON fields with ordered references", () => {
  assert.deepEqual(fmgoGeminiImagePayload("gemini-3.0-pro-image-2k", {
    prompt: "保持人物一致",
    aspectRatio: "9:16",
    images: ["data:image/png;base64,AAA", "data:image/jpeg;base64,BBB"],
  }), {
    model: "gemini-3.0-pro-image-2k",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "保持人物一致" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB" } },
      ],
    }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "9:16", imageSize: "2K" },
    },
    stream: false,
  });
});

test("builds CanSeeDream asynchronous image task fields", () => {
  assert.deepEqual(canSeeDreamImagePayload({
    model: "GPT Image 2",
    prompt: "生成电影剧照",
    size: "1024x1536",
    quality: "medium",
    images: ["data:image/png;base64,AAA"],
  }), {
    model: "GPT Image 2",
    provider_route: "weavy_pool",
    prompt: "生成电影剧照",
    images: [{ data_url: "data:image/png;base64,AAA" }],
    size: "1024x1536",
    quality: "medium",
    background: "opaque",
    n: 1,
  });
});

test("exposes labelled CanSeeDream sizes and Nano image routes", () => {
  assert.equal(CANSEEDREAM_IMAGE_SIZE_LABELS["3840x2160"], "3840x2160 (4K · 16:9) +6积分");
  assert.deepEqual(imageModelCapability("canseedream", "Nano2"), {
    kind: "nano",
    route: "nano2",
    references: 14,
    resolutions: ["1K", "2K", "4K"],
    resolutionLabels: { "1K": "1K · 15积分", "2K": "2K · 25积分", "4K": "4K · 40积分" },
    ratios: ["Default", "8:1", "4:1", "21:9", "16:9", "5:4", "4:3", "3:2", "1:1", "2:3", "3:4", "4:5", "9:16", "1:4", "1:8"],
    defaultRatio: "Default",
  });
  assert.deepEqual(canSeeDreamImagePayload({
    model: "Nano2 Pro",
    prompt: "保持人物一致",
    size: "4K",
    aspectRatio: "9:16",
    images: [],
  }), {
    model: "GPT Image 2",
    provider_route: "nano2pro",
    prompt: "保持人物一致",
    resolution: "4K",
    aspect_ratio: "9:16",
    quality: "auto",
    background: "opaque",
    n: 1,
  });
});

test("adds QIQI with the documented GPT Image 2 generation and editing options", () => {
  assert.deepEqual(QIQI_IMAGE_MODELS, ["gpt-image-2"]);
  assert.equal(QIQI_IMAGE_BASE_URL, "https://pidoi.com");
  assert.deepEqual(imageModelsFor("qiqi"), ["gpt-image-2"]);
  assert.ok(IMAGE_PROVIDER_PROFILES.some((profile) => (
    profile.adapter === "qiqi" && profile.baseUrl === QIQI_IMAGE_BASE_URL
  )));
  assert.deepEqual(imageModelCapability("qiqi", "gpt-image-2"), {
    references: 16,
    sizes: [
      "auto",
      "1024x1024",
      "1536x1024",
      "1024x1536",
      "2048x2048",
      "2048x1152",
      "1152x2048",
      "3840x2160",
      "2160x3840",
    ],
    qualities: ["auto", "low", "medium", "high"],
  });
  assert.equal(QIQI_IMAGE_SIZE_LABELS["3840x2160"], "3840x2160 (4K · 16:9)");
  assert.equal(qiqiImagePayload({
    prompt: "横屏4K",
    size: "3840x2160",
    quality: "high",
  }).size, "3840x2160");
  assert.deepEqual(qiqiImagePayload({
    prompt: "保持人物一致，改成雨夜背景",
    size: "1536x1024",
    quality: "high",
  }, true), {
    model: "gpt-image-2",
    prompt: "保持人物一致，改成雨夜背景",
    size: "1536x1024",
    quality: "high",
    background: "opaque",
    output_format: "png",
    n: 1,
    input_fidelity: "high",
  });
});
