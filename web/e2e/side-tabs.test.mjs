/**
 * 並排時的分頁：
 * - 兩份文件並排時，兩個分頁合成一張「左｜右」的分頁（中間一條細線，游標所在的那一半下面一條強調色的線）：
 *   游標所在的那一半是目前的分頁，點另一半就換過去；
 *   最右邊的 × 取消並排（兩份文件留在分頁裡）。
 * - 拖曳分頁到編輯區的右半邊：出現「放開：在右邊並排開啟」的虛線框，放開就把那份文件開在右邊。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand, setText } from "./helpers.mjs";

/** 分頁列：每一項是分頁的名稱，並排的那一組包成陣列。 */
const tabs = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#tab-bar .tabs > *")].map((el) =>
      el.classList.contains("tab-pair") ? [...el.querySelectorAll(".tab .tab-name")].map((n) => n.textContent) : el.querySelector(".tab-name")?.textContent,
    ),
  );
const selected = (page) => page.locator("#tab-bar .tab[aria-selected=true] .tab-name").textContent();

async function twoDocs(page) {
  await setText(page, "# 週報");
  await runCommand(page, "新增文件");
  await setText(page, "# 需求說明");
}

test("並排：兩個分頁合成一個「左｜右」的分頁；點半邊換過去；× 取消並排", async () => {
  const { page, context, errors } = await open();
  await twoDocs(page);
  await runCommand(page, "把目前的文件移到右邊");
  await page.waitForSelector("#side-pane-head:not([hidden])");
  const list = await tabs(page);
  const pair = list.find(Array.isArray);
  assert.ok(pair, `有合成的分頁：${JSON.stringify(list)}`);
  assert.equal(pair.length, 2);
  assert.match(pair[0], /週報/, "左半是左邊的文件");
  assert.match(pair[1], /需求說明/, "右半是右邊的文件");
  assert.match(await selected(page), /需求說明/, "游標在右邊：右半是目前的分頁");
  assert.equal(list.length, 1, "沒有另外重複的分頁");

  // 看起來是一張分頁：中間一條細線（沒有並排圖示）；整組是一張和內文同色的卡片；
  // 游標所在的那一半下緣一條強調色的線，另一半沒有。
  const look = () =>
    page.evaluate(() => {
      const pair = document.querySelector("#tab-bar .tab-pair");
      const underline = (el) => getComputedStyle(el, "::after").display !== "none" && getComputedStyle(el, "::after").height === "2px";
      return {
        icon: !!pair.querySelector(".tab-pair-icon"),
        sep: !!pair.querySelector(":scope > .tab-pair-sep"),
        // 整組的底色和內文一樣（不是淡淡的強調色）。
        card: getComputedStyle(pair).backgroundColor === getComputedStyle(document.querySelector(".editor-pane")).backgroundColor,
        lines: [...pair.querySelectorAll(":scope > .tab")].map(underline),
      };
    });
  assert.deepEqual(await look(), { icon: false, sep: true, card: true, lines: [false, true] });

  // 點左半：游標換到左邊。
  await page.locator("#tab-bar .tab-pair .tab").first().click();
  await page.waitForFunction(() => document.querySelector("#main-pane-head")?.classList.contains("focused"));
  assert.match(await selected(page), /週報/);
  assert.deepEqual((await look()).lines, [true, false], "線移到左半");

  // × 取消並排：兩份文件留在分頁裡。
  await page.locator("#tab-bar .tab-pair-close").click();
  await page.waitForSelector("#side-pane-head", { state: "hidden" });
  assert.equal(await page.locator("#tab-bar .tab-pair").count(), 0);
  assert.equal((await tabs(page)).length, 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test("拖曳分頁到編輯區的右半邊：出現虛線框，放開就在右邊並排開啟", async () => {
  const { page, context, errors } = await open();
  await twoDocs(page);
  // 目前是「需求說明」；把「週報」的分頁拖到編輯區的右半邊。
  const tab = page.locator("#tab-bar .tab", { hasText: "週報" });
  // 分頁列會重畫（文件名稱稍後才依標題換好）：等名稱穩定、分頁在畫面上再量位置。
  await page.waitForFunction(() => [...document.querySelectorAll("#tab-bar .tab-name")].some((n) => n.textContent === "需求說明"));
  await tab.waitFor();
  const from = await tab.boundingBox();
  const pane = await page.locator(".editor-pane").boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // 先到左半邊：沒有虛線框。
  await page.mouse.move(pane.x + pane.width * 0.25, pane.y + pane.height / 2, { steps: 8 });
  assert.equal(await page.locator(".side-drop").isVisible(), false, "左半邊不能放");
  await page.mouse.move(pane.x + pane.width * 0.75, pane.y + pane.height / 2, { steps: 8 });
  await page.locator(".side-drop").waitFor();
  assert.match(await page.locator(".side-drop").textContent(), /放開：在右邊並排開啟/);
  await page.mouse.up();
  await page.waitForSelector("#side-pane-head:not([hidden])");
  assert.equal(await page.locator(".side-drop").isVisible(), false, "放開後虛線框消失");
  assert.match(await page.locator("#side-pane-head .pane-head-name").textContent(), /週報/, "週報開在右邊");
  assert.match(await page.locator("#main-pane-head .pane-head-name").textContent(), /需求說明/);
  const pair = (await tabs(page)).find(Array.isArray);
  assert.ok(pair && /需求說明/.test(pair[0]) && /週報/.test(pair[1]), JSON.stringify(pair));
  assert.deepEqual(errors, []);
  await context.close();
});
