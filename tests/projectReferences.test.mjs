import assert from "node:assert/strict";
import test from "node:test";

import { cleanMatchValue, planProjectReferences } from "../src/projectReferences.js";

function image(name) {
  return {
    key: `image:${name}`,
    kind: "image",
    file: { name },
    name,
  };
}

test("cleans spaces, hidden newlines, full-width digits, and full-width underscores", () => {
  assert.equal(cleanMatchValue(" \r０１１＿人物１\n "), "011_人物1");
});

test("matches a complete filename exactly before extension fallback", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n011_人物1.jpg",
    [image("011_人物1.jpg")],
  );

  assert.equal(plan.matches.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n@011_人物1=011_人物1.jpg");
});

test("matches exactly after removing only the asset extension", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n011_人物1",
    [image("011_人物1.jpg")],
  );

  assert.equal(plan.matches.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n@011_人物1=011_人物1");
});

test("keeps the numeric prefix and normalizes full-width match characters", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n０１１＿人物１",
    [image("011_人物1.png")],
  );

  assert.equal(plan.matches.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n@011_人物1=011_人物1");
});

test("does not use contains or similarity matching", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n011_人物正面",
    [image("011_人物背面.jpg"), image("011_人物正面特写.jpg")],
  );

  assert.equal(plan.matches.length, 0);
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.annotatedPrompt, "【本节出场的所有人物】\n011_人物正面");
});

test("does not choose between duplicate extensionless filenames", () => {
  const plan = planProjectReferences(
    "【本节出场的所有人物】\n011_人物1",
    [image("011_人物1.jpg"), image("011_人物1.png")],
  );

  assert.equal(plan.matches.length, 0);
  assert.equal(plan.missing.length, 1);
});
