import assert from "node:assert/strict";
import { test } from "node:test";
import { blockMath, inlineMath } from "./live-preview.ts";

test("行內公式的規則和 md-core 一致", () => {
  assert.deepEqual(inlineMath("能量 $E=mc^2$ 守恆"), [{ from: 3, to: 11, tex: "E=mc^2" }]);
  assert.deepEqual(inlineMath("價格是 $5 到 $10"), []); // 結尾的 $ 後面接數字
  assert.deepEqual(inlineMath("$ x $"), []); // 開頭或結尾是空白
  assert.deepEqual(inlineMath("跳脫 \\$x$"), []);
  assert.deepEqual(
    inlineMath("$a$ 和 $b$").map((m) => m.tex),
    ["a", "b"],
  );
});

test("區塊公式", () => {
  assert.equal(blockMath("$$\nE=mc^2\n$$"), "\nE=mc^2\n");
  assert.equal(blockMath("文字 $$x$$"), null);
});
