/**
 * 設定對話框的分類：外觀與版面分開、Git 與 GitHub 合併、Azure DevOps 沒連線時不留空卡片、關於只寫一次版本號
 * （桌面版用假的原生端，見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand } from "./helpers.mjs";

/** 左邊分類的名稱。 */
const tabNames = (page) => page.locator("dialog[open] [role=tab]").allTextContents();

/** 目前這一頁看得到的選項名稱。 */
const visibleLabels = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("dialog[open] .settings-body section:not([hidden]) .settings-row label")]
      .filter((l) => l.offsetParent)
      .map((l) => l.textContent),
  );

/** 桌面版沒有開著的文件時是歡迎畫面：直接按快速鍵開指令面板。 */
async function desktopCommand(page, query) {
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill(query);
  await page.keyboard.press("Enter");
}

test("設定：外觀只放配色、字型與文件內容，分頁樣式與左側圖示列在「版面」；搜尋找得到搬過去的選項", async () => {
  const { page, context, errors } = await open();
  await runCommand(page, "設定");
  // 設定對話框第一次打開時才載入：等它出現。
  await page.locator("dialog[open].settings").waitFor();
  const names = await tabNames(page);
  assert.ok(names.indexOf("版面") === names.indexOf("外觀") + 1, names.join("、"));

  await page.click("dialog[open] [role=tab]:has-text('外觀')");
  const look = await visibleLabels(page);
  for (const label of ["配色風格", "明暗", "內文字型", "顯示數學公式"]) assert.ok(look.includes(label), `外觀少了「${label}」：${look}`);
  for (const label of ["分頁樣式", "行距", "圖示與順序"]) assert.ok(!look.includes(label), `外觀不該有「${label}」`);

  await page.click("dialog[open] [role=tab]:has-text('版面')");
  const layout = await visibleLabels(page);
  for (const label of ["分頁樣式", "行距", "文字欄寬", "固定顯示格式工具列", "圖示與順序"]) assert.ok(layout.includes(label), `版面少了「${label}」：${layout}`);

  // 搜尋：跨分類找得到搬過去的選項，所在的分類一起顯示。
  await page.fill("dialog[open] .settings-search", "分頁樣式");
  assert.deepEqual(await visibleLabels(page), ["分頁樣式"]);
  // 依狀態藏起來的列（內文字型不是「自訂」時的自訂字型），清掉搜尋後仍然藏著。
  await page.fill("dialog[open] .settings-search", "字型");
  await page.fill("dialog[open] .settings-search", "");
  await page.click("dialog[open] [role=tab]:has-text('外觀')");
  assert.ok(!(await visibleLabels(page)).includes("自訂內文字型"));
  assert.ok(await page.locator("#setting-docFont").isVisible());
  assert.deepEqual(errors, []);
  await context.close();
});

test("設定（桌面版）：Git 與 GitHub 同一頁、Azure DevOps 一行排得下且沒連線時不留空卡片、版本號只寫一次", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await desktopCommand(page, "設定");
  await page.locator("dialog[open].settings").waitFor();
  const names = await tabNames(page);
  assert.ok(names.includes("Git 與 GitHub"), names.join("、"));
  assert.ok(!names.includes("Git") && !names.includes("GitHub"), names.join("、"));
  assert.ok(names.includes("Azure DevOps"), names.join("、"));

  // 每個分類名稱都排在一行（「Azure DevOps／TFS」以前會折成兩行）。
  const lines = await page.$$eval("dialog[open] [role=tab]", (tabs) =>
    tabs.map((b) => {
      const range = document.createRange();
      range.selectNodeContents(b.lastChild);
      return [b.textContent, new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size];
    }),
  );
  assert.deepEqual(lines.filter(([, n]) => n !== 1), [], JSON.stringify(lines));

  // 一次性的動作（下載、上傳儲存庫、顯示工作項目）不放在設定裡；帳號的登入還在。
  await page.click("dialog[open] [role=tab]:has-text('Git 與 GitHub')");
  const git = await visibleLabels(page);
  assert.deepEqual(git, ["自動同步", "同步頻率", "GitHub 帳號"]);
  assert.ok(await page.locator("#setting-github").isVisible());
  for (const id of ["github-open", "github-publish", "ado-open", "ado-items"]) assert.equal(await page.locator(`#setting-${id}`).count(), 0, id);

  // 還沒連線：只有連線的欄位，「工作項目」那一組連小標題一起藏起來，不留一張空卡片。
  await page.click("dialog[open] [role=tab]:has-text('Azure DevOps')");
  assert.deepEqual(await visibleLabels(page), ["伺服器網址", "個人存取權杖（PAT）", "連線"]);
  const section = page.locator("dialog[open] section:not([hidden])");
  assert.equal(await section.locator(".settings-group-title:visible").allTextContents().then((t) => t.join()), "連線");
  assert.equal(await section.locator(".settings-group:visible").count(), 1);

  // 關於：版本號只出現一次（在「更新」那一列，旁邊是「檢查更新」）。
  await page.click("dialog[open] [role=tab]:has-text('關於')");
  await page.locator("dialog[open] label[for=setting-version]", { hasText: "版本 0.0.0" }).waitFor();
  const about = await page.locator("dialog[open] section:not([hidden])").innerText();
  assert.equal(about.match(/版本 0\.0\.0/g)?.length, 1, about);

  // 指令「Azure DevOps：連線設定…」（和工作項目面板的「開啟連線設定」一樣）到 Azure DevOps 頁。
  await page.keyboard.press("Escape");
  await desktopCommand(page, "Azure DevOps：連線設定");
  await page.locator("dialog[open] [role=tab][aria-selected=true]", { hasText: "Azure DevOps" }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("設定（桌面版）：在設定連上 Azure DevOps 後，才出現工作項目的通知與類型顏色", async () => {
  const { page, context, errors } = await open({
    desktop: { ado_connect: { url: "https://ado.test/c", name: "王小明" } },
  });
  await desktopCommand(page, "設定");
  await page.click("dialog[open] [role=tab]:has-text('Azure DevOps')");
  const section = page.locator("dialog[open] section:not([hidden])");
  assert.equal(await section.locator(".settings-group-title:visible", { hasText: "工作項目" }).count(), 0);
  await page.fill("#setting-ado-url", "https://ado.test/c");
  await page.fill("#setting-ado-pat", "token");
  await page.click("#setting-ado-connect");
  await section.locator(".settings-group-title", { hasText: "工作項目" }).waitFor();
  const labels = await visibleLabels(page);
  for (const label of ["帳號", "新指派給我時通知", "工作項目類型的顏色"]) assert.ok(labels.includes(label), labels.join("、"));
  assert.ok(!labels.includes("伺服器網址"));
  // 搜尋再清掉：依狀態藏起來的網址與權杖欄位不會跑出來。
  await page.fill("dialog[open] .settings-search", "權杖");
  await page.fill("dialog[open] .settings-search", "");
  assert.ok(!(await visibleLabels(page)).includes("伺服器網址"));
  assert.deepEqual(errors, []);
  await context.close();
});
