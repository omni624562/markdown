/**
 * Office 文件在 oMarker 的分頁裡唯讀檢視（app/office-view.ts）：檔案面板點 Word 檔，讀出內容（read_office）、
 * 轉成 HTML 顯示（經過白名單，危險的連結拿掉）；「用預設的程式開啟」「轉成 Markdown 編輯」。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import { open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\產品筆記";
const at = (name) => `${ROOT}\\${name}`;
const entry = (name) => ({ name, path: at(name), isDir: false });
const row = (page, name) => page.locator(`#file-tree .tree-row[data-path="${at(name).replace(/\\/g, "\\\\")}"]`);

async function wordFile() {
  const cell = (text) => new TableCell({ children: [new Paragraph(text)] });
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "系統設計書", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun({ text: "粗體的說明", bold: true }), new TextRun("，一般文字。")] }),
          new Paragraph({ children: [new ExternalHyperlink({ link: "javascript:alert(1)", children: [new TextRun("危險連結")] })] }),
          new Paragraph({ children: [new ExternalHyperlink({ link: "https://ado.test/wiki", children: [new TextRun("Wiki")] })] }),
          new Table({ rows: [new TableRow({ children: [cell("代碼"), cell("說明")] }), new TableRow({ children: [cell("0000"), cell("交易成功")] })] }),
        ],
      },
    ],
  });
  return (await Packer.toBuffer(doc)).toString("base64");
}

test("Word 檔：在分頁裡唯讀檢視（標題、粗體、表格、連結），危險的連結拿掉；可以用預設的程式開啟、轉成 Markdown 編輯", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: { $by: "path", values: { [ROOT]: [entry("README.md"), entry("系統設計書.docx")] } },
      read_office: { $base64: await wordFile() },
    },
  });
  await row(page, "系統設計書.docx").click();
  const content = page.locator(".office-view .office-view-content");
  await content.locator("h1").waitFor();
  assert.equal(await content.locator("h1").textContent(), "系統設計書");
  assert.equal(await content.locator("strong").first().textContent(), "粗體的說明");
  assert.deepEqual(await content.locator("td").allTextContents(), ["代碼", "說明", "0000", "交易成功"]);
  assert.equal(await content.locator('a[href^="javascript"]').count(), 0, "危險的連結拿掉");
  assert.equal(await content.locator('a[href="https://ado.test/wiki"]').count(), 1);
  assert.equal(await page.locator("#tab-bar .tab[aria-selected=true] .tab-name").textContent(), "系統設計書.docx");
  assert.deepEqual(await page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "read_office").map((c) => c.args.path)), [ROOT + "\\系統設計書.docx"]);
  assert.equal(await page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "reopen_file").length), 0, "不當成文字檔讀");

  await page.locator(".office-view-external").click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "open_with_default"));

  // 轉成 Markdown 編輯：開成新的分頁（還沒存檔），內容是轉好的 Markdown。
  await page.locator(".office-view-convert").click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "系統設計書.md");
  await page.waitForFunction(() => /系統設計書粗體的說明/.test(document.querySelector(".cm-content")?.textContent ?? ""));
  assert.deepEqual(errors, []);
  await context.close();
});

test("Excel、PowerPoint：還不在分頁裡檢視，交給預設的程式", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: { $by: "path", values: { [ROOT]: [entry("預算.xlsx")] } },
    },
  });
  await row(page, "預算.xlsx").click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "open_with_default"));
  assert.equal(await page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "reopen_file" || c.cmd === "read_office").length), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
