export function friendlyUpstreamError(value) {
  const original = String(value || "").trim();
  if (!original) return original;
  const rules = [
    {
      pattern: /referenceAudios?\s+is\s+not\s+supported|audio\s+references?\s+(?:are|is)\s+not\s+supported/i,
      message: "当前模型不支持参考音频，请删除音频素材或切换到支持音频参考的模型",
    },
    {
      pattern: /referenceVideos?\s+is\s+not\s+supported|video\s+references?\s+(?:are|is)\s+not\s+supported/i,
      message: "当前模型不支持参考视频，请删除视频素材或切换到支持视频参考的模型",
    },
    {
      pattern: /referenceImages?\s+is\s+not\s+supported|image\s+references?\s+(?:are|is)\s+not\s+supported/i,
      message: "当前模型不支持参考图片，请删除图片素材或切换到支持图片参考的模型",
    },
    {
      pattern: /generateAudio\s+is\s+not\s+supported|audio\s+generation\s+is\s+not\s+supported/i,
      message: "当前模型不支持生成同步音频，请关闭“生成同步音频”后重试",
    },
    {
      pattern: /素材超过大小上限|图片.*(?:10\s*MB|大小上限)|image.*(?:too large|size limit)/i,
      message: "参考图片超过中转大小上限；工作台会自动压缩超过 9MB 的本地图片，请重新预上传后再提交",
    },
  ];
  const matched = rules.find((rule) => rule.pattern.test(original));
  return matched ? `${matched.message}（原始错误：${original}）` : original;
}
