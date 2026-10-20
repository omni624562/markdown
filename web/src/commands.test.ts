import assert from "node:assert/strict";
import { test } from "node:test";
import { formatKeys, fuzzyScore, matchKeys } from "./commands.ts";

const ev = (code: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey", boolean>> = {}, key = "") => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

test("formatKeys 依平台顯示", () => {
  assert.equal(formatKeys("Mod-Shift-p", true), "⌘⇧P");
  assert.equal(formatKeys("Mod-Shift-p", false), "Ctrl+Shift+P");
  assert.equal(formatKeys("Mod-Alt-1", false), "Ctrl+Alt+1");
});

test("matchKeys 比對實體按鍵與修飾鍵", () => {
  assert.ok(matchKeys("Mod-b", ev("KeyB", { ctrlKey: true }), false));
  assert.ok(matchKeys("Mod-b", ev("KeyB", { metaKey: true }), true));
  assert.ok(!matchKeys("Mod-b", ev("KeyB", { ctrlKey: true, shiftKey: true }), false));
  // macOS 的 Option+1 會產生「¡」，仍應比對成功
  assert.ok(matchKeys("Mod-Alt-1", ev("Digit1", { metaKey: true, altKey: true }, "¡"), true));
  assert.ok(matchKeys("F1", ev("F1", {}, "F1"), false));
});

test("= 與 - 鍵用名稱表示，也接受數字鍵盤", () => {
  assert.equal(formatKeys("Mod-Equal", false), "Ctrl+=");
  assert.equal(formatKeys("Mod-Minus", true), "⌘-");
  assert.ok(matchKeys("Mod-Equal", ev("Equal", { ctrlKey: true }, "="), false));
  assert.ok(matchKeys("Mod-Equal", ev("NumpadAdd", { ctrlKey: true }, "+"), false));
  assert.ok(matchKeys("Mod-Minus", ev("Minus", { ctrlKey: true }, "-"), false));
  assert.ok(!matchKeys("Mod-Minus", ev("Equal", { ctrlKey: true }, "="), false));
});

test("fuzzyScore 支援連續與跳躍比對", () => {
  assert.ok(fuzzyScore("匯出", "匯出 HTML") > fuzzyScore("匯H", "匯出 HTML"));
  assert.ok(fuzzyScore("json", "格式化 JSON") > 0);
  assert.equal(fuzzyScore("xyz", "儲存"), 0);
  assert.equal(fuzzyScore("", "任何"), 1);
});
