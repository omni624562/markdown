import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACCENTS, DEFAULT_PALETTE, PALETTES, accentColors, accentVars, contrast, isPalette, parseAccent, textOn } from "./palette.ts";

test("配色風格：預設是森林綠，四種綠色系與其他風格都在清單裡", () => {
  assert.equal(DEFAULT_PALETTE, "forest");
  assert.deepEqual(
    PALETTES.map((p) => p.id),
    ["forest", "mint", "matcha", "night", "clean", "classic", "project", "contrast"],
  );
  assert.deepEqual(
    PALETTES.filter((p) => p.darkOnly).map((p) => p.id),
    ["night"],
  );
});

test("配色風格：只認得清單裡的名稱", () => {
  assert.equal(isPalette("mint"), true);
  assert.equal(isPalette("Mint"), false);
  assert.equal(isPalette('forest"]'), false);
  assert.equal(isPalette(null), false);
});

test("配色風格：palettes.css 都有對應的規則，theme-init.js 也認得", () => {
  const css = readFileSync(new URL("./palettes.css", import.meta.url), "utf8");
  const init = readFileSync(new URL("../public/theme-init.js", import.meta.url), "utf8");
  for (const p of PALETTES) {
    assert.ok(css.includes(`[data-palette="${p.id}"]`), p.id);
    assert.ok(init.includes(`"${p.id}"`), p.id);
  }
  assert.ok(init.includes(`: "${DEFAULT_PALETTE}"`));
});

test("強調色：設定值只接受預設的名稱或 #rrggbb", () => {
  assert.equal(parseAccent("blue"), "blue");
  assert.equal(parseAccent(" #2E7D4F "), "#2e7d4f");
  assert.equal(parseAccent("#fff"), "");
  assert.equal(parseAccent("red;}"), "");
  assert.equal(parseAccent("url(x)"), "");
  assert.equal(parseAccent(undefined), "");
});

test("強調色：預設的顏色在淺色、深色底都至少 3:1，按鈕上的字至少 4.5:1", () => {
  for (const a of ACCENTS) {
    assert.ok(contrast(a.light, "#ffffff") >= 3, a.id);
    assert.ok(contrast(a.dark, "#282c34") >= 3, a.id);
    const c = accentColors(a.id)!;
    assert.ok(contrast(c.light, c.lightText) >= 4.5, `${a.id} light ${contrast(c.light, c.lightText)}`);
    assert.ok(contrast(c.dark, c.darkText) >= 4.5, `${a.id} dark ${contrast(c.dark, c.darkText)}`);
  }
});

test("強調色：自訂的顏色太淺或太深時自動調整，按鈕上的字挑看得清楚的顏色", () => {
  const yellow = accentColors("#ffe14d")!;
  assert.ok(contrast(yellow.light, "#ffffff") >= 3);
  assert.ok(contrast(yellow.dark, "#1e2227") >= 3);
  assert.equal(textOn("#ffe14d"), "#16181d");
  const navy = accentColors("#0a1a4a")!;
  assert.equal(navy.light, "#0a1a4a");
  assert.ok(contrast(navy.dark, "#1e2227") >= 3);
  assert.equal(navy.lightText, "#ffffff");
});

test("強調色：寫進根元素的變數格式和 theme-init.js 檢查的一致", () => {
  assert.deepEqual(accentVars(""), {});
  for (const v of Object.values(accentVars("#ffe14d"))) assert.match(v, /^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
  assert.deepEqual(Object.keys(accentVars("teal")), ["--accent", "--accent-fg"]);
});
