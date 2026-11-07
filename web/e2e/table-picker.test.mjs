/**
 * 插入表格先選大小：指令面板、斜線指令、插入選單都會打開格子，滑鼠或方向鍵選幾欄、幾列（含標題列），
 * 插入後選取第一個欄位名稱，直接打字就能取代；Esc 取消時文件不變、游標回到文件。格子一律留在視窗內。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand, setText } from "./helpers.mjs";

const picker = (page) => page.locator(".table-picker:popover-open");
/** 文件的原始碼（即時預覽會把表格畫成表格，所以從 CodeMirror 的 EditorView 讀；內部屬性名稱改版時可能不同）。 */
const docText = (page) =>
  page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const tile = content?.cmView ?? content?.cmTile;
    return (tile?.view ?? tile?.root?.view).state.doc.toString();
  });
/** 文件裡的表格：每一列的儲存格（去掉前後空白）。 */
async function tableRows(page) {
  const lines = (await docText(page)).split("\n").filter((l) => l.startsWith("|"));
  return lines.map((l) => l.slice(1, -1).split("|").map((c) => c.trim()));
}

test("指令面板：滑鼠選 4 欄 × 3 列後按一下插入，直接打字取代第一個欄位名稱", async () => {
  const { page, context, errors } = await open();
  await setText(page, "工作分配\n\n");
  await runCommand(page, "插入表格");
  await picker(page).waitFor();
  // 格子留在視窗內
  const box = await picker(page).boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 800, JSON.stringify(box));
  const cell = page.locator('.table-picker-cell[data-col="4"][data-row="3"]');
  await cell.hover();
  assert.equal(await page.locator(".table-picker-label").textContent(), "4 欄 × 3 列");
  assert.equal(await page.locator(".table-picker-cell.on").count(), 12);
  await cell.click();
  await picker(page).waitFor({ state: "hidden" });
  const rows = await tableRows(page);
  assert.equal(rows.length, 4); // 標題列、分隔列、兩列內容
  assert.deepEqual(rows[0], ["欄位 1", "欄位 2", "欄位 3", "欄位 4"]);
  assert.deepEqual(rows[2], ["", "", "", ""]);
  await page.keyboard.type("項目");
  assert.deepEqual((await tableRows(page))[0], ["項目", "欄位 2", "欄位 3", "欄位 4"]);
  assert.match(await docText(page), /^工作分配\n\n\| 項目/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("斜線指令：方向鍵調整大小，Enter 插入", async () => {
  const { page, context, errors } = await open();
  await setText(page, "");
  await page.keyboard.type("/表格");
  await page.locator(".cm-tooltip-autocomplete").waitFor();
  await page.keyboard.press("Enter");
  await picker(page).waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains("table-picker-grid"));
  // 一開始是 3 欄 × 3 列
  assert.equal(await page.locator(".table-picker-label").textContent(), "3 欄 × 3 列");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.locator(".table-picker-label").textContent(), "5 欄 × 2 列");
  await page.keyboard.press("Enter");
  await picker(page).waitFor({ state: "hidden" });
  const rows = await tableRows(page);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].length, 5);
  assert.doesNotMatch(await docText(page), /\/表格/);
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".cm-editor")), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("插入選單：Esc 取消，文件不變，游標回到文件", async () => {
  const { page, context, errors } = await open();
  await setText(page, "第一段\n\n");
  await page.keyboard.press("Control+Shift+Enter");
  const item = page.locator(".menu:popover-open button", { hasText: "插入表格" });
  await item.click();
  await picker(page).waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains("table-picker-grid"));
  await page.keyboard.press("Escape");
  await picker(page).waitFor({ state: "hidden" });
  await page.waitForFunction(() => !!document.activeElement?.closest(".cm-editor"));
  assert.equal(await docText(page), "第一段\n\n");
  await page.keyboard.type("繼續");
  assert.equal(await docText(page), "第一段\n\n繼續");
  assert.deepEqual(errors, []);
  await context.close();
});

test("游標在視窗下緣時，格子往上開，不會超出視窗", async () => {
  const { page, context, errors } = await open();
  await setText(page, Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行`).join("\n"));
  await page.keyboard.press("Control+Home");
  // 游標放到畫面下緣附近的一行（不捲動）。
  const cursor = await page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const tile = content?.cmView ?? content?.cmTile;
    const view = tile?.view ?? tile?.root?.view;
    let pos = 0;
    for (let n = 1; n <= view.state.doc.lines; n++) {
      const line = view.state.doc.line(n);
      const at = view.coordsAtPos(line.to);
      if (at && at.bottom < innerHeight - 70) pos = line.to;
    }
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
    return view.coordsAtPos(pos);
  });
  assert.ok(cursor.bottom > 600, JSON.stringify(cursor));
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator("dialog[open] input").first();
  await input.waitFor();
  await input.fill("插入表格");
  await page.keyboard.press("Enter");
  await picker(page).waitFor();
  const box = await picker(page).boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= 800, JSON.stringify(box));
  assert.ok(box.y + box.height <= cursor.top + 1, `格子應該在游標上面：${JSON.stringify({ box, cursor })}`);
  assert.deepEqual(errors, []);
  await context.close();
});
