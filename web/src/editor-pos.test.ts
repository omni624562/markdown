import assert from "node:assert/strict";
import { test } from "node:test";
import { posAt } from "./editor-pos.ts";

const view = (posAtCoords: () => number | null) => ({
  posAtCoords,
  documentTop: 100,
  // 每行 20px：第 n 行從 n * 10 開始。
  lineBlockAtHeight: (h: number) => ({ from: Math.floor(h / 20) * 10 }),
});

test("posAt：照常回傳位置；CodeMirror 內部出錯時改用滑鼠所在那一行的開頭，不往外丟", () => {
  assert.equal(posAt(view(() => 42), 10, 150), 42);
  assert.equal(posAt(view(() => null), 10, 150), null, "在文件外面照樣是 null");
  const broken = view(() => {
    throw new TypeError("Cannot read properties of null (reading 'length')");
  });
  // y = 165：離文件頂端 65px，第 3 行（從 30 開始）。
  assert.equal(posAt(broken, 10, 165), 30);
});
