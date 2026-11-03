/**
 * 頂端列（Windows 桌面版兼當標題列）：裡面不畫直線（分隔線只在下面的面板之間），
 * 左右兩個側邊欄按鈕開著時同一種樣子（圖示顏色深一點，沒有底色）。用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

test("頂端列裡沒有直線；左右兩個側邊欄按鈕開著時一樣（沒有底色、顏色相同）", async () => {
  const { page, context, errors } = await open({
    desktop: { custom_title_bar: true, window_control: false, load_settings: JSON.stringify({ outlineRight: true }) },
  });
  await page.setViewportSize({ width: 1500, height: 600 });
  await page.click(".nav-toggle");
  await page.locator('.nav-toggle[aria-pressed="true"]').waitFor();
  const right = page.locator('.top-actions [data-command="toggle-outline-right"]');
  await right.waitFor();
  assert.equal(await right.getAttribute("aria-pressed"), "true");
  await page.mouse.move(800, 500);
  // 滑鼠離開後的底色有淡出動畫，等它結束。
  await page.waitForTimeout(400);
  const look = await page.evaluate(() => {
    const css = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      toggleLine: css(".nav-toggle").borderRightWidth,
      sideLine: css(".topbar-side").borderRightWidth,
      sideShown: css(".topbar-side").display,
      leftColor: css(".nav-toggle").color,
      leftBg: css(".nav-toggle .icon").backgroundColor,
      rightColor: css('.top-actions [data-command="toggle-outline-right"]').color,
      rightBg: css('.top-actions [data-command="toggle-outline-right"]').backgroundColor,
    };
  });
  assert.equal(look.sideShown, "block", "側邊欄開著時，分頁從內文的左邊開始");
  assert.deepEqual([look.toggleLine, look.sideLine], ["0px", "0px"], "頂端列裡沒有直線");
  assert.equal(look.rightBg, "rgba(0, 0, 0, 0)", "右邊的按鈕開著時沒有底色");
  assert.equal(look.leftBg, "rgba(0, 0, 0, 0)");
  assert.equal(look.rightColor, look.leftColor, "左右兩個按鈕開著時顏色一樣");
  assert.deepEqual(errors, []);
  await context.close();
});
