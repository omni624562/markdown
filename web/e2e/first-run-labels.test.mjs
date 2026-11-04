/**
 * 第一次開啟時圖示旁邊的名稱提示：只在側邊欄收起來時顯示（落在內文邊上，不蓋住側邊欄）；
 * 側邊欄開著時先不顯示，留到之後側邊欄收起來的那次啟動。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const PENDING = "md-editor:activity-labels-pending";
const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const LIST = { $by: "path", values: { "/notes": [{ name: "a.md", path: "/notes/a.md", isDir: false }] } };

const pending = (page) => page.evaluate((k) => localStorage.getItem(k), PENDING);

async function reload(page) {
  await page.reload();
  await page.waitForSelector(".cm-editor .cm-content");
}

/** 名稱提示在啟動後 0.8 秒出現：等久一點確定沒有出現。 */
async function noLabels(page) {
  await page.waitForTimeout(1500);
  assert.equal(await page.locator(".activity-labels").count(), 0);
}

test("第一次開啟時側邊欄開著（開啟資料夾）：不顯示名稱提示，記下來留到之後", async () => {
  const { page, context, errors } = await open({ desktop: { startup_target: ROOT, list_dir: LIST } });
  await noLabels(page);
  assert.equal(await page.locator("#sidebar").isVisible(), true);
  assert.equal(await pending(page), "1");
  assert.deepEqual(errors, []);
  await context.close();
});

test("名稱提示顯示時側邊欄才打開（資料夾比較晚開好）：收起來，留到之後", async () => {
  const { page, context, errors } = await open({ desktop: { startup_target: { $delay: 1500, value: ROOT }, list_dir: LIST } });
  await page.locator(".activity-labels").waitFor();
  await page.locator(".activity-labels").waitFor({ state: "detached" });
  assert.equal(await page.locator("#sidebar").isVisible(), true);
  assert.equal(await pending(page), "1");
  assert.deepEqual(errors, []);
  await context.close();
});

test("側邊欄收著時才顯示（第一次開啟，或之前沒顯示成的），顯示過就不再出現", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  // 第一次開啟，側邊欄預設收著：名稱在圖示列右邊（內文邊上）。
  await page.locator(".activity-labels .activity-label-hint").waitFor();
  assert.equal(await page.locator("#sidebar").isVisible(), false);
  const { barRight, labelLeft } = await page.evaluate(() => ({
    barRight: document.querySelector(".activity-bar").getBoundingClientRect().right,
    labelLeft: Math.min(...[...document.querySelectorAll(".activity-label")].map((el) => el.getBoundingClientRect().left)),
  }));
  assert.ok(labelLeft >= barRight, `${labelLeft} >= ${barRight}`);
  assert.equal(await pending(page), null);
  await page.mouse.click(640, 400);
  await page.locator(".activity-labels").waitFor({ state: "detached" });
  // 有分頁可以還原：之後不是第一次開啟。
  await page.focus(".cm-content");
  await page.keyboard.type("筆記");
  await page.waitForTimeout(800);

  // 之前沒顯示成、這次側邊欄開著：繼續等。
  await page.evaluate((k) => {
    localStorage.setItem(k, "1");
    localStorage.setItem("md-editor:outline", "shown");
  }, PENDING);
  await reload(page);
  await noLabels(page);
  assert.equal(await page.locator("#sidebar").isVisible(), true);
  assert.equal(await pending(page), "1");

  // 側邊欄收起來後再啟動：顯示，之後就不再顯示。
  await page.evaluate(() => localStorage.setItem("md-editor:outline", "hidden"));
  await reload(page);
  await page.locator(".activity-labels .activity-label-hint").waitFor();
  assert.equal(await pending(page), null);
  await page.mouse.click(640, 400);
  await page.locator(".activity-labels").waitFor({ state: "detached" });
  await reload(page);
  await noLabels(page);
  assert.deepEqual(errors, []);
  await context.close();
});
