/**
 * 左側圖示列的捷徑：開著的那一個是右下角一個小圓點；左邊一條＋底色只給上面的面板圖示，
 * 圖示列上同一時間只有一個「左邊一條」。工作項目捷徑整塊塗上類型的顏色（不用左邊一條，免得像開著）。
 * 開著的捷徑再按一次：捲回最上面。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ITEM = {
  id: 1895963,
  title: "訂單明細查詢及退貨申請",
  state: "Active",
  kind: "Feature",
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-10-30T00:00:00Z",
  priority: 2,
  webUrl: "https://ado.test/c/產品/_workitems/edit/1895963",
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  // 夠長才捲得動。
  description: Array.from({ length: 80 }, (_, i) => `<p>第 ${i + 1} 段說明</p>`).join(""),
  details: null,
  rev: 3,
  relations: [],
  attachments: [],
  comments: [],
};

test("開著的捷徑是右下角的小圓點，圖示列上只有面板有左邊一條；工作項目捷徑整塊塗上類型顏色；再按一次捲回最上面", async () => {
  const { page, context, errors } = await open({
    desktop: { ado_account: { url: "https://ado.test/c", name: "王小明" }, ado_work_item: ITEM },
  });
  await page.evaluate((item) => {
    localStorage.setItem("md-editor:wiki-shortcuts", JSON.stringify([{ workItem: item.id, kind: item.kind, title: item.title }]));
  }, ITEM);
  await page.reload();
  // 開一個面板：它是「左邊一條」的那一個。
  await page.click("#side-tab-workitems");
  const shortcut = page.locator(".activity-wiki-page").first();
  await shortcut.click();
  await page.waitForSelector(".ado-hero");
  await page.waitForFunction(() => document.querySelector(".activity-wiki-page")?.getAttribute("aria-current") === "page");
  await page.mouse.move(600, 400);
  const look = await page.evaluate(() => {
    const tab = document.querySelector('.activity-tabs button[aria-selected="true"]');
    const sc = document.querySelector('.activity-wiki-page[aria-current="page"]');
    const badge = sc.querySelector(".wiki-badge");
    // 圖示列上畫了「左邊一條」的（::before 有內容）。
    const bars = [...document.querySelectorAll(".activity-bar button")].filter((b) => getComputedStyle(b, "::before").content !== "none");
    const dot = getComputedStyle(sc, "::after");
    const probe = document.createElement("span");
    probe.dataset.wiKind = "feature";
    probe.style.color = "var(--kind)";
    document.body.append(probe);
    const kind = getComputedStyle(probe).color;
    probe.remove();
    return {
      bars: bars.map((b) => b.id || b.className),
      tabBar: getComputedStyle(tab, "::before").backgroundColor,
      scBg: getComputedStyle(sc).backgroundColor,
      dot: { content: dot.content, width: dot.width, color: dot.backgroundColor },
      badgeBg: getComputedStyle(badge).backgroundColor,
      badgeColor: getComputedStyle(badge).color,
      stripe: getComputedStyle(badge).borderLeftWidth,
      kind,
    };
  });
  assert.deepEqual(look.bars, ["side-tab-workitems"], "左邊一條只有開著的面板");
  assert.equal(look.scBg, "rgba(0, 0, 0, 0)", "開著的捷徑沒有底色");
  assert.equal(look.dot.content, '""');
  assert.equal(look.dot.width, "8px");
  assert.equal(look.dot.color, look.tabBar, "小圓點用強調色");
  assert.equal(look.badgeBg, look.kind, "整塊塗上類型的顏色");
  assert.equal(look.stripe, "0px", "不用左邊一條");
  assert.equal(look.badgeColor, "rgb(255, 255, 255)", "Feature 的紫色上是白字");
  // 再按一次：捲回最上面，不重新讀取。
  const scroller = page.locator(".issue-scroll");
  await scroller.evaluate((el) => (el.scrollTop = 800));
  const before = (await calls(page)).filter((c) => c.cmd === "ado_work_item").length;
  await shortcut.click();
  await page.waitForFunction(() => document.querySelector(".issue-scroll").scrollTop === 0);
  assert.equal((await calls(page)).filter((c) => c.cmd === "ado_work_item").length, before, "沒有重新讀取");
  assert.deepEqual(errors, []);
  await context.close();
});
