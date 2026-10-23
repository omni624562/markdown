import assert from "node:assert/strict";
import { test } from "node:test";
import { diffRange, lineDelta, shiftSourcepos, stripSourcepos } from "./preview-diff.ts";

test("去掉 sourcepos 後比較內容", () => {
  assert.equal(stripSourcepos('<p data-sourcepos="3:1-3:5">甲</p>'), "<p>甲</p>");
  assert.equal(
    stripSourcepos('<ul data-sourcepos="1:1-2:3"><li data-sourcepos="1:1-1:3">a</li></ul>'),
    "<ul><li>a</li></ul>",
  );
});

test("找出前後沒變的區塊", () => {
  assert.deepEqual(diffRange(["a", "b", "c", "d"], ["a", "b", "X", "d"]), { prefix: 2, suffix: 1 });
  // 插入一段
  assert.deepEqual(diffRange(["a", "b", "c"], ["a", "N", "b", "c"]), { prefix: 1, suffix: 2 });
  // 刪除一段
  assert.deepEqual(diffRange(["a", "b", "c"], ["a", "c"]), { prefix: 1, suffix: 1 });
  // 完全相同
  assert.deepEqual(diffRange(["a", "b"], ["a", "b"]), { prefix: 2, suffix: 0 });
  // 重複的內容：前後不重疊
  assert.deepEqual(diffRange(["x", "x"], ["x", "x", "x"]), { prefix: 2, suffix: 0 });
  assert.deepEqual(diffRange([], ["a"]), { prefix: 0, suffix: 0 });
});

test("行號平移", () => {
  assert.equal(lineDelta("3:1-5:10", "3:1-5:10"), 0);
  assert.equal(lineDelta("3:1-5:10", "4:1-6:10"), 1);
  assert.equal(lineDelta("3:1-5:10", "1:1-3:10"), -2);
  // 欄位或行數不同：不能只平移
  assert.equal(lineDelta("3:1-5:10", "4:3-6:12"), null);
  assert.equal(lineDelta("3:1-5:10", "4:1-7:10"), null);
  assert.equal(lineDelta(null, "1:1-1:1"), null);
  assert.equal(lineDelta(null, null), 0);
  assert.equal(shiftSourcepos("3:1-5:10", 2), "5:1-7:10");
  assert.equal(shiftSourcepos("bad", 2), "bad");
});
