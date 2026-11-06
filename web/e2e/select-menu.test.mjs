/**
 * 下拉選單（<select>）的清單用 oMarker 自己的選單（ui/select-menu.ts）：一律留在視窗內，太高時可以捲動；
 * 滑鼠、鍵盤都能選，選了照常發出 change。Windows 上原生的清單可能開到螢幕外面被切掉，所以不用它。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const TEAMS = [
  { id: "t0", name: "產品團隊", default: true },
  ...Array.from({ length: 30 }, (_, i) => ({ id: `t${i + 1}`, name: `平台組 ${i + 1}`, default: false })),
  { id: "tc", name: "Contoso 小組", default: false },
];

async function openTeamSelect(height) {
  const opened = await open({
    desktop: {
      load_settings: JSON.stringify({ adoDefaultProject: "產品" }),
      ado_account: { url: "https://ado.test/c", name: "王小明", account: "CONTOSO\\wang" },
      ado_work_item_filters: { projects: ["產品", "Contoso"], kinds: [] },
      ado_teams: { $by: "project", values: { 產品: TEAMS } },
    },
  });
  const { page } = opened;
  await page.setViewportSize({ width: 1000, height });
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill("設定");
  await page.keyboard.press("Enter");
  await page.click("dialog[open] [role=tab]:has-text('Azure DevOps')");
  const select = page.locator("#setting-ado-default-team");
  await page.waitForFunction(() => document.querySelectorAll("#setting-ado-default-team option").length > 30);
  await select.scrollIntoViewIfNeeded();
  return { ...opened, select };
}

const menu = (page) => page.locator(".select-menu:popover-open");
const box = (locator) => locator.evaluate((el) => el.getBoundingClientRect().toJSON());

test("下拉選單：清單留在視窗內，太長時可以捲動；點一下選好，照常存進設定", async () => {
  const { page, context, errors, select } = await openTeamSelect(520);
  await select.click();
  await menu(page).waitFor();
  const r = await box(menu(page));
  assert.ok(r.top >= 0 && r.bottom <= 520, `清單在視窗內：${r.top}–${r.bottom}`);
  assert.ok(await menu(page).evaluate((el) => el.scrollHeight > el.clientHeight), "放不下的項目可以捲動");
  assert.equal(await menu(page).getAttribute("role"), "listbox");
  // 目前選的那一項打勾，焦點也在它上面。
  const selected = menu(page).locator("[role=option][aria-selected=true]");
  assert.equal(await selected.count(), 1);
  assert.equal(await selected.evaluate((el) => el === document.activeElement), true);
  // 捲到最下面那一項也點得到。
  const last = menu(page).getByRole("option", { name: "Contoso 小組" });
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await menu(page).waitFor({ state: "detached" });
  assert.equal(await select.inputValue(), "Contoso 小組");
  await page.waitForFunction(() =>
    window.__fake.calls.some((c) => c.cmd === "save_settings" && JSON.parse(c.args.json).adoDefaultTeam === "Contoso 小組"),
  );
  assert.equal(await select.evaluate((el) => el === document.activeElement), true, "選完焦點回到下拉選單");
  assert.deepEqual(errors, []);
  await context.close();
});

test("下拉選單：下面放不下就往上開；再按一次下拉選單是關掉", async () => {
  const { page, context, errors, select } = await openTeamSelect(800);
  // 下拉選單在設定的最下面：捲到底，它就在對話框（視窗）的下半部。
  await select.evaluate((el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight && /auto|scroll/.test(getComputedStyle(n).overflowY)) n.scrollTop = n.scrollHeight;
    }
  });
  const s = await box(select);
  assert.ok(s.top > 400, `下拉選單在視窗下半部：${s.top}`);
  await select.click();
  await menu(page).waitFor();
  const r = await box(menu(page));
  assert.ok(r.bottom <= 800 && r.top >= 0, "清單在視窗內");
  assert.ok(r.bottom <= s.top + 1, "下面放不下：往上開");
  await select.click();
  await menu(page).waitFor({ state: "detached" });
  assert.equal(await select.inputValue(), "");
  // 清單開著時選項換掉了（例如清單重新讀到）：關掉選單，不會選到別的。
  await select.click();
  await menu(page).waitFor();
  await select.evaluate((el) => el.append(new Option("後來才讀到的團隊", "後來才讀到的團隊")));
  await menu(page).waitFor({ state: "detached" });
  assert.equal(await select.inputValue(), "");
  assert.deepEqual(errors, []);
  await context.close();
});

test("下拉選單：鍵盤 Alt+↓ 打開，方向鍵與打字移動，Enter 選；Esc 取消不改", async () => {
  const { page, context, errors, select } = await openTeamSelect(800);
  await select.focus();
  const expected = await select.evaluate((el) => el.options[el.selectedIndex + 2].value);
  await page.keyboard.press("Alt+ArrowDown");
  await menu(page).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await menu(page).waitFor({ state: "detached" });
  assert.equal(await select.inputValue(), expected);
  // 空白鍵也能打開；打字跳到開頭相符的項目。
  await page.keyboard.press(" ");
  await menu(page).waitFor();
  await page.keyboard.type("co");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Contoso 小組");
  await page.keyboard.press("Escape");
  await menu(page).waitFor({ state: "detached" });
  assert.equal(await select.inputValue(), expected);
  assert.equal(await page.locator("dialog[open]").count(), 1, "Esc 只關掉清單，設定還開著");
  // 停用的下拉選單打不開。
  await page.locator("#setting-ado-default-project").selectOption("");
  await page.locator("#setting-ado-default-team").click({ force: true });
  await page.waitForTimeout(100);
  assert.equal(await menu(page).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
