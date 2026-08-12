function textValue(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

export function taskFailureDetails(body) {
  const statusError = /^failed:\s*(.+)$/i.exec(String(body?.status || ""))?.[1];
  const reasonCandidates = [
    body?.failureReason,
    body?.failure_reason,
    body?.failReason,
    body?.fail_reason,
    body?.reason,
    body?.error?.message,
    body?.message,
    body?.detail,
    body?.data?.failureReason,
    body?.data?.failure_reason,
    body?.data?.failReason,
    body?.data?.fail_reason,
    body?.data?.reason,
    body?.data?.error?.message,
    body?.data?.error,
    body?.data?.message,
    body?.result?.error?.message,
    body?.result?.error,
    body?.result?.reason,
    body?.result?.message,
    body?.output?.error?.message,
    body?.output?.error,
    statusError,
    body?.error,
  ];
  const codeCandidates = [
    body?.failureCode,
    body?.failure_code,
    body?.errorCode,
    body?.error_code,
    body?.error?.code,
    body?.code,
    body?.data?.failureCode,
    body?.data?.failure_code,
    body?.data?.errorCode,
    body?.data?.error_code,
    body?.data?.error?.code,
    body?.data?.code,
    body?.result?.error?.code,
  ];
  return {
    reason: reasonCandidates.map(textValue).find(Boolean) || "视频生成失败（中转未返回具体原因）",
    code: codeCandidates.map(textValue).find(Boolean) || "",
  };
}
