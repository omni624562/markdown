/**
 * main.ts 只放「目前分頁」的狀態、編輯器與預覽、分頁、存檔、版面；新功能放在 app/ 底下各自的檔案
 * （見 CLAUDE.md）。這裡守住 main.ts 的大小，免得又長回九千多行。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** main.ts 行數的上限。拆出功能、變小之後可以往下調，不要往上加。 */
const MAX_LINES = 2860;

test("main.ts 不超過行數上限（新功能放在 app/）", () => {
  const lines = readFileSync(new URL("./main.ts", import.meta.url), "utf8").split("\n").length;
  assert.ok(lines <= MAX_LINES, `main.ts 有 ${lines} 行，超過上限 ${MAX_LINES}：新功能請放在 web/src/app/ 底下的模組`);
});
