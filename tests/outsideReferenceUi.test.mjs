import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("the real batch reference chip marks outside images without adding an automatic mention to the prompt", async () => {
  const previousStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const cast = "角色图_001_许小禾日常.png";
  const outside = "角色图_002_许小禾样衣_v2.png";
  const prompt = `【出场人物】@角色图_001_许小禾日常=${cast}\n【场景环境】${outside}仅参考样衣，不作为现场人物。`;
  const references = [
    { id: "cast", kind: "image", name: cast, alias: cast.slice(0, -4), tag: "@Image1", source: "automatic", projectAssetKey: `image:${cast}` },
    { id: "outside", kind: "image", name: outside, alias: outside.slice(0, -4), tag: "@Image2", source: "automatic", projectAssetKey: `image:${outside}`, noAutoMention: true },
  ];
  globalThis.window = {};
  globalThis.localStorage = { getItem: (key) => key === "video-workbench-batch-v1" ? JSON.stringify({ items: [{ id: "row", section: 1, sourceName: "第1集.txt", prompt, references, status: "matched", expanded: true }] }) : null };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { default: BatchPanel } = await vite.ssrLoadModule("/src/BatchPanel.jsx");
    const html = renderToStaticMarkup(React.createElement(BatchPanel, {
      activeProfile: { id: "mock", adapter: "mock", name: "mock", model: "mock" }, apiKey: "",
      capability: { images: 9, audios: 3, videos: 3, durations: [30], resolutions: ["720p"], ratios: ["16:9"] },
      duration: 30, resolution: "720p", ratio: "16:9", quantity: 1, seed: "", syncAudio: false,
      fixedContent: "", fixedContentTemplates: [], fixedContentTemplateId: "", projectAssets: [], taskDatabaseReady: false,
    }));
    const chips = [...html.matchAll(/<button[^>]*class="batch-reference-insert"[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1]);
    assert.equal(chips.length, 2);
    assert.ok(!chips[0].includes("模块外参考"));
    assert.ok(chips[1].includes(`${outside}（模块外参考，未自动@）`));
    assert.ok(!chips[1].includes("@Image2"), "outside reference chips must not look like an automatic mention");
    const card = html.match(/<article\b[\s\S]*?<\/article>/)[0];
    const textarea = card.match(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/)[1];
    assert.ok(textarea.includes(`${outside}仅参考样衣`));
    assert.ok(!textarea.includes("@Image2"));
    assert.ok(!textarea.includes(`@${outside.slice(0, -4)}=`));
    assert.ok(!html.includes("batch-missing-badge"));
    assert.match(html, /图2/);
  } finally {
    await vite.close();
    globalThis.localStorage = previousStorage;
    globalThis.window = previousWindow;
  }
});
