import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDramaTrafficService, DRAMA_TRAFFIC_FILE } from "../serverDramaTraffic.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/drama-traffic/${name}`, import.meta.url), "utf8"));
const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function fakeFetch({ failAll = false, failFirst = 0 } = {}) {
  const calls = [];
  let failures = failFirst;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (failAll) throw new Error("network down");
    if (failures > 0) { failures -= 1; throw new Error("timeout"); }
    if (url.includes("/billboard/tab/")) return jsonResponse({ billboard_type_list: [{ type: 1001, name: "热播榜" }, { type: 1940, name: "爱情榜" }], status_code: 0 });
    const parsed = new URL(url);
    if (parsed.searchParams.get("billboard_type") === "1001" && parsed.searchParams.get("offset") === "0") return jsonResponse(fixture("douyin-billboard-1001-p1.json"));
    return jsonResponse({ series_infos: [], has_more: false, offset: 0, status_code: 0 });
  };
  return { calls, fetchImpl };
}

function service(options) {
  const dir = mkdtempSync(path.join(tmpdir(), "drama-traffic-"));
  let clock = new Date(2026, 10, 14, 9).getTime();
  const instance = createDramaTrafficService({ dataDir: dir, pageDelayMs: 0, retryDelayMs: 0, logger: null, now: () => clock, ...options });
  return { dir, instance, advance: (ms) => { clock += ms; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("refresh matches synced project names, stores history on disk and keeps last value when not found", async (t) => {
  const { fetchImpl, calls } = fakeFetch();
  const { dir, instance, advance, cleanup } = service({ fetchImpl });
  t.after(cleanup);
  instance.syncProjects(["《温柔以待，终有回甘》", "还没上架的剧", "未归类"]);
  assert.equal(instance.isDue(), true);
  const snapshot = await instance.refresh("test");
  assert.equal(snapshot.lastRun.status, "ok");
  assert.ok(calls.every((url) => url.startsWith("https://api.amemv.com/aweme/v1/series/billboard/")));
  const byName = Object.fromEntries(snapshot.projects.map((project) => [project.name, project]));
  assert.equal(byName["《温柔以待，终有回甘》"].status, "found");
  assert.equal(byName["《温柔以待，终有回甘》"].douyin.playCount, 838449229);
  assert.deepEqual(byName["《温柔以待，终有回甘》"].history, [{ date: "2026-11-14", playCount: 838449229 }]);
  assert.equal(byName["还没上架的剧"].status, "not_found");
  assert.equal(byName["未归类"].monitor, false);
  assert.equal(byName["未归类"].status, "disabled");
  const saved = JSON.parse(readFileSync(path.join(dir, DRAMA_TRAFFIC_FILE), "utf8"));
  assert.equal(saved.projects["《温柔以待，终有回甘》"].douyin.playCount, 838449229);
  assert.equal(instance.isDue(), false);
  advance(24 * 60 * 60 * 1000);
  assert.equal(instance.isDue(), true);
});

test("a failed fetch keeps last-known values, marks 未取到 and retries sooner", async (t) => {
  const ok = fakeFetch();
  const { dir, instance, advance, cleanup } = service({ fetchImpl: ok.fetchImpl });
  t.after(cleanup);
  instance.syncProjects(["温柔以待，终有回甘"]);
  await instance.refresh();
  advance(24 * 60 * 60 * 1000);
  const down = createDramaTrafficService({ dataDir: dir, fetchImpl: fakeFetch({ failAll: true }).fetchImpl, pageDelayMs: 0, retryDelayMs: 0, logger: null, now: () => new Date(2026, 10, 15, 9).getTime() });
  const snapshot = await down.refresh();
  assert.equal(snapshot.lastRun.status, "failed");
  const project = snapshot.projects.find((item) => item.name === "温柔以待，终有回甘");
  assert.equal(project.status, "failed");
  assert.equal(project.douyin.playCount, 838449229);
  assert.equal(project.history.length, 1);
  assert.equal(snapshot.nextRunAt - snapshot.lastRun.startedAt, 2 * 60 * 60 * 1000);
  advance(0);
});

test("requests retry once, concurrent refreshes share one run, renamed projects deactivate and monitor can be turned off", async (t) => {
  const flaky = fakeFetch({ failFirst: 1 });
  const { instance, cleanup } = service({ fetchImpl: flaky.fetchImpl });
  t.after(cleanup);
  instance.syncProjects(["旧名字"]);
  const [first, second] = [instance.refresh(), instance.refresh()];
  assert.equal(first, second);
  assert.equal((await first).lastRun.status, "ok");
  const tabCalls = flaky.calls.filter((url) => url.includes("/tab/"));
  assert.equal(tabCalls.length, 2, "tab request retried once after a timeout");
  const renamed = instance.syncProjects(["温柔以待，终有回甘"]);
  const byName = Object.fromEntries(renamed.projects.map((project) => [project.name, project]));
  assert.equal(byName["旧名字"].active, false);
  assert.equal(byName["温柔以待，终有回甘"].status, "found", "new names are matched immediately from the last billboard");
  const off = instance.setMonitor("温柔以待，终有回甘", false);
  assert.equal(off.projects.find((project) => project.name === "温柔以待，终有回甘").monitor, false);
  assert.equal(instance.isDue(), false, "nothing to monitor");
  assert.throws(() => instance.syncProjects("not-array"), /数组/);
  assert.throws(() => instance.setMonitor("不存在", true), /不存在/);
});

test("projects not on the billboards fall back to a pasted Douyin series/mix link", async (t) => {
  const base = fakeFetch();
  const calls = [];
  const seriesDetail = { status_code: 0, series_info: { series_id: "7447840066937817128", series_name: "短剧 · 蛟泪归海", stats: { play_vv: 12345678, collect_vv: 9, total_episode: 60 }, author: { nickname: "测试号" } } };
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.startsWith("https://v.douyin.com/")) return { ok: false, status: 302, headers: { get: () => "https://www.iesdouyin.com/share/playlet/detail/7447840066937817128/?from_ssr=1" } };
    if (url.includes("/series/detail/")) return jsonResponse(seriesDetail);
    if (url.includes("/mix/detail/")) return jsonResponse({ status_code: 5, status_msg: "参数不合法" });
    return base.fetchImpl(url, options);
  };
  const { instance, cleanup } = service({ fetchImpl });
  t.after(cleanup);
  instance.syncProjects(["蛟泪归海", "没链接的剧"]);
  await assert.rejects(instance.setLink("蛟泪归海", "随便写的"), /没认出/);
  let snapshot = await instance.setLink("蛟泪归海", "7.43 复制打开抖音 https://v.douyin.com/AbC123/ 我正在看【蛟泪归海】");
  let project = snapshot.projects.find((row) => row.name === "蛟泪归海");
  assert.deepEqual({ kind: project.douyinLink.kind, id: project.douyinLink.id }, { kind: "series", id: "7447840066937817128" });
  assert.equal(project.status, "found");
  assert.equal(project.douyin.playCount, 12345678);
  assert.equal(project.douyin.title, "蛟泪归海");
  snapshot = await instance.refresh("test");
  project = snapshot.projects.find((row) => row.name === "蛟泪归海");
  assert.equal(project.status, "found");
  assert.equal(project.douyin.board, "短剧链接");
  assert.equal(snapshot.lastRun.linked, 1);
  assert.equal(snapshot.projects.find((row) => row.name === "没链接的剧").status, "not_found");
  assert.equal(calls.filter((url) => url.includes("/series/detail/")).length, 2);
  snapshot = await instance.setLink("蛟泪归海", "");
  assert.equal(snapshot.projects.find((row) => row.name === "蛟泪归海").douyinLink, undefined);
});

test("a failing link keeps the last value and reports the problem", async (t) => {
  const base = fakeFetch();
  let fail = false;
  const fetchImpl = async (url, options) => {
    if (url.includes("/detail/")) {
      if (fail) throw new Error("network down");
      return jsonResponse({ status_code: 0, mix_info: { mix_id: "7640082975291344931", mix_name: "知微辞", statis: { play_vv: 5000 } } });
    }
    return base.fetchImpl(url, options);
  };
  const { instance, cleanup } = service({ fetchImpl });
  t.after(cleanup);
  instance.syncProjects(["知微辞"]);
  await instance.setLink("知微辞", "https://www.douyin.com/collection/7640082975291344931");
  fail = true;
  const snapshot = await instance.refresh("test");
  const project = snapshot.projects.find((row) => row.name === "知微辞");
  assert.equal(project.status, "failed");
  assert.match(project.message, /抖音链接读取失败/);
  assert.equal(project.douyin.playCount, 5000);
});
