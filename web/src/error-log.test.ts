import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ERROR_LOG_LIMIT, clearErrorLog, errorEntries, errorLogText, isNoise, logError, onError } from "./error-log.ts";

beforeEach(() => clearErrorLog());

test("記下錯誤：位置、訊息、呼叫堆疊；通知聽的人", () => {
  const seen: string[] = [];
  const off = onError((e) => seen.push(e.message));
  const e = logError("工作項目畫面", new Error("讀不到欄位"), 0);
  off();
  assert.equal(e.where, "工作項目畫面");
  assert.equal(e.message, "讀不到欄位");
  assert.ok(e.stack?.includes("讀不到欄位"));
  assert.deepEqual(seen, ["讀不到欄位"]);
  assert.equal(logError("x", "文字錯誤").message, "文字錯誤");
  assert.equal(logError("x", { code: 1 }).message, '{"code":1}');
});

test("最多記 50 筆，太舊的先丟掉", () => {
  for (let i = 0; i < ERROR_LOG_LIMIT + 5; i++) logError("x", `第 ${i} 個`);
  assert.equal(errorEntries().length, ERROR_LOG_LIMIT);
  assert.equal(errorEntries()[0].message, "第 5 個");
});

test("整理成文字：開頭資訊、時間、位置、訊息與前幾行堆疊", () => {
  logError("預覽：chips", new Error("壞了"), Date.UTC(2026, 10, 2, 3, 4, 5));
  const text = errorLogText(["oMarker 1.96.0"]);
  const lines = text.split("\n");
  assert.equal(lines[0], "oMarker 1.96.0");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "[2026-11-02T03:04:05.000Z] 預覽：chips: 壞了");
  assert.ok(lines.length > 3, "附上堆疊");
});

test("雜訊不提示", () => {
  assert.ok(isNoise(new DOMException("aborted", "AbortError")));
  assert.ok(isNoise(new Error("ResizeObserver loop completed with undelivered notifications.")));
  assert.ok(!isNoise(new Error("讀不到欄位")));
});
