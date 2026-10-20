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

test("AI 功能預設全部關閉", () => {
  assert.equal(DEFAULTS.aiEnabled, false);
  assert.ok(DEFAULTS.quickActions.length > 0);
});

test("快捷動作會去掉無效項目並限制長度", () => {
  const { settings, problems } = sanitize({
    aiTool: "codex",
    quickActions: [
      { name: " 精簡 ", prompt: "改短一點" },
      { name: "", prompt: "沒有名稱" },
      { name: "沒有提示詞" },
      "不是物件",
      { name: "長".repeat(100), prompt: "x" },
    ],
  });
  assert.equal(settings.aiTool, "codex");
  assert.deepEqual(settings.quickActions[0], { name: "精簡", prompt: "改短一點" });
  assert.equal(settings.quickActions.length, 2);
  assert.equal(settings.quickActions[1].name.length, 40);
  assert.equal(problems, 1);
});

test("不認得的 AI 工具退回預設值", () => {
  const { settings, problems } = sanitize({ aiTool: "gpt" });
  assert.equal(settings.aiTool, "claude");
  assert.equal(problems, 1);
});
