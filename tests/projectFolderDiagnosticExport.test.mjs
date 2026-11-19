import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticExportPayload, recordDiagnostic } from "../src/diagnostics.js";

test("folder diagnostics export as workbench-local events under every selected provider without mixing provider logs", () => {
  const originalLocal = globalThis.localStorage;
  const originalSession = globalThis.sessionStorage;
  const storage = () => {
    const values = new Map();
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  };
  globalThis.localStorage = storage();
  globalThis.sessionStorage = storage();
  try {
    recordDiagnostic({ scope: "workbench", stage: "project_folder_waiting", waitingStage: "project_folder_permission_query_started", taskProjectName: "争霸", stepWaitMs: 10_000 });
    recordDiagnostic({ adapter: "lwaigc", stage: "client_task_submit_failed" });
    const original = diagnosticExportPayload({ adapter: "lwaigc", name: "LWAIGC" }, { entries: [] });
    const switched = diagnosticExportPayload({ adapter: "viralee", name: "ViralE" }, { entries: [] });
    assert.equal(original.clientEntries.length, 2);
    assert.equal(switched.clientEntries.length, 1);
    assert.equal(switched.clientEntries[0].stage, "project_folder_waiting");
    assert.equal(switched.clientEntries[0].waitingStage, "project_folder_permission_query_started");
    assert.equal(switched.clientEntries[0].scope, "workbench");
    assert.equal(switched.clientEntries[0].stepWaitMs, 10_000);
    assert.equal(switched.clientEntries.some((entry) => entry.adapter === "lwaigc"), false);
  } finally {
    if (originalLocal === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocal;
    if (originalSession === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = originalSession;
  }
});
