/**
 * 頂端列樣式（設定 → 外觀 → 版面）：
 * - 專案列（預設）：側邊欄開著時，專案與分支在左上（檔案面板上方改寫「檔案」），右邊的按鈕前一條分隔線。
 * - 版面切換鈕組：左上是快速開啟、最近開啟；左側欄開關搬到右邊和「⋯」一組，開著時白底。
 * - 窄視窗兩種都不搬：專案留在檔案面板，側邊欄按鈕在左上角。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand } from "./helpers.mjs";

async function pick(page, value) {
  await runCommand(page, "設定");
  await page.click("dialog[open] [role=tab]:has-text('外觀')");
  await page.locator("dialog[open]").getByLabel("頂端列樣式").selectOption(value);
  await page.waitForFunction((v) => document.documentElement.dataset.topbarStyle === v, value);
  await page.keyboard.press("Escape");
}

/** 目前各個元素放在哪裡。 */
const where = (page) =>
  page.evaluate(() => {
    const topbar = document.querySelector(".topbar");
    const nav = document.querySelector(".nav-toggle");
    const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    return {
      projectUp: !!document.querySelector(".topbar-project .project-switch"),
      branchUp: !!document.querySelector(".topbar-project #folder-branch"),
      projectInPanel: !!document.querySelector("#panel-files .project-head .project-switch"),
      branchAfterHead: document.querySelector("#folder-branch")?.previousElementSibling?.classList.contains("side-head") ?? false,
      filesLabel: !document.querySelector(".project-head-label")?.hidden,
      navFirst: topbar.firstElementChild === nav,
      navInActions: nav.parentElement?.classList.contains("top-actions") ?? false,
      divider: getComputedStyle(document.querySelector(".top-actions"), "::before").content,
      tools: visible(document.querySelector(".topbar-tools")),
      quickOpen: visible(document.querySelector(".topbar-tools [data-command='quick-open']")),
      navBg: getComputedStyle(nav).backgroundColor,
      navPressed: nav.getAttribute("aria-pressed"),
    };
  });

test("頂端列樣式：專案列與版面切換鈕組可以切換，窄視窗維持原樣", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await page.setViewportSize({ width: 1280, height: 720 });
  // 先打字讓起始頁收起來（開設定要點編輯區）。
  await page.focus(".cm-content");
  await page.keyboard.type("# 標題");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.topbarStyle), "project", "預設是專案列");
  await page.locator(".nav-toggle").click();
  await page.waitForFunction(() => document.querySelector(".topbar").classList.contains("with-sidebar"));

  let at = await where(page);
  assert.ok(at.projectUp && at.branchUp, "專案列：專案與分支在左上");
  assert.ok(!at.projectInPanel, "檔案面板上方不再有專案");
  assert.ok(at.filesLabel, "檔案面板上方改寫「檔案」");
  assert.ok(at.navFirst, "側邊欄按鈕在左上角");
  assert.equal(at.navPressed, "true");
  assert.notEqual(at.divider, "none", "右邊的按鈕前有分隔線");
  assert.ok(!at.tools, "專案列沒有快速開啟、最近開啟");

  await pick(page, "layout");
  at = await where(page);
  assert.ok(at.projectInPanel && at.branchAfterHead, "版面切換鈕組：專案與分支回到檔案面板");
  assert.ok(!at.filesLabel);
  assert.ok(at.navInActions && !at.navFirst, "左側欄開關搬到右邊的鈕組");
  assert.equal(at.divider, "none", "鈕組有底色，不用分隔線");
  assert.ok(at.tools && at.quickOpen, "左上是快速開啟、最近開啟");
  assert.notEqual(at.navBg, "rgba(0, 0, 0, 0)", "開著的側邊欄開關是白底");
  await page.locator(".topbar-tools [data-command='quick-open']").click();
  await page.locator("dialog.palette[open]").waitFor();
  await page.keyboard.press("Escape");

  // 窄視窗：兩種樣式都維持原樣。
  await page.setViewportSize({ width: 600, height: 720 });
  await page.waitForFunction(() => document.querySelector(".topbar").firstElementChild === document.querySelector(".nav-toggle"));
  await pick(page, "project");
  at = await where(page);
  assert.ok(at.navFirst && at.projectInPanel && !at.projectUp, "窄視窗：側邊欄按鈕在左上角，專案留在檔案面板");

  // 回到寬視窗，專案又搬上去。
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForFunction(() => !!document.querySelector(".topbar-project .project-switch"));
  assert.deepEqual(errors, []);
  await context.close();
});
