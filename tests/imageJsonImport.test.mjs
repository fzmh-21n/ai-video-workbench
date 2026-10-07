import assert from "node:assert/strict";
import test from "node:test";

import { imageJsonGenerationItem, parseImagePromptJson, completedImagePromptIds } from "../src/imageJsonImport.js";

test("edited JSON descriptions or names are never cleared as already completed", () => {
  const row = { id: "role1", name: "角色甲", prompt: "身穿白衣" };
  const task = { status: "completed", sourcePromptId: row.id, title: row.name, prompt: "统一风格\n\n身穿白衣" };
  assert.deepEqual([...completedImagePromptIds([row], [task], "统一风格")], ["role1"]);
  assert.equal(completedImagePromptIds([{ ...row, prompt: "身穿蓝衣" }], [task], "统一风格").size, 0);
  assert.equal(completedImagePromptIds([{ ...row, name: "角色乙" }], [task], "统一风格").size, 0);
  assert.equal(completedImagePromptIds([row], [task], "新风格").size, 0);
  assert.equal(completedImagePromptIds([row], [{ ...task, status: "failed" }], "统一风格").size, 0);
});

test("imports one editable prompt per entry and keeps description text unchanged", () => {
  const description = "  第一行\r\n第二行\n\n@Image1 与原文标点。  ";
  assert.deepEqual(parseImagePromptJson(JSON.stringify([
    { name: "  角色甲  ", aliases: "角色甲，甲", description },
    { name: "场景乙", description: "夜间庭院" },
  ]), "角色场景.json"), [
    { name: "角色甲", aliases: "角色甲，甲", prompt: description, sourceFile: "角色场景.json" },
    { name: "场景乙", aliases: "", prompt: "夜间庭院", sourceFile: "角色场景.json" },
  ]);
});

test("accepts a UTF-8 BOM and ignores non-string aliases", () => {
  assert.deepEqual(parseImagePromptJson('\uFEFF[{"name":"角色甲","aliases":["甲"],"description":"白衣人物"}]'), [
    { name: "角色甲", aliases: "", prompt: "白衣人物", sourceFile: "" },
  ]);
});

test("does not merge same-name entries with different descriptions", () => {
  const rows = parseImagePromptJson(JSON.stringify([
    { name: "角色甲", description: "青年状态" },
    { name: "角色甲", description: "中年状态" },
  ]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.prompt), ["青年状态", "中年状态"]);
});

test("creates independent text-to-image requests with a fixed prefix and no references", () => {
  const rows = parseImagePromptJson(JSON.stringify([
    { name: "角色甲", aliases: "不要加入提示词的别名", description: "白衣人物\n细节甲" },
    { name: "场景乙", description: "夜间庭院\n细节乙" },
  ]));
  const items = rows.map((row, index) => imageJsonGenerationItem({ ...row, id: `row-${index}` }, "统一画风"));
  assert.deepEqual(items, [
    { prompt: "统一画风\n\n白衣人物\n细节甲", title: "角色甲", sourceName: null, sourcePromptId: "row-0", references: [] },
    { prompt: "统一画风\n\n夜间庭院\n细节乙", title: "场景乙", sourceName: null, sourcePromptId: "row-1", references: [] },
  ]);
});

test("uses the row prompt without a fixed prefix when fixed content is empty", () => {
  assert.deepEqual(imageJsonGenerationItem({ name: "角色甲", prompt: "白衣人物" }), {
    prompt: "白衣人物", title: "角色甲", sourceName: null, sourcePromptId: null, references: [],
  });
});

test("reports malformed JSON with its source filename", () => {
  assert.throws(() => parseImagePromptJson('[{"name":', "坏文件.json"), /坏文件\.json：JSON 格式错误/);
});

test("rejects a non-array root and an empty array", () => {
  assert.throws(() => parseImagePromptJson('{"name":"角色甲"}', "角色.json"), /角色\.json：JSON 顶层必须是数组/);
  assert.throws(() => parseImagePromptJson("[]", "角色.json"), /角色\.json：JSON 数组不能为空/);
});

test("rejects invalid entry shapes instead of silently skipping them", () => {
  for (const entry of [null, [], "角色甲", 1]) {
    assert.throws(() => parseImagePromptJson(JSON.stringify([
      { name: "有效条目", description: "有效描述" }, entry,
    ]), "角色.json"), /角色\.json：第 2 条必须是对象/);
  }
});

test("requires a non-empty string name and points to the invalid entry", () => {
  for (const name of [undefined, "", "  ", 12, null]) {
    assert.throws(() => parseImagePromptJson(JSON.stringify([
      { name: "有效条目", description: "有效描述" }, { name, description: "描述" },
    ]), "角色.json"), /角色\.json：第 2 条的 name 必须是非空字符串/);
  }
});

test("requires a non-empty string description and points to the invalid entry", () => {
  for (const description of [undefined, "", " \r\n ", 12, null]) {
    assert.throws(() => parseImagePromptJson(JSON.stringify([
      { name: "有效条目", description: "有效描述" }, { name: "角色甲", description },
    ]), "角色.json"), /角色\.json：第 2 条的 description 必须是非空字符串/);
  }
});
