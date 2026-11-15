import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutMarks } from "./find-marks.ts";

test("符合處照在文件裡的比例放到軌道上", () => {
  assert.deepEqual(layoutMarks([0, 500, 1000], -1, 2000, 400), [
    { y: 0, current: false },
    { y: 100, current: false },
    { y: 200, current: false },
  ]);
});

test("落在同一個像素的合併成一條；裡面有目前選到的就算目前的", () => {
  assert.deepEqual(layoutMarks([1000, 1001, 1002, 3000], 1, 4000, 100), [
    { y: 25, current: true },
    { y: 75, current: false },
  ]);
});

test("不會畫到軌道外面；沒有高度時不畫", () => {
  assert.deepEqual(layoutMarks([4000], 0, 4000, 100), [{ y: 99, current: true }]);
  assert.deepEqual(layoutMarks([10], 0, 0, 100), []);
  assert.deepEqual(layoutMarks([10], 0, 100, 0), []);
});
