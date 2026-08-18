export function loadFixedContentByVersion(saved, legacyContent = "", initialVersion = "sd20") {
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    return {
      sd20: String(saved.sd20 || ""),
      sd25: String(saved.sd25 || ""),
    };
  }
  const version = initialVersion === "sd25" ? "sd25" : "sd20";
  return {
    sd20: version === "sd20" ? String(legacyContent || "") : "",
    sd25: version === "sd25" ? String(legacyContent || "") : "",
  };
}

export function withFixedContentForVersion(contents, version, value) {
  const key = version === "sd25" ? "sd25" : "sd20";
  return { ...contents, [key]: String(value ?? "") };
}
