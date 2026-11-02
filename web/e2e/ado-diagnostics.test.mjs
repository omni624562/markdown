/**
 * Azure DevOps 診斷資料：指令列「儲存診斷資料」呼叫原生端存檔，存好提示路徑（用假的原生端，見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

test("儲存診斷資料：存好後提示檔案位置", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_diagnostics_save: "C:\\Users\\me\\oMarker-ADO-diagnostics.json",
    },
  });
  // 桌面版沒有開著的文件時是歡迎畫面：直接按快速鍵開指令面板。
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill("儲存診斷資料");
  await page.keyboard.press("Enter");
  await page.locator(".toast", { hasText: "已儲存診斷資料：C:\\Users\\me\\oMarker-ADO-diagnostics.json" }).waitFor();
  assert.ok((await calls(page)).some((c) => c.cmd === "ado_diagnostics_save"));
  assert.deepEqual(errors, []);
  await context.close();
});
