/**
 * 視覺小地方：預覽的待辦看得清楚、即時預覽的程式碼區塊不露出圍欄、⋯ →「外觀」標出目前的明暗、
 * 即時預覽與 Wiki、工作板與專案總覽的圖示不一樣。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

/** 預覽裡兩個待辦勾選框的樣子，加上沒勾的框線和背後底色的對比。 */
const checkboxLook = (page) =>
  page.evaluate(() => {
    const rgb = (c) => {
      const probe = document.createElement("span");
      probe.style.color = c;
      document.body.append(probe);
      const m = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
      probe.remove();
      return m.slice(0, 3);
    };
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrast = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const [open, done] = document.querySelectorAll("#preview .task-list-item input[type=checkbox]");
    // 框線要和勾選框外面看得到的底色比：往上找第一個有底色的元素。
    let backdrop = "rgba(0, 0, 0, 0)";
    for (let el = open.parentElement; el && /^rgba\(.*, 0\)$|^transparent$/.test(backdrop); el = el.parentElement) {
      backdrop = getComputedStyle(el).backgroundColor;
    }
    const s = getComputedStyle(open);
    return {
      disabled: open.disabled,
      opacity: [s.opacity, getComputedStyle(done).opacity],
      cursor: s.cursor,
      backdrop,
      ratio: contrast(rgb(s.borderTopColor), rgb(backdrop)),
      accent: rgb("var(--accent)").join(),
      doneRgb: rgb(getComputedStyle(done).borderTopColor).join(),
    };
  });

test("預覽的待辦：不變淡、沒勾的框線和底色對比至少 3:1（淺色、深色），勾了是強調色", async () => {
  const { page, context, errors } = await open();
  await setText(page, "- [ ] 買牛奶\n- [x] 寫週報");
  await page.click('button[data-view="preview"]');
  await page.waitForSelector("#preview .task-list-item input[type=checkbox]");
  for (const theme of ["淺色", "深色"]) {
    // 預覽模式看不到編輯區：直接按快速鍵開指令面板。
    await page.keyboard.press("Control+Shift+P");
    await page.locator("dialog[open] input").first().fill(`明暗：${theme}`);
    await page.keyboard.press("Enter");
    await page.waitForFunction((dark) => (document.documentElement.dataset.theme === "dark") === dark, theme === "深色");
    // 勾選框的框線換色有轉場：直接跳到結束再量。
    await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
    const look = await checkboxLook(page);
    assert.equal(look.disabled, true);
    assert.deepEqual(look.opacity, ["1", "1"], theme);
    assert.equal(look.cursor, "default");
    assert.ok(look.ratio >= 3, `${theme}：對比 ${look.ratio.toFixed(2)}（底色 ${look.backdrop}）`);
    assert.equal(look.doneRgb, look.accent, theme);
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test("即時預覽的程式碼區塊：游標不在裡面時只留語言名稱、結尾的 ``` 藏起來；進出區塊版面不跳", async () => {
  const { page, context, errors } = await open();
  await setText(page, "前文\n\n```js\nconst a = 1;\n```\n\n後文");
  await page.click('button[data-view="live"]');
  await page.keyboard.press("Control+End");
  const look = () =>
    page.evaluate(() => {
      const lines = [...document.querySelectorAll(".cm-content .cm-line")];
      const fences = lines.filter((l) => l.classList.contains("cm-lp-fence"));
      const after = lines.find((l) => l.textContent === "後文");
      const top = fences[0].getBoundingClientRect().top;
      return {
        text: fences.map((l) => l.textContent),
        heights: fences.map((l) => l.getBoundingClientRect().height),
        gap: after.getBoundingClientRect().top - top,
      };
    });
  await page.waitForFunction(() => document.querySelector(".cm-line.cm-lp-fence")?.textContent === "js");
  const outside = await look();
  assert.deepEqual(outside.text, ["js", ""]);
  // 游標移進區塊：圍欄顯示原文，行高與後面的位置都不變。
  await page.click(".cm-line:has-text('const a')");
  await page.waitForFunction(() => document.querySelector(".cm-line.cm-lp-fence")?.textContent === "```js");
  const inside = await look();
  assert.deepEqual(inside.text, ["```js", "```"]);
  assert.deepEqual(inside.heights, outside.heights);
  assert.equal(inside.gap, outside.gap);
  // 還沒寫結尾的區塊照原樣顯示 ```，看得出後面為什麼都是程式碼。
  await setText(page, "前文\n\n```\n沒有結尾");
  await page.keyboard.press("Control+Home");
  await page.waitForFunction(() => document.querySelector(".cm-line.cm-lp-fence")?.textContent === "```");
  assert.deepEqual(errors, []);
  await context.close();
});

test("⋯ →「外觀」：明暗的跟隨系統／淺色／深色標出目前選的那一項", async () => {
  const { page, context, errors } = await open();
  const openTheme = async () => {
    await page.click("#main-menu");
    const root = page.locator("#main-menu-popover");
    await root.getByRole("menuitem", { name: "外觀" }).click();
    const sub = root.locator(".submenu:popover-open");
    await sub.waitFor();
    return sub;
  };
  /** 每一項：名稱、aria-checked、最後面有沒有打勾的圖示（前面還有指令本身的圖示）。 */
  const state = (sub) =>
    sub
      .locator('[role="menuitemradio"]')
      .evaluateAll((els) => els.map((b) => [b.textContent, b.getAttribute("aria-checked"), b.querySelectorAll(".icon").length === 2 && b.lastElementChild.matches(".icon")]));
  let sub = await openTheme();
  assert.deepEqual(await state(sub), [
    ["明暗：跟隨系統", "true", true],
    ["明暗：淺色", "false", false],
    ["明暗：深色", "false", false],
  ]);
  await sub.getByRole("menuitemradio", { name: "明暗：深色" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  sub = await openTheme();
  assert.deepEqual(await state(sub), [
    ["明暗：跟隨系統", "false", false],
    ["明暗：淺色", "false", false],
    ["明暗：深色", "true", true],
  ]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("圖示：即時預覽和 Wiki 不同、工作板和專案總覽不同", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  const svg = (locator) => locator.locator("svg").first().evaluate((el) => el.innerHTML);
  assert.notEqual(await svg(page.locator('button[data-view="live"]')), await svg(page.locator("#side-tab-wiki")));
  // 專案總覽：指令面板裡的圖示。
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill("專案總覽");
  const overview = page.locator("dialog[open] li", { hasText: "專案總覽" }).first();
  await overview.waitFor();
  assert.notEqual(await svg(overview), await svg(page.locator("#side-tab-board")));
  assert.deepEqual(errors, []);
  await context.close();
});
