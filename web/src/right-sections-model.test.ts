import assert from "node:assert/strict";
import { test } from "node:test";
import { SPLIT, clampSplit, formatCollapsed, parseCollapsed, parseSplit, stepSplit } from "./right-sections-model.ts";

test("收合狀態：讀回記住的分區，不認得的略過；存的時候依分區順序", () => {
  assert.deepEqual([...parseCollapsed(null)], []);
  assert.deepEqual([...parseCollapsed("")], []);
  assert.deepEqual([...parseCollapsed("wiki, outline,舊的")], ["outline", "wiki"]);
  assert.equal(formatCollapsed(new Set(["wiki", "backlinks"] as const)), "backlinks,wiki");
  assert.equal(formatCollapsed(parseCollapsed(formatCollapsed(new Set(["outline"] as const)))), "outline");
});

test("分隔線位置：沒記過或亂掉時用預設值，超出範圍時拉回來", () => {
  assert.equal(parseSplit(null), SPLIT.default);
  assert.equal(parseSplit(""), SPLIT.default);
  assert.equal(parseSplit("abc"), SPLIT.default);
  assert.equal(parseSplit("0.3333333"), 0.333);
  assert.equal(parseSplit("0"), SPLIT.min);
  assert.equal(parseSplit("5"), SPLIT.max);
});

test("拖曳時上下都至少留一點高度", () => {
  // 600 像素：上面至少 96（0.16），下面至少 120（0.8）。
  assert.equal(clampSplit(0.5, 600), 0.5);
  assert.equal(clampSplit(0.01, 600), 0.16);
  assert.equal(clampSplit(0.99, 600), 0.8);
  // 很高的右側欄：比例的上下限（0.1～0.9）先擋住。
  assert.equal(clampSplit(0, 3000), SPLIT.min);
  assert.equal(clampSplit(1, 3000), SPLIT.max);
  // 放不下兩邊的最小高度：照最小高度的比例分。
  assert.equal(clampSplit(0.9, 150), Math.round((SPLIT.minTop / (SPLIT.minTop + SPLIT.minBottom)) * 1000) / 1000);
  // 不知道高度（還沒顯示出來）、比例不是數字。
  assert.equal(clampSplit(0.95, 0), SPLIT.max);
  assert.equal(clampSplit(NaN, 600), SPLIT.default);
});

test("方向鍵一次移幾個像素，到邊界就停", () => {
  assert.equal(stepSplit(0.5, SPLIT.step, 800), 0.52);
  assert.equal(stepSplit(0.5, -SPLIT.bigStep, 800), 0.44);
  assert.equal(stepSplit(0.17, -SPLIT.bigStep, 600), 0.16);
  assert.equal(stepSplit(0.5, 10, 0), 0.5);
});
