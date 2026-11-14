/**
 * 拖曳選取的文字：從預覽或編輯區選一段文字，拖到助理的輸入區放開，就放進問題裡（放在游標的位置，
 * 整個輸入區都可以放）；從預覽拖到編輯區照樣插入；拖一個連結放在不能輸入的地方，視窗不會被導走。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\旅遊";
const desktop = {
  startup_target: { kind: "folder", path: ROOT, name: "旅遊" },
  list_dir: { $by: "path", values: { [ROOT]: [] } },
  load_settings: JSON.stringify({ claudeApiEnabled: true, assistantProjects: [ROOT], outlineRight: false }),
  assistant_key_status: true,
  assistant_usage: { month: "2026-11", usd: 0, limit: 10 },
};
const DOC = "# 行程\n\n票券：購買城市通行證，可以換三個景點。\n\n第二段文字。\n\n參考 [官方網站](https://example.test/pass) 的說明。\n";

async function setup(view) {
  const opened = await open({ desktop });
  const { page } = opened;
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText(DOC);
  await page.click(`.statusbar [data-view="${view}"]`);
  await page.keyboard.press("Control+Shift+L");
  await page.locator("#assistant-panel textarea").waitFor();
  await settle(page);
  return opened;
}

/**
 * 等版面停下來：打開助理（右側欄出現）、切到分割檢視（預覽重畫、捲動同步）之後，編輯區與預覽的位置
 * 可能還在變；量座標之前先等連續兩次量到的都一樣，不然拖的起點、放開的位置會落在舊的位置上。
 */
async function settle(page) {
  const snap = () =>
    page.evaluate(() =>
      JSON.stringify(
        [".cm-content", "#preview", "#assistant-panel"].map((s) => {
          const el = document.querySelector(s);
          const r = el?.getBoundingClientRect();
          return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width)] : null;
        }).concat([document.querySelector("#preview-scroller")?.scrollTop ?? 0]),
      ),
    );
  let last = await snap();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(50);
    const now = await snap();
    if (now === last) return;
    last = now;
  }
}

/** 在 `root` 裡選取 `text`，回傳選取範圍中間的座標。 */
const selectIn = (page, root, text) =>
  page.evaluate(
    ([root, text]) => {
      const walker = document.createTreeWalker(document.querySelector(root), NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent.indexOf(text);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + text.length);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      return null;
    },
    [root, text],
  );

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 15, from.y + 5, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

const center = async (page, sel) => {
  const b = await page.locator(sel).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test("從預覽選一段文字拖到助理的輸入區：放進問題裡，游標在輸入框；已經有字時隔一個空白", async () => {
  const { page, context, errors } = await setup("preview");
  const ta = page.locator("#assistant-panel textarea");
  await ta.fill("這是什麼：");
  await ta.press("End");
  await drag(page, await selectIn(page, "#preview", "城市通行證"), await center(page, "#assistant-panel textarea"));
  assert.equal(await ta.inputValue(), "這是什麼： 城市通行證");
  assert.equal(await ta.evaluate((el) => el === document.activeElement), true);
  // 放在輸入區的其他地方（例如下面那排按鈕旁邊）也可以。
  await drag(page, await selectIn(page, "#preview", "第二段文字"), await center(page, "#assistant-panel .assistant-chips"));
  assert.equal(await ta.inputValue(), "這是什麼： 城市通行證 第二段文字");
  assert.deepEqual(errors, []);
  await context.close();
});

test("從編輯區（原始碼）選取拖到助理：放進問題裡，文件不變", async () => {
  const { page, context, errors } = await setup("editor");
  const before = await page.locator(".cm-content").textContent();
  await drag(page, await selectIn(page, ".cm-content", "三個景點"), await center(page, "#assistant-panel textarea"));
  assert.equal(await page.locator("#assistant-panel textarea").inputValue(), "三個景點");
  assert.equal(await page.locator(".cm-content").textContent(), before, "文件沒有被搬走或改掉");
  assert.deepEqual(errors, []);
  await context.close();
});

test("從預覽拖到編輯區：插入在放開的位置；拖連結放在不能輸入的地方，視窗不會被導走", async () => {
  const { page, context, errors } = await setup("split");
  const target = await selectIn(page, ".cm-content", "第二段文字");
  await page.evaluate(() => getSelection().removeAllRanges());
  await drag(page, await selectIn(page, "#preview", "城市通行證"), { x: target.x + 40, y: target.y });
  await page.waitForFunction(() => document.querySelector(".cm-content").textContent.split("城市通行證").length === 3);
  assert.match(await page.locator(".cm-line", { hasText: "第二段" }).textContent(), /城市通行證/, "插入在放開的那一行");
  const url = page.url();
  const link = await page.locator("#preview a", { hasText: "官方網站" }).boundingBox();
  await drag(page, { x: link.x + link.width / 2, y: link.y + link.height / 2 }, await center(page, ".statusbar"));
  await page.waitForTimeout(300);
  assert.equal(page.url(), url, "沒有被導到連結的網址");
  assert.deepEqual(errors, []);
  await context.close();
});
