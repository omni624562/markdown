/**
 * 即時預覽（編輯區）拖動段落調整順序（app/live-drag.ts）：滑鼠移到段落、標題、清單項目上，左邊出現把手，
 * 拖到別的位置放開就搬過去，規則和預覽一樣；原始碼模式沒有把手。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const DOC = [
  "# 五天四夜",
  "",
  "前言。",
  "",
  "## 第一天",
  "",
  "- 早上：搭地鐵",
  "- 中午：吃海鮮麵",
  "- 晚上：逛夜市",
  "",
  "## 第二天",
  "",
  "看海。",
  "",
  "## 第三天",
  "",
  "回家。",
  "",
].join("\n");

async function setup(view = "live") {
  const opened = await open();
  const { page } = opened;
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText(DOC);
  await page.click(`.statusbar [data-view="${view}"]`);
  await page.waitForTimeout(300);
  // 游標移到文件最後的空白行，標題等不會因為游標在上面而顯示原始的 Markdown。
  await page.keyboard.press("Control+End");
  return opened;
}

const text = (page) => page.evaluate(() => [...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n"));
const line = (page, s) => page.locator(".cm-line", { hasText: s }).first();

async function dragBlock(page, from, to, after = false) {
  const src = await line(page, from).boundingBox();
  await page.mouse.move(src.x + 80, src.y + src.height / 2);
  const handle = page.locator(".live-drag-handle:not([hidden])");
  await handle.waitFor({ timeout: 5000 });
  const h = await handle.boundingBox();
  const dst = await line(page, to).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 5, h.y + 10, { steps: 3 });
  await page.mouse.move(dst.x + 80, after ? dst.y + dst.height - 2 : dst.y + 2, { steps: 10 });
  await page.mouse.up();
}

test("即時預覽：拖標題整節搬到別的標題前面；通知上的「復原」還原", async () => {
  const { page, context, errors } = await setup();
  await dragBlock(page, "第三天", "第一天");
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n");
    return t.indexOf("第三天") < t.indexOf("第一天");
  });
  assert.match(await text(page), /第三天\n\n回家。\n\n(## )?第一天/);
  await page.locator(".toast button", { hasText: "復原" }).click();
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n");
    return t.indexOf("第一天") < t.indexOf("第三天");
  });
  assert.deepEqual(errors, []);
  await context.close();
});

test("即時預覽：拖清單項目調整順序；拖段落到最後", async () => {
  const { page, context, errors } = await setup();
  await dragBlock(page, "晚上", "早上");
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n");
    return t.indexOf("晚上") < t.indexOf("早上");
  });
  assert.match(await text(page), /晚上：逛夜市\n.*早上：搭地鐵\n.*中午：吃海鮮麵/);
  await dragBlock(page, "前言", "回家", true);
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n");
    return t.indexOf("回家") < t.indexOf("前言");
  });
  assert.match(await text(page), /回家。\n\n前言。/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("原始碼模式沒有把手（照舊用選取文字拖曳）", async () => {
  const { page, context, errors } = await setup("editor");
  const src = await line(page, "前言").boundingBox();
  await page.mouse.move(src.x + 80, src.y + src.height / 2);
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".live-drag-handle:not([hidden])").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
