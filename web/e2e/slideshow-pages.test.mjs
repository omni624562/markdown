/**
 * 簡報模式的版面：一頁放不下時先縮小字（最多縮到一半），再放不下就分成好幾頁
 * （段落之間、清單的項目之間分開，後面的頁面標題加「（續）」，小標不留在一頁的最後面），
 * 不會縮成小字又被切掉；一塊就比一頁還高時那一頁可以捲動；桌面版用原生的視窗全螢幕。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

/** 很長的一段：五天，每天八個時段，每個時段有兩行說明（假資料）。 */
const day = (n) =>
  [
    `**第 ${n} 天：市區 → 海邊 → 夜市**`,
    "",
    ...Array.from({ length: 8 }, (_, i) => `- **${10 + i}:00 景點 ${n}-${i}**：\n  - 交通：搭地鐵 ${(i % 3) + 1} 號線，約 ${10 + i} 分鐘。\n  - 午餐：在市場吃海鮮麵。`),
    "",
  ].join("\n");
const LONG = ["# 五天四夜", "", "## 重點", "", "- 重點一", "- 重點二", "", "## 每日行程", "", day(1), day(2), day(3), day(4), day(5), "## 結尾", "", "謝謝"].join("\n");

async function play(page, text) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(text);
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill("簡報模式：從頭播放");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".slideshow:not([hidden]) .slide > *");
  await page.waitForFunction(() => !document.querySelector(".slideshow").classList.contains("slide-measuring"));
}

/** 目前這一頁：字級、是否放得下、內容。 */
const current = (page) =>
  page.evaluate(() => {
    const stage = document.querySelector(".slide-stage");
    const slide = document.querySelector(".slideshow .slide");
    const s = getComputedStyle(stage);
    const room = stage.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
    const last = slide.lastElementChild;
    return {
      size: parseFloat(slide.style.fontSize),
      fits: slide.scrollHeight <= room + 1,
      top: Math.round(slide.getBoundingClientRect().top),
      tall: document.querySelector(".slideshow").classList.contains("slide-tall"),
      heading: slide.querySelector("h1, h2")?.textContent ?? "",
      items: [...slide.querySelectorAll("li > strong")].map((s) => s.textContent),
      endsWithLabel: last.tagName === "P" && last.childElementCount === 1 && last.firstElementChild.tagName === "STRONG",
      counter: document.querySelector(".slide-counter").textContent,
    };
  });

test("很長的一段分成好幾頁：字不會小於大字的一半、每一頁都放得下，項目一個不少也不重複，後面的頁面標題加「（續）」", async () => {
  const { page, context, errors } = await open();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await play(page, LONG);
  const first = await current(page);
  const big = first.size;
  const total = Number(first.counter.split("/")[1]);
  assert.ok(total > 5, `分成好幾頁：${first.counter}`);
  const seen = [];
  const pages = [];
  for (let i = 0; i < total; i++) {
    const p = await current(page);
    pages.push(p);
    assert.equal(p.counter, `${i + 1} / ${total}`);
    assert.ok(p.fits && !p.tall, `第 ${i + 1} 頁放得下：${JSON.stringify(p)}`);
    assert.ok(p.top >= 0, `第 ${i + 1} 頁上面沒有被切掉：${p.top}`);
    assert.ok(p.size >= big / 2 - 0.5, `第 ${i + 1} 頁的字 ${p.size}px 不小於 ${big / 2}px`);
    assert.equal(p.endsWithLabel, false, `第 ${i + 1} 頁沒有把「第幾天」留在最後面`);
    seen.push(...p.items);
    await page.keyboard.press("ArrowRight");
  }
  const expected = [1, 2, 3, 4, 5].flatMap((n) => Array.from({ length: 8 }, (_, i) => `${10 + i}:00 景點 ${n}-${i}`));
  assert.deepEqual(seen, expected, "每個時段都出現一次，順序不變");
  const daily = pages.filter((p) => p.heading.startsWith("每日行程"));
  assert.ok(daily.length > 2, `「每日行程」分成 ${daily.length} 頁`);
  assert.equal(daily[0].heading, "每日行程");
  for (const p of daily.slice(1)) assert.equal(p.heading, "每日行程（續）");
  assert.deepEqual(errors, []);
  await context.close();
});

test("編號的清單分頁後接著原本的編號；短的頁面照樣用大字", async () => {
  const { page, context, errors } = await open();
  await page.setViewportSize({ width: 1280, height: 720 });
  const steps = Array.from({ length: 30 }, (_, i) => `${i + 1}. 步驟 ${i + 1}：檢查設定並記錄結果`).join("\n");
  await play(page, `# 短的一頁\n\n內容\n\n---\n\n# 步驟\n\n${steps}`);
  const short = await current(page);
  await page.keyboard.press("ArrowRight");
  const p2 = await current(page);
  assert.ok(p2.size < short.size, "長的頁面字比較小");
  const starts = [];
  for (;;) {
    starts.push(await page.evaluate(() => Number(document.querySelector(".slideshow .slide ol")?.getAttribute("start") ?? 1)));
    const c = await current(page);
    assert.ok(c.fits, JSON.stringify(c));
    const [n, total] = c.counter.split(" / ").map(Number);
    if (n === total) break;
    await page.keyboard.press("ArrowRight");
  }
  assert.ok(starts.length > 1, "步驟分成好幾頁");
  assert.equal(starts[0], 1);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1], `編號接下去：${starts}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test("一塊就比一頁還高（很長的程式碼）：那一頁從上面開始、可以捲動，空白鍵先捲到底才換頁", async () => {
  const { page, context, errors } = await open();
  await page.setViewportSize({ width: 1280, height: 720 });
  const code = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
  await play(page, `# 程式碼\n\n\`\`\`\n${code}\n\`\`\`\n\n---\n\n# 下一頁`);
  const c = await current(page);
  assert.equal(c.tall, true);
  assert.ok(c.top >= 0, "從上面開始顯示");
  const scrollTop = () => page.evaluate(() => document.querySelector(".slide-stage").scrollTop);
  await page.keyboard.press(" ");
  await page.waitForFunction(() => document.querySelector(".slide-stage").scrollTop > 0);
  assert.equal((await current(page)).counter, "1 / 2", "還在第一頁");
  for (let i = 0; i < 20 && (await current(page)).counter === "1 / 2"; i++) await page.keyboard.press(" ");
  assert.equal((await current(page)).counter, "2 / 2", "捲到底之後換到下一頁");
  assert.equal(await scrollTop(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("視窗大小改變後重新分頁，停在原本看的內容", async () => {
  // 桌面版（原生的視窗全螢幕）：網頁的全螢幕下不能改測試視窗的大小。
  const { page, context, errors } = await open({ desktop: {} });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await play(page, LONG);
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  const before = await current(page);
  // 換成比例不同的視窗（比較高）：一頁放得下的比較多，頁數會變。
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForFunction((c) => document.querySelector(".slide-counter").textContent !== c, before.counter);
  await page.waitForFunction(() => !document.querySelector(".slideshow").classList.contains("slide-measuring"));
  const after = await current(page);
  assert.ok(Number(after.counter.split("/")[1]) < Number(before.counter.split("/")[1]), `頁數變少：${before.counter} → ${after.counter}`);
  assert.ok(after.fits, JSON.stringify(after));
  assert.ok(after.items.includes(before.items[0]), `還看得到原本那一頁的第一個時段（${before.items[0]}）：${after.items}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test("桌面版：用原生的視窗全螢幕（不用網頁的全螢幕），按 Esc 結束後恢復、游標回到編輯器", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await play(page, "# 第一頁\n\n內容\n\n---\n\n# 第二頁");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "window_fullscreen"));
  assert.equal(await page.evaluate(() => document.fullscreenElement), null, "沒有用網頁的全螢幕");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".slideshow", { state: "hidden" });
  await page.waitForFunction(() => !!document.activeElement?.closest(".cm-editor"));
  const ons = (await calls(page)).filter((c) => c.cmd === "window_fullscreen").map((c) => c.args.on);
  assert.deepEqual(ons, [true, false]);
  assert.deepEqual(errors, []);
  await context.close();
});
