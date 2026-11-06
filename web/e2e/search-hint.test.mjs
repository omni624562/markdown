/**
 * 搜尋圖示的提示：桌面版附上 Ctrl+Shift+F；網頁版不能在資料夾中搜尋，快速鍵沒有作用，不寫。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const hint = (page) => page.evaluate(() => {
  const el = document.querySelector("#side-tab-search");
  return `${el.title} ${el.getAttribute("aria-label") ?? ""}`;
});

test("搜尋圖示的提示：網頁版不寫 Ctrl+Shift+F，桌面版有", async () => {
  const web = await open();
  await web.page.waitForSelector("#side-tab-search");
  assert.doesNotMatch(await hint(web.page), /Ctrl\+Shift\+F/);
  assert.deepEqual(web.errors, []);
  await web.context.close();
  const app = await open({ desktop: {} });
  await app.page.waitForSelector("#side-tab-search");
  assert.match(await hint(app.page), /Ctrl\+Shift\+F/);
  assert.deepEqual(app.errors, []);
  await app.context.close();
});
