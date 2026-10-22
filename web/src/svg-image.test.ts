import assert from "node:assert/strict";
import { test } from "node:test";
import { svgDataUrl, viewBoxSize } from "./svg-image.ts";

test("從 viewBox 取得圖片大小", () => {
  assert.deepEqual(viewBoxSize("0 0 812.5 300"), { width: 812.5, height: 300 });
  assert.deepEqual(viewBoxSize("-8 -8, 200,100"), { width: 200, height: 100 });
  assert.equal(viewBoxSize(null), null);
  assert.equal(viewBoxSize("0 0 0 100"), null);
  assert.equal(viewBoxSize("0 0 abc 100"), null);
});

test("SVG 轉成 data 網址時跳脫特殊字元", () => {
  assert.equal(svgDataUrl('<svg a="#"/>'), "data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D%22%23%22%2F%3E");
});
