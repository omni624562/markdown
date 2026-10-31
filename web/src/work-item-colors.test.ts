import assert from "node:assert/strict";
import { test } from "node:test";
import { darkVariant, FALLBACK_COLOR, isCustomKind, KIND_COLOR_LIMIT, kindColor, kindColorCss, kindKey, sanitizeKindColors } from "./work-item-colors.ts";

test("類型的比對用名稱：不分大小寫，空白換成連字號", () => {
  assert.equal(kindKey("User Story"), "user-story");
  assert.equal(kindKey("  Product  Backlog Item "), "product-backlog-item");
  assert.equal(kindKey("錯誤"), "錯誤");
});

test("類型的顏色：自訂優先，其次預設，其他用灰色", () => {
  assert.equal(kindColor("Bug", {}), "#cc293d");
  assert.equal(kindColor("bug", {}), "#cc293d");
  assert.equal(kindColor("User Story", {}), kindColor("Product Backlog Item", {}));
  assert.equal(kindColor("自訂類型", {}), FALLBACK_COLOR);
  assert.equal(kindColor("Bug", { bug: "#00aa00" }), "#00aa00");
  assert.equal(kindColor("自訂類型", { 自訂類型: "#123456" }), "#123456");
  assert.equal(isCustomKind("BUG", { Bug: "#00aa00" }), true);
  assert.equal(isCustomKind("Task", { Bug: "#00aa00" }), false);
});

test("自訂顏色：格式不對的略過", () => {
  assert.equal(sanitizeKindColors(null), null);
  assert.equal(sanitizeKindColors(["#fff"]), null);
  assert.deepEqual(sanitizeKindColors({ Bug: "#00AA00", Task: "red", "": "#000000", " Epic ": "#112233", bug: "#ffffff" }), {
    colors: { Bug: "#00aa00", Epic: "#112233" },
    dropped: true,
  });
  assert.deepEqual(sanitizeKindColors({ Bug: "#00aa00" }), { colors: { Bug: "#00aa00" }, dropped: false });
  const many = Object.fromEntries(Array.from({ length: KIND_COLOR_LIMIT + 5 }, (_, i) => [`K${i}`, "#000000"]));
  const out = sanitizeKindColors(many)!;
  assert.equal(Object.keys(out.colors).length, KIND_COLOR_LIMIT);
  assert.equal(out.dropped, true);
});

test("深色主題：太暗的顏色提高亮度，夠亮的不變", () => {
  assert.equal(darkVariant("#ffffff"), "#ffffff");
  assert.equal(darkVariant("#000000"), "#9e9e9e");
  // 深藍色變亮，色相不變（還是藍色）。
  const v = darkVariant("#0000aa");
  assert.match(v, /^#[0-9a-f]{6}$/);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  assert.ok(b > 200 && r === g && r < b);
  assert.equal(darkVariant("#f0707f"), "#f0707f");
});

test("產生的 CSS：預設類型都有規則，自訂的蓋過預設，名稱跳脫", () => {
  const css = kindColorCss({ Bug: "#00aa00", 'a"b': "#123456" });
  assert.match(css, /:root \[data-wi-kind="task"\] \{ --kind: light-dark\(#a37c00, #f2cb1d\); \}/);
  assert.match(css, /\[data-wi-kind="bug"\] \{ --kind: light-dark\(#00aa00, #[0-9a-f]{6}\); \}/);
  assert.doesNotMatch(css, /#cc293d/);
  assert.match(css, /\[data-wi-kind="a\\"b"\]/);
  assert.equal(css.split("\n").filter((l) => l.includes('"bug"')).length, 1);
});
