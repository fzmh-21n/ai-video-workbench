import assert from "node:assert/strict";
import test from "node:test";

import { redactDiagnosticValue } from "../src/diagnostics.js";
import { filterDiagnosticEntries, sanitizeDiagnostic } from "../serverDiagnostics.mjs";

test("redacts API keys, authorization headers, passwords, and cookies from browser logs", () => {
  const value = redactDiagnosticValue({
    apiKey: "sk-browser-secret",
    password: "secret",
    message: "Authorization: Bearer sk-inline-secret",
    nested: { cookie: "workbench_session=secret" },
  });
  assert.equal(value.apiKey, "[REDACTED]");
  assert.equal(value.password, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(value), /browser-secret|inline-secret|workbench_session/);
});

test("server diagnostics preserve timings but redact credentials", () => {
  const value = sanitizeDiagnostic({
    stage: "provider_submit_started",
    durationMs: 1234,
    authorization: "Bearer sk-server-secret",
    error: "request failed for sk-other-secret and custom-token-123",
  }, "", ["custom-token-123"]);
  assert.equal(value.durationMs, 1234);
  assert.equal(value.authorization, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(value), /server-secret|other-secret|custom-token/);
});

test("exports only the selected browser session and relay adapter", () => {
  const entries = [
    { sessionId: "a", adapter: "meaicc", stage: "one" },
    { sessionId: "a", adapter: "maxforai", stage: "two" },
    { sessionId: "b", adapter: "meaicc", stage: "three" },
  ];
  assert.deepEqual(filterDiagnosticEntries(entries, { sessionId: "a", adapter: "meaicc" }), [entries[0]]);
});
