import assert from "node:assert/strict";
import { test } from "node:test";
import { FONT_NAME_LIMIT, cleanFontName, fontStack } from "./fonts.ts";

test("字型名稱去掉會破壞 CSS 的字元", () => {
  assert.equal(cleanFontName("  微軟正黑體 "), "微軟正黑體");
  assert.equal(cleanFontName('"Fira Code"'), "Fira Code");
  assert.equal(cleanFontName("A; } body { color: red"), "A body color: red");
  assert.equal(cleanFontName("a\nb\\c"), "abc");
  assert.equal(cleanFontName("x".repeat(200)).length, FONT_NAME_LIMIT);
});

test("自訂字型放在最前面，沒有設定時不覆寫", () => {
  assert.equal(fontStack("Cascadia Code", "var(--font-mono-default)"), '"Cascadia Code", var(--font-mono-default)');
  assert.equal(fontStack("  ", "serif"), "");
  assert.equal(fontStack('"', "serif"), "");
});
