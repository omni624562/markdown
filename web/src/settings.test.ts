import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, sanitize } from "./settings.ts";

test("缺少的欄位使用預設值", () => {
  const { settings, problems } = sanitize({ math: false });
  assert.equal(settings.math, false);
  assert.equal(settings.editorFontSize, DEFAULTS.editorFontSize);
  assert.equal(problems, 0);
});

test("型別錯誤或超出範圍的欄位會被修正並計入問題", () => {
  const { settings, problems } = sanitize({ editorFontSize: 99, lineNumbers: "yes", previewWidth: "huge" });
  assert.equal(settings.editorFontSize, 24);
  assert.equal(settings.lineNumbers, DEFAULTS.lineNumbers);
  assert.equal(settings.previewWidth, DEFAULTS.previewWidth);
  assert.equal(problems, 2);
});

test("不是物件時整份退回預設值", () => {
  assert.deepEqual(sanitize(null).settings, DEFAULTS);
  assert.equal(sanitize("壞掉").problems, 1);
});
