import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("batch prompt character counts render from each item's current prompt", async (t) => {
  const previousStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  globalThis.window = {};
  let storedItems = [];
  globalThis.localStorage = {
    getItem: (key) => key === "video-workbench-batch-v1"
      ? JSON.stringify({ items: storedItems })
      : null,
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { default: BatchPanel } = await vite.ssrLoadModule("/src/BatchPanel.jsx");
    const props = {
      activeProfile: { id: "mock", adapter: "mock", name: "mock", model: "mock" },
      apiKey: "",
      capability: { durations: [15], resolutions: ["720p"], ratios: ["16:9"], images: 9, audio: 3, videos: 3 },
      duration: 15,
      resolution: "720p",
      ratio: "16:9",
      quantity: 1,
      seed: "",
      syncAudio: false,
      fixedContent: "公共固定内容，不计入本条。\n ASCII 🙂",
      fixedContentTemplates: [],
      fixedContentTemplateId: "",
      fixedContentVersionLabel: "测试",
      projectAssets: [],
      taskDatabaseReady: false,
    };
    const render = (items, changes = {}) => {
      storedItems = items.map((item, index) => ({
        id: `item-${index}`,
        section: index + 1,
        title: `测试${index + 1}`,
        status: "pending",
        references: [],
        ...item,
      }));
      return renderToStaticMarkup(React.createElement(BatchPanel, { ...props, ...changes }));
    };
    const cards = (html) => [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].map(([card]) => card);
    const countInHead = (card, expected) => {
      const head = card.match(/<button class="batch-card-head"[^>]*>[\s\S]*?<\/button>/)?.[0];
      assert.ok(head, "each item has an always-visible card heading");
      assert.ok(head.includes('class="batch-card-summary"'));
      assert.ok(head.includes(`class="batch-prompt-count" title="本条提示词字符数，含标点、空格和换行，不含公共固定内容">提示词 ${expected} 字符</span>`), `expected this card's prompt count to be ${expected}`);
      assert.equal((card.match(/class="batch-prompt-count"/g) || []).length, 1);
    };

    await t.test("each collapsed or expanded card keeps its own count visible, including an empty prompt", () => {
      const rendered = cards(render([
        { prompt: "中文 A!\n🙂", expanded: false },
        { prompt: "B?", expanded: true },
        { prompt: "", expanded: true },
      ]));
      assert.equal(rendered.length, 3);
      countInHead(rendered[0], 7);
      countInHead(rendered[1], 2);
      countInHead(rendered[2], 0);
      assert.ok(!rendered[0].includes('class="batch-card-body"'));
      assert.ok(rendered[1].includes('class="batch-card-body"'));
    });

    await t.test("Unicode code points count once while whitespace and punctuation remain included", () => {
      const rendered = cards(render([
        { prompt: "🙂🚀𠮷", expanded: false },
        { prompt: " \n中A，。\n ", expanded: false },
      ]));
      countInHead(rendered[0], 3);
      countInHead(rendered[1], 8);
    });

    await t.test("editing the prompt updates the count when the component renders again", () => {
      const item = { prompt: "旧", expanded: true };
      countInHead(cards(render([item]))[0], 1);
      item.prompt = "新提示词🙂";
      countInHead(cards(render([item]))[0], 5);
    });

    await t.test("changing public fixed content never changes an item's prompt count", () => {
      const item = { prompt: "本条", expanded: false };
      countInHead(cards(render([item], { fixedContent: "" }))[0], 2);
      countInHead(cards(render([item], { fixedContent: "公共内容\n🙂".repeat(20) }))[0], 2);
    });
  } finally {
    await vite.close();
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
