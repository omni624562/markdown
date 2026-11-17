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

test("分頁很多：左邊顯示「‹ 幾個」，按一下只列出左邊藏著的分頁，點了切過去並捲到看得到；右邊同理", async () => {
  const { page, context, errors } = await open();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.locator(".cm-content").waitFor();
  for (let i = 0; i < 14; i++) {
    await page.locator(".cm-content").focus();
    await page.keyboard.insertText(`# 會議紀錄 ${i + 1}`);
    await page.keyboard.press("Control+Alt+N");
  }
  await page.waitForFunction(() => document.querySelectorAll("#tab-bar .tab").length >= 15);
  // 最後一個分頁是目前的：右邊沒有藏著的，左邊藏了好幾個。
  const left = page.locator("#tab-bar .tab-hidden-left");
  await left.waitFor();
  assert.equal(await page.locator("#tab-bar .tab-hidden-right").isVisible(), false);
  const hiddenLeft = await page.evaluate(() => {
    const box = document.querySelector("#tab-bar .tabs").getBoundingClientRect();
    return [...document.querySelectorAll("#tab-bar .tab")].filter((t) => {
      const r = t.getBoundingClientRect();
      return r.left + r.width / 2 < box.left;
    }).length;
  });
  assert.ok(hiddenLeft > 0);
  assert.equal(Number((await left.textContent()).trim()), hiddenLeft, "數字是左邊藏著的分頁數");
  await left.click();
  const menu = page.locator(".tab-more-menu:popover-open");
  await menu.waitFor();
  assert.equal(await menu.locator("button").count(), hiddenLeft, "只列出左邊藏著的");
  assert.match(await menu.locator("button").first().textContent(), /會議紀錄 1\b/);
  await menu.locator("button").first().click();
  // 切到第一個分頁：它捲進畫面；這時右邊藏著的分頁也會顯示數字。
  await page.waitForFunction(() => {
    const list = document.querySelector("#tab-bar .tabs");
    const sel = list.querySelector('.tab[aria-selected="true"]');
    const r = sel.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    return sel.textContent.includes("會議紀錄 1") && r.left >= box.left - 1 && r.right <= box.right + 1;
  });
  await page.locator("#tab-bar .tab-hidden-right").waitFor();
  assert.equal(await left.isVisible(), false, "左邊沒有藏著的了");
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
