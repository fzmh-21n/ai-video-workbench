import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  defaultMonitorEnabled,
  formatPlayCount,
  matchDramaProject,
  mergeDailyHistory,
  normalizeDramaTitle,
  parseDouyinBillboard,
  parseDouyinBillboardTabs,
  summarizeDramaPlays,
  totalDouyinSeries,
} from "../src/dramaTraffic.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/drama-traffic/${name}`, import.meta.url), "utf8"));

test("drama titles normalize book-title marks, spaces, punctuation and full/half width", () => {
  assert.equal(normalizeDramaTitle("《温柔以待，终有回甘》"), normalizeDramaTitle("温柔以待 终有回甘"));
  assert.equal(normalizeDramaTitle("发现丈夫不对劲那天，我笑了！"), "发现丈夫不对劲那天我笑了");
  assert.equal(normalizeDramaTitle("ＡＢＣ　剧场（第２季）"), "abc剧场第2季");
  assert.equal(normalizeDramaTitle("母凭子贵后被皇家宠上天3"), normalizeDramaTitle("《母凭子贵后被皇家宠上天３》"));
  assert.notEqual(normalizeDramaTitle("母凭子贵后被皇家宠上天2"), normalizeDramaTitle("母凭子贵后被皇家宠上天3"));
  assert.equal(normalizeDramaTitle(null), "");
});

test("parses the recorded Douyin billboard tab list and a billboard page", () => {
  const tabs = parseDouyinBillboardTabs(fixture("douyin-billboard-tab.json"));
  assert.ok(tabs.length >= 5);
  assert.deepEqual(tabs[0], { type: 1001, name: "热播榜" });
  const page = parseDouyinBillboard(fixture("douyin-billboard-1001-p1.json"), tabs[0]);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 15);
  assert.equal(page.entries.length, 3);
  const [first] = page.entries;
  assert.equal(first.title, "发现丈夫不对劲那天，我笑了");
  assert.equal(first.playCount, 215205502);
  assert.equal(first.collectCount, 220400);
  assert.equal(first.board, "热播榜");
  assert.equal(first.account, "月光剧场");
  assert.ok(first.tags.includes("悬疑情感"));
  assert.throws(() => parseDouyinBillboard({ status_code: 2154, status_msg: "访问太频繁" }), /访问太频繁/);
  assert.throws(() => parseDouyinBillboard(null), /格式无效/);
  assert.deepEqual(parseDouyinBillboard({ status_code: 0 }).entries, []);
});

test("project names match chart entries after normalization and pick the highest play count", () => {
  const { entries } = parseDouyinBillboard(fixture("douyin-billboard-1001-p1.json"), { name: "热播榜", type: 1001 });
  const duplicate = { ...entries[2], board: "爱情榜", playCount: 1 };
  assert.equal(matchDramaProject("《温柔以待 终有回甘》", [...entries, duplicate]).playCount, 838449229);
  assert.equal(matchDramaProject("不存在的短剧", entries), null);
  assert.equal(matchDramaProject("", entries), null);
  assert.equal(defaultMonitorEnabled("未归类"), false);
  assert.equal(defaultMonitorEnabled("温柔以待，终有回甘"), true);
});

test("daily history keeps one point per day in order", () => {
  let history = mergeDailyHistory([], { date: "2026-11-02", playCount: 20 });
  history = mergeDailyHistory(history, { date: "2026-11-01", playCount: 10 });
  history = mergeDailyHistory(history, { date: "2026-11-02", playCount: 25 });
  assert.deepEqual(history, [{ date: "2026-11-01", playCount: 10 }, { date: "2026-11-02", playCount: 25 }]);
  assert.equal(mergeDailyHistory(history, { date: "2026-11-03", playCount: 30 }, 2).length, 2);
});

test("totals add automatic Douyin plays (monitored, active only) and the latest manual Hongguo month per project", () => {
  const projects = [
    { name: "A", monitor: true, active: true, douyin: { playCount: 1500 }, history: [{ date: "2026-11-13", playCount: 1000 }, { date: "2026-11-14", playCount: 1500 }] },
    { name: "B", monitor: true, active: true, douyin: { playCount: 300 }, history: [{ date: "2026-11-14", playCount: 300 }] },
    { name: "C", monitor: false, active: true, douyin: { playCount: 9999 }, history: [] },
    { name: "D", monitor: true, active: false, douyin: { playCount: 9999 }, history: [] },
    { name: "E", monitor: true, active: true, douyin: null, history: [] },
  ];
  const hongguo = [
    { projectName: "A", month: "2026-10", playCount: 100 },
    { projectName: "A", month: "2026-11", playCount: 250 },
    { projectName: "B", month: "2026-09", playCount: 40 },
    { projectName: "已删除项目", month: "2026-11", playCount: 5000 },
  ];
  const totals = summarizeDramaPlays(projects, hongguo, ["A", "B", "C", "E"]);
  assert.equal(totals.douyinPlays, 1800);
  assert.equal(totals.douyinDelta, 500);
  assert.equal(totals.hasDouyinDelta, true);
  assert.equal(totals.monitored, 3);
  assert.equal(totals.douyinFound, 2);
  assert.equal(totals.hongguoPlays, 290);
  assert.equal(totals.hongguoDelta, 150);
  assert.equal(totals.hongguoProjects, 2);
  assert.equal(totals.totalPlays, 2090);
  assert.deepEqual(totalDouyinSeries(projects), [{ date: "2026-11-13", value: 1000 }, { date: "2026-11-14", value: 1800 }]);
});

test("play counts are formatted in 万/亿", () => {
  assert.equal(formatPlayCount(838449229), "8.38亿");
  assert.equal(formatPlayCount(3568000), "356.8万");
  assert.equal(formatPlayCount(9999), "9999");
  assert.equal(formatPlayCount(undefined), "—");
});
