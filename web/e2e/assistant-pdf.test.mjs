/**
 * 助理附 PDF 提問（app/assistant.ts）：用迴紋針或拖進輸入區附上 PDF，和問題一起送出；之後接著問也帶著同一份
 * （附在對話的第一則訊息，前面的內容不變才用得到快取），直到按 × 或開新對話。不是 PDF、太大、太多份都會提示。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\旅遊";
const desktop = {
  startup_target: { kind: "folder", path: ROOT, name: "旅遊" },
  list_dir: { $by: "path", values: { [ROOT]: [] } },
  load_settings: JSON.stringify({ claudeApiEnabled: true, assistantProjects: [ROOT], assistantConfirmed: [ROOT] }),
  assistant_key_status: true,
  assistant_usage: { month: "2026-11", usd: 0, limit: 10 },
};
// 兩頁的小 PDF（只要開頭是 %PDF-，裡面有兩個頁面物件）。
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type /Pages>>\n2 0 obj<</Type /Page>>\n3 0 obj<</Type /Page>>\n%%EOF\n");
const pdfFile = (name) => ({ name, mimeType: "application/pdf", buffer: PDF });

const sends = async (page) => (await calls(page)).filter((c) => c.cmd === "assistant_send").map((c) => c.args);
async function reply(page, text) {
  const [{ id }] = (await sends(page)).slice(-1);
  await page.evaluate(
    ([id, text]) => {
      window.__fake.emit("assistant-run", { kind: "delta", id, text });
      window.__fake.emit("assistant-run", { kind: "done", id, usd: 0.01, monthUsd: 0.01, stop: null });
    },
    [id, text],
  );
}
async function setup() {
  const opened = await open({ desktop });
  const { page } = opened;
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 行程\n");
  await page.keyboard.press("Control+Shift+L");
  await page.locator("#assistant-panel textarea").waitFor();
  return opened;
}
const ask = async (page, text, n) => {
  await page.locator("#assistant-panel textarea").fill(text);
  await page.locator("#assistant-panel textarea").press("Enter");
  await page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "assistant_send").length === n, n);
  return (await sends(page))[n - 1].request;
};
const pdfChips = (page) => page.locator("#assistant-panel .assistant-chip-pdf");

test("用迴紋針附 PDF：和問題一起送出；接著問也帶著（附在第一則訊息）；按 × 之後不再送", async () => {
  const { page, context, errors } = await setup();
  assert.match(await page.locator("#assistant-panel input[type=file]").getAttribute("accept"), /application\/pdf/);
  await page.locator("#assistant-panel input[type=file]").setInputFiles(pdfFile("租約.pdf"));
  await pdfChips(page).waitFor();
  assert.match(await pdfChips(page).textContent(), /租約\.pdf.*約 2 頁/);
  // 第一次附的時候說明一次：會一直帶著、依頁數計費。
  await page.locator(".toast", { hasText: "依頁數計費" }).waitFor();

  const first = await ask(page, "這份租約的重點？", 1);
  assert.equal(first.messages.length, 1);
  assert.deepEqual(first.messages[0].images, [{ mediaType: "application/pdf", data: PDF.toString("base64") }]);
  assert.match(await page.locator("#assistant-panel .assistant-user").last().textContent(), /附上 租約\.pdf/);
  await reply(page, "重點是租期一年。");
  // 送出之後 PDF 還在（圖片送出後會拿掉，PDF 不會）。
  assert.equal(await pdfChips(page).count(), 1);

  const second = await ask(page, "押金多少？", 2);
  assert.equal(second.messages.length, 3);
  assert.deepEqual(second.messages[0].images, [{ mediaType: "application/pdf", data: PDF.toString("base64") }], "附在第一則訊息");
  assert.equal(second.messages[2].images, undefined);
  await reply(page, "兩個月。");

  await pdfChips(page).locator(".assistant-chip-x").click();
  assert.equal(await pdfChips(page).count(), 0);
  const third = await ask(page, "還有別的嗎？", 3);
  assert.ok(third.messages.every((m) => !m.images?.length));
  assert.deepEqual(errors, []);
  await context.close();
});

test("把 PDF 拖進輸入區：附到問題上，不會被當成要開啟的檔案；開新對話就拿掉", async () => {
  const { page, context, errors } = await setup();
  const data = await page.evaluateHandle((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], "行程表.pdf", { type: "application/pdf" }));
    return dt;
  }, [...PDF]);
  const box = page.locator("#assistant-panel .assistant-input");
  await box.dispatchEvent("dragenter", { dataTransfer: data });
  // 拖到輸入區上時，提示是「附到問題上」，不是「開啟」。
  assert.equal(await page.locator(".drop-overlay strong").textContent(), "放開以附到問題上");
  await box.dispatchEvent("dragover", { dataTransfer: data });
  await box.dispatchEvent("drop", { dataTransfer: data });
  await pdfChips(page).waitFor();
  assert.match(await pdfChips(page).textContent(), /行程表\.pdf/);
  // 沒有開成新的分頁。
  assert.equal(await page.locator("#tab-bar .tab", { hasText: "行程表" }).count(), 0);
  await page.locator('#assistant-panel [data-action="new-chat"], #assistant-panel button[title*="新對話"]').first().click();
  assert.equal(await pdfChips(page).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("不是 PDF 的內容、超過 2 份：提示，不附上", async () => {
  const { page, context, errors } = await setup();
  const file = page.locator("#assistant-panel input[type=file]");
  await file.setInputFiles({ name: "假的.pdf", mimeType: "application/pdf", buffer: Buffer.from("這不是 PDF") });
  await page.locator(".toast", { hasText: "不是 PDF 檔" }).waitFor();
  assert.equal(await pdfChips(page).count(), 0);
  await file.setInputFiles([pdfFile("一.pdf"), pdfFile("二.pdf"), pdfFile("三.pdf")]);
  await page.locator(".toast", { hasText: "一次最多附 2 份 PDF" }).waitFor();
  assert.equal(await pdfChips(page).count(), 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test("只附 PDF、沒打字：按送出照樣送出（請 Claude 看附上的檔案）；送過之後空白送出不會再送", async () => {
  const { page, context, errors } = await setup();
  await page.locator("#assistant-panel input[type=file]").setInputFiles(pdfFile("租約.pdf"));
  await pdfChips(page).waitFor();
  await page.locator("#assistant-panel .assistant-send").click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  const [{ request }] = await sends(page);
  assert.equal(request.messages[0].content.trim().endsWith("請看附上的檔案。"), true, request.messages[0].content);
  assert.deepEqual(request.messages[0].images, [{ mediaType: "application/pdf", data: PDF.toString("base64") }]);
  await reply(page, "這是一份租約。");
  // PDF 還帶著，但已經送過：空白按送出不會再送一次。
  await page.locator("#assistant-panel .assistant-send").click();
  await page.waitForTimeout(200);
  assert.equal((await sends(page)).length, 1);
  assert.deepEqual(errors, []);
  await context.close();
});
