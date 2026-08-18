import crypto from "node:crypto";

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function hmacSha1(key, value, encoding) {
  return crypto.createHmac("sha1", key).update(value).digest(encoding);
}

export function cosObjectPath(key) {
  return `/${String(key).split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

export function cosAuthorization({ secretId, secretKey, method = "PUT", host, pathname, now = Date.now() }) {
  const start = Math.floor(now / 1000) - 60;
  const keyTime = `${start};${start + 3600}`;
  const httpString = `${String(method).toLowerCase()}\n${pathname}\n\nhost=${String(host).toLowerCase()}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`;
  const signKey = hmacSha1(secretKey, keyTime);
  const signature = hmacSha1(signKey, stringToSign, "hex");
  return [
    "q-sign-algorithm=sha1",
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    "q-header-list=host",
    "q-url-param-list=",
    `q-signature=${signature}`,
  ].join("&");
}

export function normalizeCosConfig(value = {}) {
  const bucket = String(value.bucket || "").trim();
  const region = String(value.region || "").trim();
  const secretId = String(value.secretId || "").trim();
  const secretKey = String(value.secretKey || "").trim();
  if (!bucket || !region || !secretId || !secretKey) return null;
  if (!/^[a-z0-9-]+$/.test(bucket) || !/^[a-z0-9-]+$/.test(region)) return null;
  return { bucket, region, secretId, secretKey };
}

export function cosPublicUrl(config, key) {
  const host = `${config.bucket}.cos.${config.region}.myqcloud.com`;
  return `https://${host}${cosObjectPath(key)}`;
}

export function cosFingerprintKey({ kind = "file", digest, extension = "" }) {
  const safeKind = ["image", "audio", "video"].includes(kind) ? kind : "file";
  const safeDigest = String(digest || "").toLowerCase();
  const safeExtension = String(extension || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
  if (!/^[a-f0-9]{64}$/.test(safeDigest)) throw new TypeError("无效的素材文件指纹");
  return `workbench/${safeKind}/${safeDigest}${safeExtension}`;
}
