import assert from "node:assert/strict";
import test from "node:test";

import {
  cookieValue,
  createSessionToken,
  verifyLoginCredentials,
  verifySessionToken,
} from "../serverAuth.mjs";

test("validates login credentials supplied by the server environment", () => {
  assert.equal(verifyLoginCredentials("test-user", "test-password", "test-user", "test-password"), true);
  assert.equal(verifyLoginCredentials("test-user", "wrong-password", "test-user", "test-password"), false);
});

test("creates and verifies a signed login session", () => {
  const token = createSessionToken("fzmh", "test-secret", 1_000);
  assert.deepEqual(verifySessionToken(token, "test-secret", 2_000), {
    username: "fzmh",
    expiresAt: 43_201_000,
  });
});

test("rejects tampered and expired login sessions", () => {
  const token = createSessionToken("fzmh", "test-secret", 1_000);
  assert.equal(verifySessionToken(`${token}changed`, "test-secret", 2_000), null);
  assert.equal(verifySessionToken(token, "test-secret", 43_201_000), null);
});

test("reads the workbench session from a cookie header", () => {
  assert.equal(cookieValue("theme=light; workbench_session=abc.def; mode=full", "workbench_session"), "abc.def");
});
