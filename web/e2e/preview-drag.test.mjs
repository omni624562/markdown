/**
 * 在預覽拖動段落調整順序（app/preview-drag.ts）：滑鼠移到段落、標題、清單項目上，左邊出現把手，
 * 拖到別的位置放開就搬過去，原始 Markdown 跟著改；按 Ctrl+Z 還原（畫面上看得到搬過去了，不跳通知）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const DOC = [
  "# 五天四夜",
  "",
  "前言。",
  "",
  "## 第一天",
  "",
  "- 早上：搭地鐵",
  "- 中午：吃海鮮麵",
  "- 晚上：逛夜市",
  "",
  "## 第二天",
  "",
  "看海。",
  "",
  "1. 搭纜車",
  "2. 吃冰",
  "",
  "## 第三天",
  "",
  "回家。",
  "",
].join("\n");

async function setup() {
  const opened = await open();
  const { page } = opened;
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText(DOC);
  await page.click('.statusbar [data-view="preview"]');
  await page.locator("#preview h2").first().waitFor();
  return opened;
}

const text = (page) => page.evaluate(() => [...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n"));

/** 滑鼠移到 `from`（預覽裡的元素）上，拖它的把手到 `to` 元素的上緣（`after` 時下緣）放開。 */
async function dragBlock(page, from, to, after = false) {
  const src = await page.locator(from).first().boundingBox();
  await page.mouse.move(src.x + 30, src.y + 8);
  const handle = page.locator(".preview-drag-handle:not([hidden])");
  await handle.waitFor();
  const h = await handle.boundingBox();
  const dst = await page.locator(to).first().boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 5, h.y + 10, { steps: 3 });
  await page.mouse.move(dst.x + 40, after ? dst.y + dst.height - 2 : dst.y + 2, { steps: 10 });
  await page.mouse.up();
}

test("拖標題：整個章節（標題到下一個標題前）搬到別的標題前面；不跳通知，Ctrl+Z 還原", async () => {
  const { page, context, errors } = await setup();
  await dragBlock(page, "#preview h2:has-text('第三天')", "#preview h2:has-text('第一天')");
  await page.waitForFunction(() => document.querySelector("#preview h2")?.textContent.includes("第三天"));
  const after = await text(page);
  assert.ok(after.indexOf("## 第三天") < after.indexOf("## 第一天"), after);
  assert.match(after, /## 第三天\n\n回家。\n\n## 第一天/, "章節內容跟著走、前後留空白行");
  assert.equal(await page.locator(".toast").count(), 0, "不跳通知");
  await page.keyboard.press("Control+Z");
  await page.waitForFunction(() => document.querySelector("#preview h2")?.textContent.includes("第一天"));
  assert.equal((await text(page)).trim(), DOC.trim());
  assert.deepEqual(errors, []);
  await context.close();
});

test("拖清單項目：同一個清單調整順序；搬到編號清單裡變成編號項目", async () => {
  const { page, context, errors } = await setup();
  await dragBlock(page, "#preview li:has-text('晚上')", "#preview li:has-text('早上')");
  await page.waitForFunction(() => document.querySelector("#preview li")?.textContent.includes("晚上"));
  assert.match(await text(page), /- 晚上：逛夜市\n- 早上：搭地鐵\n- 中午：吃海鮮麵/);
  await dragBlock(page, "#preview li:has-text('中午')", "#preview li:has-text('吃冰')");
  await page.waitForFunction(() => [...document.querySelectorAll("#preview ol li")].some((li) => li.textContent.includes("中午")));
  assert.match(await text(page), /1\. 搭纜車\n2\. 中午：吃海鮮麵\n2\. 吃冰/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("拖一般段落：放在最後一段後面，前後留空白行", async () => {
  const { page, context, errors } = await setup();
  await dragBlock(page, "#preview p:has-text('前言')", "#preview p:has-text('回家')", true);
  await page.waitForFunction(() => [...document.querySelectorAll("#preview > p")].at(-1)?.textContent.includes("前言"));
  assert.match(await text(page), /回家。\n\n前言。\n?$/);
  assert.doesNotMatch(await text(page), /# 五天四夜\n\n\n/, "拿走的地方不留兩個空白行");
  assert.deepEqual(errors, []);
  await context.close();
});

test("拖完按 Ctrl+Z 復原、Ctrl+Y 重做（焦點不在編輯區也一樣）", async () => {
  const { page, context, errors } = await setup();
  await dragBlock(page, "#preview h2:has-text('第三天')", "#preview h2:has-text('第一天')");
  const moved = () => page.evaluate(() => document.querySelector("#preview h2")?.textContent.includes("第三天"));
  await page.waitForFunction(() => document.querySelector("#preview h2")?.textContent.includes("第三天"));
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".cm-editor")), false, "焦點不在編輯區");
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => document.querySelector("#preview h2")?.textContent.includes("第一天"));
  assert.equal((await text(page)).trim(), DOC.trim());
  await page.keyboard.press("Control+y");
  await page.waitForFunction(() => document.querySelector("#preview h2")?.textContent.includes("第三天"));
  assert.equal(await moved(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("把手前幾次出現時旁邊有說明「拖這裡可以調整順序」，不擋滑鼠；拖過一次之後不再出現；大綱的標題游標是手形", async () => {
  const { page, context, errors } = await open({ desktop: { load_settings: JSON.stringify({ outlineRight: true }) } });
  await page.evaluate((text) => {
    const content = document.querySelector(".cm-content");
    const tile = content?.cmView ?? content?.cmTile;
    const view = tile?.view ?? tile?.root?.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, "# 甲\n\n第一段。\n\n第二段。\n\n# 乙\n\n第三段。\n");
  await page.click('.statusbar [data-view="preview"]');
  const para = (text) => page.locator("#preview p", { hasText: text });
  await para("第一段").waitFor();
  const hint = page.locator(".drag-hint:not([hidden])");
  assert.equal(await hint.count(), 0);
  await para("第一段").hover();
  await hint.waitFor();
  assert.equal(await hint.textContent(), "拖這裡可以調整順序");
  const placed = await page.evaluate(() => {
    const h = document.querySelector("#preview-scroller .preview-drag-handle").getBoundingClientRect();
    const b = document.querySelector(".drag-hint");
    const r = b.getBoundingClientRect();
    return { above: r.bottom <= h.top, near: Math.abs(r.left - h.left) <= 4 && h.top - r.bottom <= 10, passthrough: getComputedStyle(b).pointerEvents === "none" };
  });
  assert.deepEqual(placed, { above: true, near: true, passthrough: true });
  // 滑鼠離開預覽：把手和說明一起消失。
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => !document.querySelector(".drag-hint:not([hidden])"));
  // 拖過一次：之後把手出現也不再說明。
  await para("第一段").hover();
  const handle = page.locator("#preview-scroller .preview-drag-handle");
  await handle.dragTo(para("第三段"), { targetPosition: { x: 20, y: 20 } });
  await page.waitForFunction((s) => document.querySelector(".sr-only[role=status]")?.textContent.includes(s), "已調整順序");
  await page.mouse.move(5, 5);
  await para("第二段").hover();
  await page.waitForTimeout(900);
  assert.equal(await hint.count(), 0);
  // 大綱：可以拖的標題游標是手形。
  assert.equal(await page.locator("#outline-list a[data-index]").first().evaluate((a) => getComputedStyle(a).cursor), "grab");
  assert.deepEqual(errors, []);
  await context.close();
});
