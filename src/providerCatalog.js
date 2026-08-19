import { LWAIGC_VIDEO_MODELS, lwaigcCapability } from "./lwaigcCatalog.js";
import { MEAICC_VIDEO_MODELS, meaiccCapability } from "./meaiccCatalog.js";
import { ZIYU_BASE_URL, ziyuCapability } from "./ziyuCatalog.js";
import {
  GLOBAL_AIOPC_BASE_URL,
  GLOBAL_AIOPC_MODELS,
  globalAiOpcCapability,
} from "./globalAiOpcCatalog.js";
import { MAXFORAI_BASE_URL, MAXFORAI_VIDEO_MODELS, maxforaiCapability } from "./maxforaiCatalog.js";
import { CLMM_BASE_URL, clmmCapability } from "./clmmCatalog.js";
import { PIDOI_BASE_URL, PIDOI_MODELS, pidoiCapability } from "./pidoiCatalog.js";

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
  {
    id: "lwaigc",
    name: "LWAIGC",
    baseUrl: "https://ai.lwaigc.cn",
    adapter: "lwaigc",
    model: "firefly-seedance2-720p",
    mediaUploadUrl: "https://ai.lwaigc.cn/v1/assets",
  },
  {
    id: "meaicc",
    name: "MEAICC / 林木森AI",
    baseUrl: "https://api.meaicc.com",
    adapter: "meaicc",
    model: "seedance-2.0",
    mediaUploadUrl: "",
  },
  {
    id: "ziyuai",
    name: "Ziyu AI / 紫域AI",
    baseUrl: ZIYU_BASE_URL,
    adapter: "ziyuai",
    model: "",
    mediaUploadUrl: `${ZIYU_BASE_URL}/api/v1/uploads`,
  },
  {
    id: "globalaiopc",
    name: "GlobalAiOpc / 全球AI",
    baseUrl: GLOBAL_AIOPC_BASE_URL,
    adapter: "globalaiopc",
    model: "sd_2.0_fast_discount_720p",
    mediaUploadUrl: "",
  },
  {
    id: "maxforai",
    name: "MaxForAI",
    baseUrl: MAXFORAI_BASE_URL,
    adapter: "maxforai",
    model: "firefly-seedance2-720p",
    mediaUploadUrl: `${MAXFORAI_BASE_URL}/v1/assets`,
  },
  {
    id: "clmm",
    name: "CLMM Mall",
    baseUrl: CLMM_BASE_URL,
    adapter: "clmm",
    model: "",
    mediaUploadUrl: "",
  },
  {
    id: "pidoi",
    name: "Pidoi",
    baseUrl: PIDOI_BASE_URL,
    adapter: "pidoi",
    model: "tejiasd",
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
  lwaigc: LWAIGC_VIDEO_MODELS,
  meaicc: MEAICC_VIDEO_MODELS,
  globalaiopc: GLOBAL_AIOPC_MODELS,
  maxforai: MAXFORAI_VIDEO_MODELS,
  clmm: [],
  pidoi: PIDOI_MODELS,
};

export const FALLBACK_MODEL_LABELS = {
  lwaigc: {
    "dq-sd933-pro": "DQ Seedance 2.0 · 卡脸 · 720P · 4–15秒",
    "dq-sd933-pro-face": "DQ Seedance 2.0 · 不卡脸 · 720P · 4–15秒",
  },
  canseedream: {
    kele_pool: "可乐线路 · 480P · 15秒 · 450积分",
    tc_pool: "怀旧线路 · 720P · 自动时长 · 468积分",
    shutiao_pool: "香蕉线路 · 720P · 15秒 · 768积分",
    lajiao_pool: "辣椒 SD2.5 满血 · 720P · 4–30秒 · 1190积分",
    yingtao_pool: "樱桃 SD2.5 满血 · 720P · 30秒 · 2990积分",
  },
  pidoi: {
    "sora-v3-933-pro": "Sora V3 933 Pro · 720P · 15秒 · 9图/3音频/3视频",
    tejiasd: "卡脸 933 · 特价 SD2.0",
    "sd-2.0-931-720p": "SD2.0 931 · 720P · 4–15秒",
    "sd-2.0-fast-720p": "SD2.0 Fast · 480P请求档 · 4–15秒",
    "sd-2.5-720p": "SD2.5 · 720P · 4–29秒",
  },
};

const SD_VERSION_MODELS = {
  lwaigc: {
    sd20: "firefly-seedance2-720p",
    sd25: "mf-seedance2.5",
  },
  paipu: {
    sd20: "lec-seedance-videos-standard",
    sd25: "lec-seedance-2-5",
  },
  meaicc: {
    sd20: "seedance-2.0",
  },
  canseedream: {
    sd20: "kele_pool",
    sd25: "lajiao_pool",
  },
  maxforai: {
    sd20: "firefly-seedance2-720p",
    sd25: "mg-seedance-2.5",
  },
  globalaiopc: {
    sd20: "sd_2.0_fast_discount_720p",
  },
  pidoi: {
    sd20: "sora-v3-933-pro",
    sd25: "sd-2.5-720p",
  },
};

export function preferredModelForSdVersion(adapter, version) {
  return SD_VERSION_MODELS[adapter]?.[version] || "";
}

export function pollDelayForAdapter(adapter) {
  return adapter === "clmm" ? 3_000 : adapter === "meaicc" || adapter === "globalaiopc" ? 21_000 : 10_000;
}

export function submissionTimeoutForAdapter(adapter) {
  return adapter === "meaicc" ? 600_000 : 180_000;
}

export function sdVersionForModel(modelName) {
  const model = String(modelName || "").toLowerCase();
  return /(?:seedance|sd)[-.]?2[.-]?5|sd25/.test(model) ? "sd25" : "sd20";
}

function rawCapabilityFor(profile) {
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
        durations: Array.from({ length: 27 }, (_, index) => index + 4),
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

  if (adapter === "lwaigc") return lwaigcCapability(profile?.model);
  if (adapter === "meaicc") return meaiccCapability(profile?.model);
  if (adapter === "ziyuai") {
    const live = profile?.routeCapabilities?.[profile?.model];
    return live
      ? { ...ziyuCapability({ id: profile?.model }), ...live }
      : ziyuCapability({ id: profile?.model });
  }
  if (adapter === "globalaiopc") return globalAiOpcCapability(profile?.model);
  if (adapter === "maxforai") return maxforaiCapability(profile?.model);
  if (adapter === "clmm") return clmmCapability(profile?.model);
  if (adapter === "pidoi") return pidoiCapability(profile?.model);

  return base;
}

export function capabilityFor(profile) {
  const capability = rawCapabilityFor(profile);
  const version = profile?.adapter === "canseedream"
    ? (
        capability.images > 9 || capability.videos > 3 || capability.audios > 3 ||
        capability.durations.some((value) => typeof value === "number" && value > 15)
          ? "sd25"
          : "sd20"
      )
    : capability._sdVersion || sdVersionForModel(profile?.model);
  if (version !== "sd25") {
    return { ...capability, images: 9, audios: 3, videos: 3 };
  }
  return capability;
}

export function preferredDurationForVersion(capability, version) {
  const durations = Array.isArray(capability?.durations) ? capability.durations : [];
  const numeric = durations.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (version === "sd20" && numeric.includes(15)) return 15;
  if (version === "sd25" && numeric.length) return Math.max(...numeric);
  return durations[0] ?? 15;
}

export function capabilityLimitIssue(profile, materials, duration) {
  const capability = capabilityFor(profile);
  const counts = (materials || []).reduce((result, item) => {
    const kind = ["image", "audio", "video"].includes(item?.kind) ? item.kind : "image";
    result[kind] += 1;
    return result;
  }, { image: 0, audio: 0, video: 0 });
  for (const kind of ["image", "audio", "video"]) {
    const limit = Number(capability[`${kind}s`] || 0);
    if (counts[kind] > limit) {
      const label = kind === "image" ? "图片" : kind === "audio" ? "音频" : "视频";
      return `${profile?.model || "当前模型"} 的${label}参考最多 ${limit} 个，当前提交了 ${counts[kind]} 个`;
    }
  }
  const numericDurations = capability.durations.filter((value) => typeof value === "number");
  if (numericDurations.length && !numericDurations.includes(duration)) {
    return `${profile?.model || "当前模型"} 不支持 ${duration} 秒`;
  }
  return "";
}

export function sdVersionForProfile(profile) {
  if (profile?.adapter === "canseedream") {
    const capability = rawCapabilityFor(profile);
    const numericDurations = capability.durations.filter((value) => typeof value === "number");
    const exceedsSd20Limits =
      capability.images > 9 ||
      capability.videos > 3 ||
      capability.audios > 3 ||
      (numericDurations.length > 0 && Math.max(...numericDurations) > 15);
    return exceedsSd20Limits ? "sd25" : "sd20";
  }
  if (profile?.adapter === "ziyuai") {
    return rawCapabilityFor(profile)._sdVersion || "sd20";
  }
  return sdVersionForModel(profile?.model);
}

export function modelForSdVersion(profile, version, availableModels) {
  const currentModel = String(profile?.model || "").trim();
  if (currentModel && sdVersionForProfile(profile) === version) return currentModel;

  const preferred = preferredModelForSdVersion(profile?.adapter, version);
  const dynamicAdapters = new Set(["canseedream", "ziyuai", "maxforai"]);
  if (!dynamicAdapters.has(profile?.adapter)) return preferred;
  const candidates = Array.isArray(availableModels) && availableModels.length
    ? availableModels
    : FALLBACK_MODELS[profile?.adapter] || [];
  if (preferred && candidates.includes(preferred)) return preferred;
  return candidates.find((model) => (
    sdVersionForProfile({ ...profile, model }) === version
  )) || "";
}

export function inferAdapter(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === "api.fmgo.top") return "fmgo";
    if (host === "api.paipu.net") return "paipu";
    if (host === "api.viralee.top") return "viralee";
    if (host === "canseedream.com" || host === "see.ximeiedu.org") return "canseedream";
    if (host === "ai.lwaigc.cn") return "lwaigc";
    if (host === "api.meaicc.com") return "meaicc";
    if (host === "ziyuai.vip" || host === "www.ziyuai.vip") return "ziyuai";
    if (host === "zcbservice.aizfw.cn" || host === "docs.globalaiopc.com" || host === "api.globalaiopc.com") return "globalaiopc";
    if (host === "maxforai.top" || host === "www.maxforai.top") return "maxforai";
    if (host === "clmm-mall.top" || host === "www.clmm-mall.top") return "clmm";
    if (host === "pidoi.com" || host === "www.pidoi.com") return "pidoi";
  } catch {}
  return "newapi";
}

export function migrateSavedProfile(profile) {
  if (!profile || typeof profile !== "object") return profile;
  const inferredAdapter = inferAdapter(profile.baseUrl);
  if (profile.id === "clmm" || inferredAdapter === "clmm" || profile.adapter === "clmm") {
    return { ...profile, baseUrl: CLMM_BASE_URL, adapter: "clmm", mediaUploadUrl: "" };
  }
  if (profile.id === "pidoi" || inferredAdapter === "pidoi" || profile.adapter === "pidoi") {
    return {
      ...profile,
      baseUrl: PIDOI_BASE_URL,
      adapter: "pidoi",
      model: PIDOI_MODELS.includes(profile.model) ? profile.model : "tejiasd",
      // Pidoi 的公开文档没有提供素材上传端点。清除旧版本曾写入的
      // 推测地址，留空时由本地服务自动把素材转成临时公网 URL。
      mediaUploadUrl: profile.mediaUploadUrl === `${PIDOI_BASE_URL}/v1/media/uploads`
        ? ""
        : profile.mediaUploadUrl || "",
    };
  }
  const officialMaxForAI = profile.id === "maxforai" || inferredAdapter === "maxforai";
  if (officialMaxForAI || profile.adapter === "maxforai") {
    return {
      ...profile,
      baseUrl: officialMaxForAI ? MAXFORAI_BASE_URL : profile.baseUrl,
      adapter: "maxforai",
      model: MAXFORAI_VIDEO_MODELS.includes(profile.model) ? profile.model : "firefly-seedance2-720p",
      mediaUploadUrl: officialMaxForAI ? `${MAXFORAI_BASE_URL}/v1/assets` : profile.mediaUploadUrl || "",
    };
  }
  const officialLwaigc = profile.id === "lwaigc" || inferredAdapter === "lwaigc";
  if (officialLwaigc || profile.adapter === "lwaigc") {
    return {
      ...profile,
      baseUrl: officialLwaigc ? "https://ai.lwaigc.cn" : profile.baseUrl,
      adapter: "lwaigc",
      model: LWAIGC_VIDEO_MODELS.includes(profile.model)
        ? profile.model
        : "firefly-seedance2-720p",
      mediaUploadUrl: officialLwaigc
        ? "https://ai.lwaigc.cn/v1/assets"
        : profile.mediaUploadUrl || "",
    };
  }

  const officialMeaicc = profile.id === "meaicc" || inferredAdapter === "meaicc";
  if (officialMeaicc || profile.adapter === "meaicc") {
    return {
      ...profile,
      baseUrl: officialMeaicc ? "https://api.meaicc.com" : profile.baseUrl,
      adapter: "meaicc",
      model: String(profile.model || "").trim() || "seedance-2.0",
    };
  }
  const officialZiyu = profile.id === "ziyuai" || inferredAdapter === "ziyuai";
  if (officialZiyu || profile.adapter === "ziyuai") {
    return {
      ...profile,
      baseUrl: officialZiyu ? ZIYU_BASE_URL : profile.baseUrl,
      adapter: "ziyuai",
      mediaUploadUrl: `${ZIYU_BASE_URL}/api/v1/uploads`,
    };
  }
  const officialGlobalAiOpc = profile.id === "globalaiopc" || inferredAdapter === "globalaiopc";
  if (officialGlobalAiOpc || profile.adapter === "globalaiopc") {
    return {
      ...profile,
      baseUrl: officialGlobalAiOpc ? GLOBAL_AIOPC_BASE_URL : profile.baseUrl,
      adapter: "globalaiopc",
      model: GLOBAL_AIOPC_MODELS.includes(profile.model)
        ? profile.model
        : "sd_2.0_fast_discount_720p",
      mediaUploadUrl: "",
    };
  }

  if (
    profile.adapter === "canseedream" &&
    String(profile.baseUrl || "").replace(/\/$/, "") === "https://canseedream.com"
  ) {
    return { ...profile, baseUrl: "https://see.ximeiedu.org" };
  }
  if (profile.adapter === "newapi" && inferredAdapter !== "newapi") {
    return { ...profile, adapter: inferredAdapter };
  }
  return profile;
}
