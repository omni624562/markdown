/**
 * 文件分頁很多時：每個分頁最窄 140px（名稱看得出是哪一份），放不下就左右捲動，
 * 目前的分頁一定捲到看得到的地方，「所有分頁」按鈕出現並列出全部的分頁。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

test("分頁很多：每個最窄 140px，放不下時左右捲動，目前的分頁看得到，「所有分頁」列出全部", async () => {
  const { page, context, errors } = await open();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.locator(".cm-content").waitFor();
  // 空白的分頁會被新文件取代，所以每一份先打一點內容。
  for (let i = 0; i < 14; i++) {
    await page.locator(".cm-content").focus();
    await page.keyboard.insertText(`# 會議紀錄 ${i + 1}`);
    await page.keyboard.press("Control+Alt+N");
  }
  await page.waitForFunction(() => document.querySelectorAll("#tab-bar .tab").length >= 15);
  const info = await page.evaluate(() => {
    const list = document.querySelector("#tab-bar .tabs");
    const tabs = [...list.querySelectorAll(".tab")];
    const sel = list.querySelector('.tab[aria-selected="true"]').getBoundingClientRect();
    const box = list.getBoundingClientRect();
    return {
      minWidth: Math.min(...tabs.map((t) => t.getBoundingClientRect().width)),
      count: tabs.length,
      scrolls: list.scrollWidth > list.clientWidth,
      selectedVisible: sel.left >= box.left - 1 && sel.right <= box.right + 1,
      moreShown: !document.querySelector("#tab-bar .tab-more").hidden,
    };
  });
  assert.ok(info.minWidth >= 140, `最窄的分頁 ${info.minWidth}px`);
  assert.equal(info.scrolls, true, "放不下時可以左右捲動");
  assert.equal(info.selectedVisible, true, "目前的分頁捲到看得到的地方");
  assert.equal(info.moreShown, true, "「所有分頁」按鈕出現");
  await page.locator("#tab-bar .tab-more").click();
  await page.locator(".tab-more-menu:popover-open").waitFor();
  assert.equal(await page.locator(".tab-more-menu:popover-open button").count(), info.count);
  assert.deepEqual(errors, []);
  await context.close();
});

test("分頁很多：兩端出現「‹」「›」，按一下捲一個分頁，捲到底的那一邊變灰", async () => {
  const { page, context, errors } = await open();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.locator(".cm-content").waitFor();
  for (let i = 0; i < 14; i++) {
    await page.locator(".cm-content").focus();
    await page.keyboard.insertText(`# 會議紀錄 ${i + 1}`);
    await page.keyboard.press("Control+Alt+N");
  }
  await page.waitForFunction(() => document.querySelectorAll("#tab-bar .tab").length >= 15);
  const left = page.locator("#tab-bar .tab-scroll-left");
  const right = page.locator("#tab-bar .tab-scroll-right");
  await left.waitFor();
  // 目前的分頁在最後面：右邊已經到底（灰色），左邊可以按。
  assert.equal(await right.isDisabled(), true);
  assert.equal(await left.isDisabled(), false);
  const scroll = () => page.evaluate(() => document.querySelector("#tab-bar .tabs").scrollLeft);
  const before = await scroll();
  await left.click();
  await page.waitForFunction((b) => document.querySelector("#tab-bar .tabs").scrollLeft < b, before);
  // 捲了大約一個分頁（不是一口氣捲到底）。
  const moved = before - (await scroll());
  assert.ok(moved > 50 && moved < 300, `捲了 ${moved}px`);
  // 最左邊那個看得到的分頁是完整的。
  assert.equal(
    await page.evaluate(() => {
      const box = document.querySelector("#tab-bar .tabs").getBoundingClientRect();
      const first = [...document.querySelectorAll("#tab-bar .tab")].find((t) => t.getBoundingClientRect().right > box.left + 1);
      return first.getBoundingClientRect().left >= box.left - 1;
    }),
    true,
  );
  assert.equal(await right.isDisabled(), false, "往左捲之後右邊可以按");
  // 一直按到最左邊：左邊變灰。
  for (let i = 0; i < 20 && !(await left.isDisabled()); i++) await left.click();
  assert.equal(await scroll(), 0);
  assert.equal(await left.isDisabled(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("分頁很多：滑鼠滾輪捲得到最前面與最後面，重畫分頁列（例如打字）也不會被拉回目前的分頁", async () => {
  const { page, context, errors } = await open();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.locator(".cm-content").waitFor();
  for (let i = 0; i < 14; i++) {
    await page.locator(".cm-content").focus();
    await page.keyboard.insertText(`# 會議紀錄 ${i + 1}`);
    await page.keyboard.press("Control+Alt+N");
  }
  await page.waitForFunction(() => document.querySelectorAll("#tab-bar .tab").length >= 15);
  const scroll = () => page.evaluate(() => {
    const l = document.querySelector("#tab-bar .tabs");
    return { left: l.scrollLeft, max: l.scrollWidth - l.clientWidth };
  });
  const box = await page.locator("#tab-bar .tabs").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -100);
  await page.waitForFunction(() => document.querySelector("#tab-bar .tabs").scrollLeft === 0);
  // 在目前的文件打字：分頁列重畫（未存檔的圓點），捲動位置不變。
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("內容");
  await page.waitForTimeout(300);
  assert.equal((await scroll()).left, 0, "還在最前面");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 100);
  await page.waitForFunction(() => {
    const l = document.querySelector("#tab-bar .tabs");
    return l.scrollLeft >= l.scrollWidth - l.clientWidth - 1;
  });
  assert.deepEqual(errors, []);
  await context.close();
});

test("拖曳分頁改順序：放到另一個分頁的左半邊就排到它前面，重新整理後順序還在", async () => {
  const { page, context, errors } = await open();
  await page.locator(".cm-content").waitFor();
  for (const name of ["甲", "乙", "丙"]) {
    await page.locator(".cm-content").focus();
    await page.keyboard.insertText(`# ${name}`);
    if (name !== "丙") await page.keyboard.press("Control+Alt+N");
  }
  const names = () => page.$$eval("#tab-bar .tab .tab-name", (l) => l.map((n) => n.textContent.trim()));
  // 還沒存檔的文件用第一行當分頁名稱（打字後一下子才換）。
  await page.waitForFunction(() => [...document.querySelectorAll("#tab-bar .tab .tab-name")].map((n) => n.textContent.trim()).join() === "甲,乙,丙");
  const first = page.locator("#tab-bar .tab").first();
  const box = await first.boundingBox();
  await page.locator("#tab-bar .tab", { hasText: "丙" }).dragTo(first, { targetPosition: { x: 8, y: box.height / 2 } });
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab .tab-name")?.textContent.trim() === "丙");
  assert.deepEqual(await names(), ["丙", "甲", "乙"]);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#tab-bar .tab").length === 3);
  assert.deepEqual(await names(), ["丙", "甲", "乙"], "重新整理後順序還在");
  assert.deepEqual(errors, []);
  await context.close();
});
