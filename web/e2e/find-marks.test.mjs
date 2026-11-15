/**
 * 尋找列開著時，編輯區右邊的捲軸上用短線標出符合處（ui/find-marks.ts）：位置照符合處在文件裡的比例，
 * 目前選到的那一個用強調色；關掉尋找列、沒有符合處、內容不到一頁時不標。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

// 60 段，每 10 段有一個「地鐵」：符合處平均分布在整份文件。
const DOC = Array.from({ length: 60 }, (_, i) => (i % 10 === 0 ? `第 ${i} 段：搭地鐵。` : `第 ${i} 段的說明文字。`)).join("\n\n");

const marks = (page) =>
  page.evaluate(() => {
    const el = document.querySelector(".cm-editor .find-marks");
    if (!el || el.hidden) return null;
    const box = el.getBoundingClientRect();
    const scroller = document.querySelector(".cm-editor .cm-scroller").getBoundingClientRect();
    return {
      ys: [...el.children].map((i) => parseFloat(i.style.top) / box.height),
      current: [...el.children].findIndex((i) => i.classList.contains("current")),
      atRightEdge: Math.abs(box.right - scroller.right) <= 1,
      inside: box.top >= scroller.top - 1 && box.bottom <= scroller.bottom + 1,
      blocksMouse: getComputedStyle(el).pointerEvents !== "none",
    };
  });

test("尋找時捲軸上標出符合處：位置照比例，目前的那一個不同色，跟著上下跳；關掉尋找列就消失", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await page.setViewportSize({ width: 1000, height: 600 });
  await setText(page, DOC);
  await page.keyboard.press("Control+Home");
  assert.equal(await marks(page), null, "沒在尋找時不標");
  await page.keyboard.press("Control+F");
  const input = page.locator(".find-panel input").first();
  await input.fill("地鐵");
  await page.waitForFunction(() => document.querySelectorAll(".cm-editor .find-marks i").length === 6);
  let m = await marks(page);
  assert.equal(m.atRightEdge && m.inside, true, JSON.stringify(m));
  assert.equal(m.blocksMouse, false, "不擋捲軸的滑鼠操作");
  // 第 0、10、…、50 段：由上到下，大約在 0、1/6、…、5/6 的位置（還沒捲到的行高度是估的，留一點誤差）。
  m.ys.forEach((y, i) => assert.ok(Math.abs(y - i / 6) < 0.1 && (i === 0 || y > m.ys[i - 1]), `第 ${i} 條在 ${y}：${m.ys}`));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".cm-editor .find-marks i.current"));
  const first = (await marks(page)).current;
  await page.keyboard.press("Enter");
  await page.waitForFunction((prev) => [...document.querySelectorAll(".cm-editor .find-marks i")].findIndex((i) => i.classList.contains("current")) === prev + 1, first);
  // 沒有符合處：不標。
  await input.fill("沒有這個字");
  await page.waitForFunction(() => document.querySelector(".cm-editor .find-marks").hidden);
  await input.fill("地鐵");
  await page.waitForFunction(() => !document.querySelector(".cm-editor .find-marks").hidden);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".cm-editor .find-marks").hidden);
  assert.deepEqual(errors, []);
  await context.close();
});

test("內容不到一頁（沒有捲軸）時不標", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await setText(page, "搭地鐵。\n\n再搭地鐵。\n");
  await page.keyboard.press("Control+F");
  await page.locator(".find-panel input").first().fill("地鐵");
  await page.waitForFunction(() => /2/.test(document.querySelector(".find-panel")?.textContent ?? ""));
  await page.waitForTimeout(200);
  assert.equal(await marks(page), null);
  assert.deepEqual(errors, []);
  await context.close();
});
