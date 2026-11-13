/**
 * 指令面板的分類：Git 的指令都在「Git」、Azure DevOps 的都在「Azure DevOps」（緊接在 Git 後面），
 * 同一個指令只出現一次；設定裡留著已經拿掉的指令（釘在圖示列、自訂快速鍵）時安靜地忽略。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const REPO = {
  available: true,
  repo: true,
  trusted: true,
  branch: { name: "main", upstream: null, ahead: 0, behind: 0 },
  changes: [],
  remote: null,
  merging: false,
};

/** 沒有輸入時的指令面板：依序列出每個指令的標題與所在的分類。 */
async function paletteEntries(page) {
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  const entries = await page.evaluate(() => {
    const out = [];
    let section = "";
    for (const li of document.querySelectorAll("dialog[open] li")) {
      if (li.classList.contains("palette-section")) section = li.textContent;
      else if (li.getAttribute("role") === "option") out.push({ title: li.querySelector(".palette-title").textContent, section });
    }
    return out;
  });
  await page.keyboard.press("Escape");
  return entries;
}

test("指令面板：Git 與 Azure DevOps 各自一區，提交只出現一次，重複的入口拿掉了", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: ROOT,
      list_dir: { $by: "path", values: { "/notes": [] } },
      git_status: REPO,
      ado_account: { url: "https://ado.test/c", name: "王小明" },
    },
  });
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "git_status"));
  // 等 Git 狀態讀進來（提交、拉取、推送要有儲存庫才會列出）。
  let entries = [];
  for (let i = 0; i < 20 && !entries.some((e) => e.title === "Git：提交變更…"); i++) {
    entries = await paletteEntries(page);
    if (!entries.some((e) => e.title === "Git：提交變更…")) await page.waitForTimeout(200);
  }
  const sectionOf = (title) => entries.filter((e) => e.title === title).map((e) => e.section);
  assert.deepEqual(sectionOf("Git：提交變更…"), ["Git"]);
  assert.deepEqual(sectionOf("Git：拉取"), ["Git"]);
  assert.deepEqual(sectionOf("Git：推送"), ["Git"]);
  for (const title of [
    "開啟工作項目…",
    "Azure DevOps：工作項目",
    "Azure DevOps：建立工作項目…",
    "Azure DevOps：把診斷資料存檔…",
    "顯示工作板（Azure DevOps）",
  ]) {
    assert.deepEqual(sectionOf(title), ["Azure DevOps"], title);
  }
  // 「Azure DevOps」緊接在「Git」後面。
  const sections = [...new Set(entries.map((e) => e.section))];
  assert.equal(sections[sections.indexOf("Git") + 1], "Azure DevOps", sections.join("、"));
  // 同一個標題只出現一次；跟別的指令重複的入口拿掉了。
  const titles = entries.map((e) => e.title);
  assert.deepEqual(
    titles.filter((t, i) => titles.indexOf(t) !== i),
    [],
  );
  assert.ok(!titles.includes("自訂快速鍵…"));
  assert.ok(!titles.includes("顯示搜尋"));
  assert.ok(titles.includes("說明：快速鍵一覽"));
  assert.ok(titles.includes("在資料夾中搜尋"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("設定裡釘了或自訂了已經拿掉的指令：不顯示、不報錯，也不說設定檔有問題", async () => {
  const { page, context, errors } = await open({
    desktop: {
      load_settings: JSON.stringify({
        activityCommands: ["show-search", "customize-shortcuts", "git-history"],
        keybindings: { "customize-shortcuts": "Mod-Alt-k", "show-search": "Mod-Alt-y" },
      }),
    },
  });
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".activity-cmd[data-command=show-search], .activity-cmd[data-command=customize-shortcuts]").count(), 0);
  assert.equal(await page.locator(".toast", { hasText: "設定檔" }).count(), 0);
  // 原本自訂給拿掉的指令的快速鍵：按了什麼都不會發生。
  await page.keyboard.press("Control+Alt+K");
  await page.keyboard.press("Control+Alt+Y");
  assert.equal(await page.locator("dialog[open]").count(), 0);
  // 設定的「圖示列」只列出還在的指令。
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill("圖示列：自訂");
  await page.keyboard.press("Enter");
  await page.locator("dialog[open] .activity-setting-name").first().waitFor();
  const names = await page.locator("dialog[open] .activity-setting-name").allTextContents();
  assert.ok(names.includes("Git：顯示歷史（線圖）"), names.join("、"));
  assert.deepEqual(
    names.filter((n) => /show-search|customize-shortcuts|自訂快速鍵|顯示搜尋/.test(n)),
    [],
  );
  assert.equal(await page.locator(".toast", { hasText: "設定檔" }).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("單選的指令：指令面板和主選單一樣，在目前選的那一項打勾，換了之後勾跟著移動", async () => {
  const { page, context, errors } = await open();
  await page.locator(".cm-content").waitFor();
  /** 搜尋「明暗」，回傳每一項的名稱和有沒有打勾。 */
  const themes = async () => {
    await page.keyboard.press("Control+Shift+P");
    const input = page.locator("dialog[open] input").first();
    await input.waitFor();
    await input.fill("明暗");
    await page.locator("dialog[open] [role=option]").first().waitFor();
    const out = await page.$$eval("dialog[open] [role=option]", (lis) =>
      lis.map((li) => ({ title: li.querySelector(".palette-title").textContent, current: !!li.querySelector(".palette-current") })),
    );
    return out;
  };
  let list = await themes();
  assert.deepEqual(list.filter((x) => x.current).map((x) => x.title), ["明暗：跟隨系統"]);
  assert.equal(list.length, 3);
  // 選「深色」：關掉後再打開，勾在「深色」。
  await page.locator("dialog[open] [role=option]", { hasText: "明暗：深色" }).click();
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  list = await themes();
  assert.deepEqual(list.filter((x) => x.current).map((x) => x.title), ["明暗：深色"]);
  // 讀螢幕軟體唸得到「目前」。
  assert.match(await page.locator("dialog[open] [role=option]", { hasText: "明暗：深色" }).textContent(), /目前/);
  await page.keyboard.press("Escape");
  // 主選單的「外觀」也是同一項打勾。
  await page.locator("#main-menu").click();
  await page.locator(".menu:popover-open button", { hasText: "外觀" }).hover();
  await page.locator('.menu:popover-open [role=menuitemradio][aria-checked="true"]', { hasText: "深色" }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});
