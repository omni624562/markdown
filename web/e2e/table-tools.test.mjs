/**
 * 表格工具：分割、原始碼模式也能用右鍵選單的「表格」插入／刪除列與欄、對齊、排序；
 * 從試算表貼上 Tab 分隔的文字直接變成表格；選取逗號分隔的幾行按右鍵「轉成表格」。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const TABLE = "# 工作分配\n\n| 項目 | 負責人 | 工時 |\n| --- | --- | --- |\n| 報表 | 李大同 | 12 |\n| 登入頁 | 王小明 | 3 |\n\n備註。\n";

const docText = (page) => page.evaluate(() => [...document.querySelectorAll(".cm-content .cm-line")].map((l) => l.textContent).join("\n"));

/** 在分割模式寫入 `text`（左邊是原始碼）。 */
async function splitWith(page, text) {
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText(text);
  await page.locator(".view-switch button", { hasText: "分割" }).click();
  await page.locator(".view-switch button[data-view=split][aria-checked=true]").waitFor();
}

/** 在編輯區某段文字上按右鍵（游標會移到那裡），回傳右鍵選單。 */
async function rightClickText(page, text) {
  const at = await page.evaluate((t) => {
    const walker = document.createTreeWalker(document.querySelector(".cm-content"), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(t);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + t.length);
      const b = r.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    return null;
  }, text);
  assert.ok(at, text);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.locator("#context-anchor-popover");
  await menu.waitFor();
  return menu;
}

/** 右鍵選單的「表格」子選單。 */
async function tableMenu(menu) {
  await menu.locator(":scope > button", { hasText: /^表格$/ }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.waitFor();
  return sub;
}

test("分割模式：右鍵選單的「表格」排序、插入列與欄、對齊", async () => {
  const { page, context, errors } = await open();
  await splitWith(page, TABLE);

  // 不在表格裡：沒有「表格」。
  let menu = await rightClickText(page, "備註");
  assert.equal(await menu.locator(":scope > button", { hasText: /^表格$/ }).count(), 0);
  await page.keyboard.press("Escape");

  // 依「工時」排序（小到大）：數字比大小，3 在 12 前面。
  menu = await rightClickText(page, "12");
  let sub = await tableMenu(menu);
  const items = await sub.locator(":scope > button").allTextContents();
  for (const label of ["在上方插入一列", "在下方插入一列", "在左側插入一欄", "在右側插入一欄", "刪除目前這一列", "這一欄置中", "依這一欄排序（小到大）", "對齊目前的表格"]) {
    assert.ok(items.some((s) => s.startsWith(label)), `${label}：${items.join("|")}`);
  }
  await sub.locator(":scope > button", { hasText: "依這一欄排序（小到大）" }).click();
  await page.waitForFunction(() => {
    const t = document.querySelector(".cm-content").innerText;
    return t.indexOf("登入頁") < t.indexOf("報表");
  });

  // 在「王小明」那一列上方插入一列。
  menu = await rightClickText(page, "王小明");
  sub = await tableMenu(menu);
  await sub.locator(":scope > button", { hasText: "在上方插入一列" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".cm-content .cm-line").length === 10);
  let lines = (await docText(page)).split("\n");
  assert.match(lines[4], /^\|\s+\|\s+\|\s+\|$/);
  assert.match(lines[5], /登入頁/);

  // 「工時」這一欄靠右。
  menu = await rightClickText(page, "工時");
  sub = await tableMenu(menu);
  await sub.locator(":scope > button", { hasText: "這一欄靠右" }).click();
  await page.waitForFunction(() => /-:\s*\|\s*$/.test(document.querySelectorAll(".cm-content .cm-line")[3]?.textContent ?? ""));

  // 在「負責人」左邊插入一欄。
  menu = await rightClickText(page, "負責人");
  sub = await tableMenu(menu);
  await sub.locator(":scope > button", { hasText: "在左側插入一欄" }).click();
  await page.waitForFunction(() => (document.querySelectorAll(".cm-content .cm-line")[2]?.textContent.match(/\|/g) ?? []).length === 5);
  lines = (await docText(page)).split("\n");
  assert.match(lines[2], /^\| 項目\s+\|\s+\| 負責人/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("從試算表貼上 Tab 分隔的文字：變成表格；程式碼區塊裡照原樣貼上", async () => {
  const { page, context, errors } = await open();
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("本週工時：\n");
  const paste = (text) =>
    page.locator(".cm-content").evaluate((el, t) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", t);
      el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    }, text);
  await paste("項目\t負責人\t工時\r\n登入頁\t王小明\t3\r\n報表\t李大同\t12\r\n");
  await page.locator(".toast", { hasText: "已轉成表格" }).waitFor();
  const text = await docText(page);
  assert.match(text, /本週工時：\n\n\| 項目\s+\| 負責人 \| 工時 \|\n\| -+ \| -+ \| -+ \|\n\| 登入頁 \| 王小明\s+\| 3\s+\|\n\| 報表\s+\| 李大同\s+\| 12\s+\|/);

  // 程式碼區塊裡不轉。
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n```\n");
  await paste("a\tb\nc\td");
  await page.waitForTimeout(200);
  assert.match(await docText(page), /```\na\tb\nc\td/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("選取逗號分隔的幾行，右鍵「轉成表格」", async () => {
  const { page, context, errors } = await open();
  await splitWith(page, "名字,地點\n王小明,\"台北, 信義區\"\n李大同,台中");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+A");
  const menu = await rightClickText(page, "名字");
  await menu.locator(":scope > button", { hasText: "轉成表格" }).click();
  await page.waitForFunction(() => document.querySelector(".cm-content .cm-line")?.textContent.startsWith("| 名字"));
  const text = await docText(page);
  assert.match(text, /^\| 名字\s+\| 地點\s+\|\n\| -+ \| -+ \|\n\| 王小明 \| 台北, 信義區 \|\n\| 李大同 \| 台中\s+\|/);
  assert.deepEqual(errors, []);
  await context.close();
});
