import crypto from "node:crypto";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

export function verifyLoginCredentials(username, password, expectedUsername, expectedPassword) {
  return (
    safeEqual(String(username || ""), expectedUsername) &&
    safeEqual(String(password || ""), expectedPassword)
  );
}

export function createSessionToken(username, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ username, expiresAt: now + SESSION_TTL_MS })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySessionToken(token, secret, now = Date.now()) {
  try {
    const [payload, signature, extra] = String(token || "").split(".");
    if (!payload || !signature || extra) return null;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    if (!safeEqual(signature, expected)) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session?.username || !Number.isFinite(session.expiresAt) || session.expiresAt <= now) return null;
    return session;
  } catch {
    return null;
  }
}

export function cookieValue(header, name) {
  const cookies = String(header || "").split(";");
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return "";
}

export function sessionCookie(token, secure = false) {
  const attributes = [
    `workbench_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearedSessionCookie(secure = false) {
  return `${sessionCookie("", secure)}; Max-Age=0`;
}
