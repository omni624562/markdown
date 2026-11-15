/**
 * 「預覽」模式的尋找（app/preview-find.ts）：Ctrl+F 在預覽上方打開尋找列（不是瀏覽器內建的那個），
 * 只找預覽的內容、標出符合的地方，Enter／Shift+Enter 跳下一個、上一個，Esc 關閉；預覽重畫後重新找。
 * 其他模式的 Ctrl+F 照舊是編輯器的「尋找與取代」。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

const filler = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段的說明文字。`).join("\n\n");
const DOC = `# 行程\n\n第一天搭地鐵到海雲台。\n\n${filler}\n\n## 交通\n\n地鐵一號線轉公車，地鐵站有置物櫃。\n\n<details><summary>備註</summary>\n\n收合起來的地鐵票價。\n\n</details>\n`;

const state = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector(".preview-find");
    const all = CSS.highlights.get("issue-find");
    const cur = CSS.highlights.get("issue-find-current");
    const range = cur ? [...cur][0] : null;
    const box = range?.getBoundingClientRect();
    const view = document.querySelector("#preview-scroller").getBoundingClientRect();
    return {
      open: !!bar && !bar.hidden,
      count: bar?.querySelector(".issue-find-count").textContent ?? "",
      marks: all ? all.size : 0,
      current: range ? range.startContainer.parentElement.closest("p, h1, h2, summary")?.textContent : null,
      visible: box ? box.top >= bar.getBoundingClientRect().bottom && box.bottom <= view.bottom : null,
      focusInBar: !!bar?.contains(document.activeElement),
    };
  });

test("預覽模式按 Ctrl+F：預覽上方出現尋找列，標出符合處，Enter 往下、Shift+Enter 往上，會捲到看得到的地方，Esc 關閉", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await setText(page, DOC);
  await page.click('.statusbar [data-view="preview"]');
  await page.locator("#preview h2").waitFor();
  await page.keyboard.press("Control+F");
  const input = page.locator(".preview-find input");
  await input.waitFor();
  assert.equal(await page.locator(".cm-search, .find-panel").count(), 0, "不是編輯器的尋找與取代");
  await input.fill("地鐵");
  let s = await state(page);
  assert.deepEqual([s.count, s.marks, s.current], ["1／4", 4, "第一天搭地鐵到海雲台。"]);
  // 找不分大小寫；只找預覽的內容（檔案樹、大綱裡的字不算）。
  await page.keyboard.press("Enter");
  s = await state(page);
  assert.equal(s.count, "2／4");
  assert.equal(s.current, "地鐵一號線轉公車，地鐵站有置物櫃。");
  assert.equal(s.visible, true, "捲到看得到的地方，沒有被尋找列蓋住");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  s = await state(page);
  assert.equal(s.count, "4／4");
  assert.equal(await page.locator("#preview details").evaluate((d) => d.open), true, "符合處在收合的區塊裡：展開");
  assert.equal(s.visible, true);
  await page.keyboard.press("Enter");
  assert.equal((await state(page)).count, "1／4", "最後一個再往下回到第一個");
  await page.keyboard.press("Shift+Enter");
  assert.equal((await state(page)).count, "4／4");
  await input.fill("沒有這個字");
  s = await state(page);
  assert.deepEqual([s.count, s.marks], ["沒有結果", 0]);
  await page.keyboard.press("Escape");
  s = await state(page);
  assert.deepEqual([s.open, s.marks, s.focusInBar], [false, 0, false]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("預覽重畫後重新找（留在原來的第幾個）；其他模式的 Ctrl+F 照舊是編輯器的尋找與取代", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await setText(page, "# 筆記\n\n蘋果一。\n\n蘋果二。\n\n蘋果三。\n");
  await page.click('.statusbar [data-view="preview"]');
  await page.locator("#preview h1").waitFor();
  await page.keyboard.press("Control+F");
  await page.locator(".preview-find input").fill("蘋果");
  await page.keyboard.press("Enter");
  assert.equal((await state(page)).count, "2／3");
  // 文件改了（這裡直接改編輯器的內容，像外部修改或復原）：預覽重畫，符合處重新算。
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const tile = content?.cmView ?? content?.cmTile;
    const view = tile?.view ?? tile?.root?.view;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n蘋果四。\n" } });
  });
  await page.waitForFunction(() => document.querySelector(".preview-find .issue-find-count").textContent === "2／4");
  assert.equal((await state(page)).marks, 4);
  await page.keyboard.press("Escape");

  await page.click('.statusbar [data-view="live"]');
  await page.click(".cm-content", { position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+F");
  await page.locator(".cm-panels .find-panel").waitFor();
  assert.equal((await state(page)).open, false);
  assert.deepEqual(errors, []);
  await context.close();
});
