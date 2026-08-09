export const DEFAULT_PROFILES = [
  {
    id: "fmgo",
    name: "FMGO / 飞猫",
    baseUrl: "https://api.fmgo.top",
    adapter: "fmgo",
    model: "grok-1.5-fast",
    mediaUploadUrl: "",
  },
  {
    id: "paipu",
    name: "Paipu / Lec API",
    baseUrl: "https://api.paipu.net",
    adapter: "paipu",
    model: "lec-seedance-videos-standard",
    mediaUploadUrl: "https://api.paipu.net/v1/media/upload",
  },
  {
    id: "viralee",
    name: "ViralE",
    baseUrl: "https://api.viralee.top",
    adapter: "viralee",
    model: "viraldance",
    mediaUploadUrl: "",
  },
  {
    id: "canseedream",
    name: "CanSeeDream / 看见梦想",
    baseUrl: "https://see.ximeiedu.org",
    adapter: "canseedream",
    model: "kele_pool",
    mediaUploadUrl: "",
  },
];

export const FALLBACK_MODELS = {
  fmgo: [
    "grok-1.5-fast",
    "grok-1.5",
    "sora-2",
    "sora-2-pro",
    "veo-3.1",
    "veo-3.1-fast",
    "omni",
    "feimiao-v2",
    "feimiao-v2-fast",
    "feimiao-v2-431",
    "feimiao-v2-431-fast",
  ],
  paipu: [
    "lec-grok-video-1-5",
    "lec-seedance-2-0-933-stable",
    "lec-seedance-2-0-fast-431-720p",
    "lec-seedance-2-0-full-431-720p",
    "lec-seedance-2-0-mini-431-480p",
    "lec-seedance-2-0-fast-933-720p",
    "lec-seedance-2-0-full-933-480p",
    "lec-seedance-2-0-full-933-1080p",
    "lec-seedance-2-0-full-933-720p-mx",
    "lec-seedance-2-0-super-933-1080p",
    "lec-ac-seedance-900-720p",
    "lec-seedance-2-0",
    "lec-seedance-videos-standard",
    "lec-seedance-videos-fast",
    "lec-seedance-videos-mini",
    "lec-seedance-videos-stable",
    "lec-seedance-videos-stable-fast",
    "lec-seedance-videos-stable-mini",
    "lec-dj-video-v1",
    "lec-vm-sd2-full-night-720",
    "lec-vm-sd2-full-flex-720",
    "lec-seedance-2-5",
    "lec-vm-sd25-full-720",
  ],
  viralee: [
    "viraldance",
    "viraldance-fast",
    "viraldance900",
    "viralhorse-5s",
    "viralhorse-10s",
    "viraldance921",
    "viraldance921-fast",
    "viraldance921-2.0",
    "viraldance933",
    "viraldance933-fast",
    "sora-2-landscape-8s",
    "sora-2-landscape-12s",
    "sora-2-portrait-8s",
    "sora-2-portrait-12s",
  ],
  canseedream: ["kele_pool", "tc_pool", "shutiao_pool", "lajiao_pool", "yingtao_pool"],
};

export const FALLBACK_MODEL_LABELS = {
  canseedream: {
    kele_pool: "可乐线路 · 480P · 15秒 · 450积分",
    tc_pool: "怀旧线路 · 720P · 自动时长 · 468积分",
    shutiao_pool: "香蕉线路 · 720P · 15秒 · 768积分",
    lajiao_pool: "辣椒 SD2.5 满血 · 720P · 4–30秒 · 1190积分",
    yingtao_pool: "樱桃 SD2.5 满血 · 720P · 30秒 · 2990积分",
  },
};

export function capabilityFor(profile) {
  const model = String(profile?.model || "").toLowerCase();
  const adapter = profile?.adapter;
  const base = {
    images: 9,
    videos: 0,
    audios: 0,
    durations: [4, 5, 6, 8, 10, 12, 15],
    resolutions: ["480p", "720p", "1080p"],
    ratios: ["16:9", "9:16", "1:1"],
    seed: false,
    syncAudio: true,
    syncAudioFixed: false,
  };

  if (adapter === "fmgo") {
    const encodedVariant = model.match(/-(480p|720p|1080p)-(\d+)s$/i);
    const allowsMixedReferences = model.startsWith("feimiao-v2");
    const images = model.startsWith("sora-")
      ? 1
      : model.startsWith("veo-3.1")
        ? 3
        : model === "omni"
          ? 7
          : model.startsWith("feimiao-v2")
            ? 9
            : 7;
    return {
      ...base,
      images,
      // 飞猫的模型详情页未公布音视频参考上限。对飞猫 V2 不在
      // 前端武断拦截，按工作台素材区上限提交，由上游返回实际结果。
      videos: allowsMixedReferences ? 3 : base.videos,
      audios: allowsMixedReferences ? 3 : base.audios,
      durations: encodedVariant
        ? [Number(encodedVariant[2])]
        : [4, 6, 8, 10, 12, 15],
      resolutions: encodedVariant
        ? [encodedVariant[1].toLowerCase()]
        : ["480p", "720p", "1080p"],
    };
  }

  if (adapter === "paipu") {
    const mixed = {
      ...base,
      images: 9,
      videos: 3,
      audios: 3,
      ratios: ["16:9", "9:16", "1:1"],
    };
    if (model === "lec-grok-video-1-5") {
      return {
        ...base,
        images: 1,
        durations: [10, 15],
        resolutions: ["720p"],
        ratios: ["16:9", "9:16", "1:1"],
      };
    }
    if (model === "lec-seedance-2-5") {
      return {
        ...mixed,
        images: 30,
        videos: 10,
        audios: 10,
        durations: Array.from({ length: 26 }, (_, index) => index + 4),
        resolutions: ["480p", "720p"],
      };
    }
    if (model === "lec-vm-sd25-full-720") {
      return {
        ...mixed,
        images: 30,
        videos: 10,
        audios: 10,
        durations: [30],
        resolutions: ["720p"],
      };
    }
    if (model === "lec-vm-sd2-full-flex-720") {
      return {
        ...mixed,
        durations: Array.from({ length: 12 }, (_, index) => index + 4),
        resolutions: ["720p"],
      };
    }
    if (model === "lec-vm-sd2-full-night-720")
      return { ...mixed, durations: [15], resolutions: ["720p"] };
    if (model === "lec-seedance-2-0-933-stable") {
      return {
        ...mixed,
        durations: Array.from({ length: 12 }, (_, index) => index + 4),
        resolutions: ["480p", "720p"],
        ratios: ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"],
      };
    }
    const fixed431Or933 = model.match(/^lec-seedance-2-0-(?:fast|full|mini|super)-(?:431|933)-(480p|720p|1080p)(?:-mx)?$/);
    if (fixed431Or933) {
      return {
        ...mixed,
        durations: [10, 15],
        resolutions: [fixed431Or933[1]],
      };
    }
    if (model === "lec-ac-seedance-900-720p") {
      return {
        ...base,
        images: 9,
        durations: [10, 15],
        resolutions: ["720p"],
        ratios: ["16:9", "9:16", "1:1"],
      };
    }
    if (model === "lec-seedance-2-0" || model === "lec-dj-video-v1") {
      return {
        ...base,
        images: 9,
        durations: [5, 10, 15],
        resolutions: ["720p"],
        ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      };
    }
    if (model.startsWith("lec-seedance-videos-stable")) {
      return {
        ...mixed,
        images: 4,
        audios: 1,
        durations: Array.from({ length: 12 }, (_, index) => index + 4),
        resolutions: ["480p", "720p"],
      };
    }
    if (model.startsWith("lec-seedance-videos-")) {
      return {
        ...mixed,
        durations: Array.from({ length: 12 }, (_, index) => index + 4),
        resolutions: model === "lec-seedance-videos-fast"
          ? ["480p"]
          : model === "lec-seedance-videos-mini"
            ? ["480p", "720p"]
            : ["480p", "720p", "1080p", "4K"],
      };
    }
    return base;
  }

  if (adapter === "viralee") {
    // ViralE 的模型页没有公布参考素材数量或类型限制。前端只执行
    // 工作台自身的统一上传上限，实际兼容性由上游接口返回。
    const unrestricted = { ...base, images: 9, videos: 3, audios: 3 };
    if (model === "viraldance" || model === "viraldance-fast") {
      return {
        ...unrestricted,
        durations: Array.from({ length: 12 }, (_, index) => index + 4),
        resolutions: ["720p"],
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
        seed: true,
        syncAudio: true,
      };
    }
    if (model === "viraldance900") {
      return {
        ...unrestricted,
        durations: [5, 10, 15],
        resolutions: ["720p"],
        ratios: ["16:9", "9:16", "4:3", "1:1"],
      };
    }
    if (model.startsWith("viralhorse-")) {
      return {
        ...unrestricted,
        durations: [model.includes("10s") ? 10 : 5],
        resolutions: ["720p"],
      };
    }
    if (model.startsWith("sora-2-")) {
      const duration = model.includes("12s") ? 12 : 8;
      const ratio = model.includes("portrait") ? "9:16" : "16:9";
      return {
        ...unrestricted,
        durations: [duration],
        resolutions: ["720p"],
        ratios: [ratio],
      };
    }
    if (model === "viraldance933" || model === "viraldance933-fast") {
      return {
        ...unrestricted,
        durations: Array.from({ length: 12 }, (_, index) => index + 4),
        resolutions: ["720p"],
        ratios: ["16:9", "9:16", "1:1", "4:3"],
        syncAudioFixed: true,
      };
    }
    return {
      ...unrestricted,
      durations: Array.from({ length: 7 }, (_, index) => index + 4),
      resolutions: ["720p"],
    };
  }

  if (adapter === "canseedream") {
    const live = profile?.routeCapabilities?.[model];
    if (live) {
      return {
        ...base,
        ...live,
        images: Math.min(30, Number(live.images) || 0),
        videos: Math.min(10, Number(live.videos) || 0),
        audios: Math.min(10, Number(live.audios) || 0),
        syncAudio: true,
      };
    }
    const common = {
      ...base,
      images: 9,
      videos: 3,
      audios: 3,
      resolutions: [model === "kele_pool" ? "480p" : "720p"],
      ratios:
        model === "lajiao_pool"
          ? ["16:9", "9:16", "1:1"]
          : ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    };
    if (model === "tc_pool") return { ...common, durations: ["auto"], ratios: [...common.ratios, "auto"] };
    if (model === "lajiao_pool")
      return { ...common, durations: Array.from({ length: 27 }, (_, index) => index + 4) };
    if (model === "yingtao_pool") return { ...common, durations: [30], ratios: [...common.ratios, "adaptive"] };
    return { ...common, durations: [15], ratios: [...common.ratios, "adaptive"] };
  }

  return base;
}

export function inferAdapter(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === "api.fmgo.top") return "fmgo";
    if (host === "api.paipu.net") return "paipu";
    if (host === "api.viralee.top") return "viralee";
    if (host === "canseedream.com" || host === "see.ximeiedu.org") return "canseedream";
  } catch {}
  return "newapi";
}
