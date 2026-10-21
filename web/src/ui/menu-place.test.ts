import assert from "node:assert/strict";
import { test } from "node:test";
import { placeMenu } from "./menu-place.ts";

const VIEW = { width: 1916, height: 760 };
const box = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h });

test("右上角的按鈕：選單太高時留在畫面內並可捲動", () => {
  // 之前的錯誤：選單被移到按鈕右邊（left 1914、top −822），整個跑到畫面外。
  const p = placeMenu(box(1870, 4, 40, 32), { width: 260, height: 900 }, VIEW);
  assert.equal(p.left, VIEW.width - 8 - 260);
  assert.equal(p.top, 40);
  assert.equal(p.maxHeight, 760 - 8 - 40);
  assert.ok(p.left >= 8 && p.left + 260 <= VIEW.width - 8);
});

test("放得下就往下開、靠左對齊", () => {
  assert.deepEqual(placeMenu(box(100, 4, 32, 32), { width: 240, height: 300 }, VIEW), { left: 100, top: 40, maxHeight: 712 });
});

test("左下角的按鈕往上開", () => {
  const p = placeMenu(box(8, 700, 32, 32), { width: 200, height: 120 }, VIEW);
  assert.equal(p.top, 700 - 4 - 120);
  assert.equal(p.left, 8);
});

test("右鍵選單：靠近下緣時往上開", () => {
  const p = placeMenu(box(600, 650, 0, 0), { width: 240, height: 500 }, VIEW);
  assert.equal(p.top, 650 - 4 - 500);
});

test("子選單開在右邊，右邊放不下改開在左邊", () => {
  const item = box(1000, 200, 240, 34);
  assert.equal(placeMenu(item, { width: 220, height: 200 }, VIEW, "right").left, 1244);
  const nearEdge = box(1650, 200, 260, 34);
  assert.equal(placeMenu(nearEdge, { width: 220, height: 200 }, VIEW, "right").left, 1650 - 4 - 220);
  // 下方放不下時往上移
  assert.equal(placeMenu(box(1000, 700, 240, 34), { width: 220, height: 200 }, VIEW, "right").top, 760 - 8 - 200);
});
