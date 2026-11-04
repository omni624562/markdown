/**
 * 分頁樣式（設定 → 版面 → 分頁樣式）：頂端一條線（原本）、卡片、底線。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand, setText } from "./helpers.mjs";

/** 目前分頁的樣子：上方留白、圓角、外框、陰影（線）。 */
const look = (page) =>
  page.evaluate(() => {
    const tab = document.querySelector('.tab[aria-selected="true"]');
    const s = getComputedStyle(tab);
    return {
      gap: getComputedStyle(tab.closest(".tab-bar")).paddingTop,
      radius: s.borderTopLeftRadius,
      border: s.borderTopColor !== "rgba(0, 0, 0, 0)" && s.borderTopWidth !== "0px",
      shadow: s.boxShadow,
    };
  });

async function pick(page, value) {
  await runCommand(page, "設定");
  await page.click("dialog[open] [role=tab]:has-text('版面')");
  await page.locator("dialog[open]").getByLabel("分頁樣式").selectOption(value);
  await page.waitForFunction((v) => document.documentElement.dataset.tabStyle === v, value);
  await page.keyboard.press("Escape");
}

test("分頁樣式：原本頂端一條線；卡片離頂端 5px、圓角外框、沒有線；底線在下緣", async () => {
  const { page, context, errors } = await open();
  await setText(page, "# 標題");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.tabStyle), "line");
  const line = await look(page);
  assert.equal(line.gap, "0px");
  assert.match(line.shadow, / 0px 3px 0px 0px inset/);

  await pick(page, "card");
  const card = await look(page);
  assert.deepEqual([card.gap, card.radius, card.border, card.shadow], ["5px", "8px", true, "none"]);

  await pick(page, "underline");
  const under = await look(page);
  assert.equal(under.gap, "0px");
  assert.match(under.shadow, / 0px -2px 0px 0px inset/);
  assert.deepEqual(errors, []);
  await context.close();
});
