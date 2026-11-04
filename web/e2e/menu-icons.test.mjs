/**
 * 選單裡連續幾項用同一個圖示時只畫第一個（例如分頁右鍵選單的「關閉分頁」「關閉其他分頁」「關閉所有分頁」
 * 只有第一項有 ×），後面的留一樣寬的空白，文字照樣對齊；分隔線之後的圖示照常顯示。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

test("分頁右鍵選單：關閉那幾項只有第一項有 ×，文字對齊；分隔線後面的圖示照常", async () => {
  const { page, context, errors } = await open();
  await page.click(".cm-content");
  await page.keyboard.insertText("第一份");
  await page.click("#tab-bar .tab-new");
  await page.keyboard.insertText("第二份");
  await page.locator("#tab-bar .tab").first().click({ button: "right" });
  const menu = page.locator(".menu:popover-open");
  await menu.locator("[role=menuitem]", { hasText: "關閉其他分頁" }).waitFor();
  const rows = await menu.locator(":scope > button").evaluateAll((bs) =>
    bs.map((b) => ({
      label: b.querySelector("span:not(.menu-icon-blank)").textContent,
      icon: b.firstElementChild.tagName.toLowerCase() === "svg" ? b.firstElementChild.dataset.icon : b.firstElementChild.classList.contains("menu-icon-blank") ? "blank" : null,
      textLeft: Math.round(b.querySelector("span:not(.menu-icon-blank)").getBoundingClientRect().left),
    })),
  );
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(byLabel["關閉分頁"].icon, "x", "第一項有 ×");
  assert.equal(byLabel["關閉其他分頁"].icon, "blank", "後面同樣是關閉的不再畫 ×");
  assert.equal(byLabel["關閉所有分頁"].icon, "blank");
  assert.equal(byLabel["釘選分頁"].icon, "pin", "分隔線後面的圖示照常");
  assert.equal(new Set(rows.map((r) => r.textLeft)).size, 1, `每一項的文字左邊切齊：${JSON.stringify(rows)}`);
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  await context.close();
});
