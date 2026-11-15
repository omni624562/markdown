import assert from "node:assert/strict";
import { test } from "node:test";
import { isTypingKey } from "./typing-key.ts";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  ...mods,
});

test("打字、刪除、輸入法組字算是想編輯", () => {
  for (const k of ["a", "Z", "1", "，", "字", "Backspace", "Delete", "Process"]) assert.equal(isTypingKey(key(k)), true, k);
  assert.equal(isTypingKey(key("Unidentified", { isComposing: true })), true);
});

test("快速鍵、捲動與功能鍵不算", () => {
  for (const k of [" ", "Enter", "Tab", "Escape", "ArrowDown", "PageDown", "Home", "F5", "Shift", "Control"]) assert.equal(isTypingKey(key(k)), false, k);
  assert.equal(isTypingKey(key("f", { ctrlKey: true })), false);
  assert.equal(isTypingKey(key("p", { metaKey: true })), false);
  assert.equal(isTypingKey(key("x", { altKey: true })), false);
});
