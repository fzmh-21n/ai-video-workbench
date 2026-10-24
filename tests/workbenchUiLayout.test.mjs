import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const main = read("main.jsx");
const app = read("App.jsx");
const base = read("styles.css");

test("the workbench balances comfortable wide-screen margins without restoring the old width cap", () => {
  const css = read("workbenchUi.css");
  assert.match(css, /\.topbar,\s*\.workspace-grid,\s*\.face-layout,\s*\.face-results\s*\{[^}]*max-width:\s*none[^}]*width:\s*100%/s);
  assert.match(css, /\.workspace-shell\s*\{[^}]*padding:\s*16px clamp\(48px, 6\.25vw, 176px\) 24px/s);
  assert.doesNotMatch(css, /max-width:\s*1880px/);
});

test("refreshed typography uses a readable base and does not shrink labels to ten or eleven pixels", () => {
  assert.match(read("workbenchUi.css"), /:root\s*\{[^}]*font-size:\s*18px/s);
  for (const file of ["workbenchUi.css", "batchUi.css", "dialogUi.css"]) {
    for (const match of read(file).matchAll(/font-size:\s*(\d+)px/g)) {
      assert.ok(Number(match[1]) >= 12, `${file}: ${match[0]} is too small`);
    }
  }
  assert.match(read("batchUi.css"), /\.batch-card-body \.prompt-field textarea\s*\{[^}]*font-size:\s*17px/s);
});

test("the UI refresh loads after the base and keeps batch and dialog styling explicit", () => {
  const files = ["styles.css", "workbenchUi.css", "batchUi.css", "dialogUi.css"];
  const positions = files.map((file) => main.indexOf(`import "./${file}"`));
  assert.ok(positions.every((position) => position >= 0), "all UI stylesheets must be imported");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test("the video header and workspace retain their own layout scope", () => {
  assert.match(app, /className="topbar video-topbar"/);
  assert.match(app, /className="ui-topbar-main"/);
  assert.match(app, /className="ui-app-nav"/);
  assert.match(app, /className="ui-workspace-actions"/);
  assert.match(app, /className="provider-switcher ui-provider-row"/);
  assert.match(app, /className="workspace-grid video-workspace"/);
  assert.doesNotMatch(read("TextWorkbench.jsx"), /video-workspace|video-topbar/);
  assert.doesNotMatch(read("ImageWorkbench.jsx"), /video-workspace|video-topbar/);
});

test("the refreshed video header keeps navigation, project management and diagnostics actions", () => {
  const header = app.slice(app.indexOf('<header className="topbar video-topbar"'), app.indexOf("</header>", app.indexOf('<header className="topbar video-topbar"')));
  for (const handler of ["onImageMode", "onTextMode", "onFaceMode", "downloadDiagnostics", "resetDiagnostics", "onLogout"]) {
    assert.ok(header.includes(`onClick={${handler}}`), `${handler} must remain available`);
  }
  assert.match(header, /setTaskProjectOpen\(true\)/);
  assert.match(header, /setCostOpen\(true\)/);
  assert.match(header, /openConfig\(\)/);
  assert.match(header, /onChange=\{\(event\) => setActiveId\(event\.target\.value\)\}/);
});

test("the visual refresh does not add continuous animations or broad motion transitions", () => {
  const refreshed = ["workbenchUi.css", "batchUi.css", "dialogUi.css"].map(read).join("\n");
  assert.doesNotMatch(refreshed, /animation(?:-iteration-count)?\s*:[^;{}]*\binfinite\b/i);
  assert.doesNotMatch(refreshed, /transition\s*:\s*all\b/i);
  assert.doesNotMatch(refreshed, /scroll-behavior\s*:\s*smooth/i);
});

test("provider dialogs retain bounded height and independently scrollable panels", () => {
  assert.match(base, /\.config-dialog\s*\{[^}]*max-height\s*:\s*90vh[^}]*overflow\s*:\s*hidden/s);
  assert.match(base, /\.config-layout\s*\{[^}]*min-height\s*:\s*0/s);
  assert.match(base, /\.profile-list\s*\{[^}]*overflow-y\s*:\s*auto/s);
  assert.match(base, /\.config-form\s*\{[^}]*overflow\s*:\s*auto/s);
  assert.match(base, /\.task-project-dialog\s*\{[^}]*max-height[^}]*overflow\s*:\s*auto/s);
});

test("the dialog refresh covers the existing 780px provider navigation breakpoint", () => {
  const dialog = read("dialogUi.css");
  const queries = [...dialog.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{/g)];
  const singleColumnAtBaseBreakpoint = queries.some((query, index) => {
    if (Number(query[1]) < 780) return false;
    const rules = dialog.slice(query.index, queries[index + 1]?.index);
    return /\.config-layout\s*\{[^}]*grid-template-columns\s*:\s*(?:minmax\(0,\s*1fr\)|1fr)\s*;/s.test(rules);
  });
  assert.ok(singleColumnAtBaseBreakpoint, "761–780px must not mix horizontal provider navigation with a two-column dialog");
});

test("status and failure details remain visible rather than being removed by the new styling", () => {
  const refreshed = ["workbenchUi.css", "batchUi.css", "dialogUi.css"].map(read).join("\n");
  const rules = refreshed.match(/[^{}]+\{[^{}]*\}/g) || [];
  for (const rule of rules) {
    const [selector, declarations] = rule.split("{");
    if (/\.(?:batch-status|task-status|batch-issue|batch-error|task-error|task-network-warning|service-disconnected)\b/.test(selector)) {
      assert.doesNotMatch(declarations, /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0\s*[;}]/i, selector);
    }
  }
});

test("the original gold theme and semantic task colors remain the source of truth", () => {
  assert.match(base, /\.primary-button\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*#d89a2e,\s*#c98212\)\s*!important[^}]*color:\s*#fff\s*!important/s);
  assert.match(base, /\.task-status\.completed\s*\{[^}]*color:\s*#087f74/s);
  assert.match(base, /\.task-status\.processing\s*\{[^}]*color:\s*#8163bc/s);
  assert.match(base, /\.task-status\.failed\s*\{[^}]*color:\s*#be4d3d/s);
  assert.match(base, /\.progress-track span\s*\{[^}]*background:\s*linear-gradient\(90deg,\s*#ce8d22,\s*#099486\)/s);
  for (const file of ["workbenchUi.css", "batchUi.css", "dialogUi.css"]) {
    const rules = read(file).match(/[^{}]+\{[^{}]*\}/g) || [];
    for (const rule of rules) {
      const [selector, declarations] = rule.split("{");
      if (/\.(?:primary-button|task-status|task-download-badge|batch-status[-\w]*|batch-downloaded-badge|batch-filter-(?:button|submitting|generating|generated|undownloaded|failed|deferred)|progress-track|model-version-switch|work-mode-switch)\b/.test(selector)) {
        assert.doesNotMatch(declarations, /(?:^|;)\s*(?:color|background(?:-[\w-]+)?|border(?:-(?:top|right|bottom|left))?(?:-(?:color|style|width))?|box-shadow|accent-color|outline(?:-[\w-]+)?)\s*:/i, `${file}: ${selector}`);
      }
    }
  }
});

test("layout-only styles do not introduce a replacement palette or new theme tokens", () => {
  const originalColors = new Set([...base.matchAll(/#[\da-f]{3,8}\b/gi)].map((match) => match[0].toLowerCase()));
  for (const file of ["workbenchUi.css", "batchUi.css", "dialogUi.css"]) {
    const css = read(file);
    assert.doesNotMatch(css, /--ui-[\w-]+\s*:/, `${file} must inherit the original theme`);
    for (const match of css.matchAll(/#[\da-f]{3,8}\b/gi)) {
      assert.ok(originalColors.has(match[0].toLowerCase()), `${file} introduces a new color ${match[0]}`);
    }
  }
  const refreshed = read("workbenchUi.css");
  assert.match(refreshed, /\.ui-app-active\s*\{[^}]*background:\s*#fff0ce/s);
  assert.match(refreshed, /\.ui-app-active\s*\{[^}]*color:\s*#8a5400/s);
});
