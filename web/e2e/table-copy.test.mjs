/**
 * 複製整個表格：即時預覽的表格工具列「複製」、分割與原始碼模式的右鍵選單「表格」→「複製整個表格」。
 * 剪貼簿同時有格式文字（HTML 表格，貼到 Word、Outlook、Teams 是表格）與 Markdown 純文字；
 * 正在編輯、還沒存回文件的儲存格也一起複製。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const TABLE = "| 項目 | 負責人 |\n| --- | --- |\n| 登入頁 | 王小明 |\n| 報表 | 李大同 |";
const DOC = `# 工作分配\n\n${TABLE}\n\n備註。\n`;
const COPY = "複製整個表格（貼到 Word、Outlook、Teams 是表格）";

/** 測試用的網址不是安全來源，沒有 navigator.clipboard 與 ClipboardItem：換成記在 window.__clip 的假剪貼簿。 */
const fakeClipboard = (page) =>
  page.evaluate(() => {
    window.ClipboardItem = class {
      constructor(items) {
        this.items = items;
      }
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (list) => {
          const out = {};
          for (const item of list) for (const [type, blob] of Object.entries(item.items)) out[type] = await blob.text();
          window.__clip = out;
        },
      },
    });
  });
const clip = async (page) => {
  await page.waitForFunction(() => window.__clip);
  return page.evaluate(() => window.__clip);
};
const docText = (page) =>
  page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const tile = content?.cmView ?? content?.cmTile;
    return (tile?.view ?? tile?.root?.view).state.doc.toString();
  });

/** 即時預覽：寫入文件，游標移到表格外面讓表格畫出來。 */
async function livePreview(page) {
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText(DOC);
  await page.keyboard.press("Control+End");
  await page.locator(".cm-content .cm-lp-table").waitFor();
  await fakeClipboard(page);
}

test("即時預覽：表格工具列的「複製」放入 HTML 表格與 Markdown，文件不變", async () => {
  const { page, context, errors } = await open();
  await livePreview(page);
  const table = page.locator(".cm-lp-table");
  await table.hover();
  await table.getByRole("button", { name: COPY }).click();
  const data = await clip(page);
  assert.equal(data["text/plain"], TABLE);
  assert.match(data["text/html"], /<table/);
  assert.match(data["text/html"], /<td[^>]*border:1px solid[^>]*>王小明<\/td>/);
  await page.locator(".toast", { hasText: "已複製表格" }).waitFor();
  assert.equal(await docText(page), DOC);
  assert.deepEqual(errors, []);
  await context.close();
});

test("正在編輯儲存格時按「複製」：還沒存回文件的內容也一起複製", async () => {
  const { page, context, errors } = await open();
  await livePreview(page);
  await page.locator(".cm-lp-table td", { hasText: "報表" }).click();
  await page.locator(".cm-lp-cell-editing").waitFor();
  await page.keyboard.type("（月）");
  await page.locator(".cm-lp-table").getByRole("button", { name: COPY }).click();
  const data = await clip(page);
  assert.match(data["text/plain"], /\| 報表（月） +\| 李大同 \|/);
  assert.match(data["text/html"], /報表（月）/);
  // 還在編輯同一格
  assert.equal(await page.locator(".cm-lp-cell-editing").textContent(), "報表（月）");
  assert.deepEqual(errors, []);
  await context.close();
});

test("分割模式：右鍵選單「表格」→「複製整個表格」", async () => {
  const { page, context, errors } = await open();
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText(DOC);
  await page.locator(".view-switch button", { hasText: "分割" }).click();
  await page.locator(".view-switch button[data-view=split][aria-checked=true]").waitFor();
  await fakeClipboard(page);
  const cell = page.locator(".cm-content .cm-line", { hasText: "王小明" });
  await cell.click({ button: "right" });
  const menu = page.locator("#context-anchor-popover");
  await menu.waitFor();
  await menu.locator(":scope > button", { hasText: /^表格$/ }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.waitFor();
  await sub.locator(":scope > button", { hasText: "複製整個表格" }).click();
  const data = await clip(page);
  assert.equal(data["text/plain"], TABLE);
  assert.match(data["text/html"], /<th[^>]*>負責人<\/th>/);
  assert.deepEqual(errors, []);
  await context.close();
});
