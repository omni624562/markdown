/**
 * Office 文件在 oMarker 的分頁裡唯讀檢視（app/office-view.ts）：檔案面板點 Word、Excel、PowerPoint 檔，
 * 讀出內容（read_office）、轉成 HTML 顯示（經過白名單，危險的連結拿掉）；「用預設的程式開啟」「轉成 Markdown 編輯」。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import JSZip from "jszip";
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

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const rels = (...items) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`;

async function excelFile() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("xl/workbook.xml", `<workbook ${NS}><sheets><sheet name="預算" sheetId="1" r:id="rId1"/><sheet name="隱藏" sheetId="2" state="hidden" r:id="rId2"/><sheet name="摘要" sheetId="3" r:id="rId3"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", rels(rel("rId1", "worksheet", "worksheets/sheet1.xml"), rel("rId2", "worksheet", "worksheets/sheet2.xml"), rel("rId3", "worksheet", "worksheets/sheet3.xml")));
  zip.file("xl/sharedStrings.xml", `<sst ${NS}><si><t>項目</t></si><si><t>金額</t></si><si><t>日期</t></si><si><r><t>王小明</t></r><r><t>的差旅</t></r></si><si><t>合計</t></si></sst>`);
  zip.file("xl/styles.xml", `<styleSheet ${NS}><numFmts><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="9"/></cellXfs></styleSheet>`);
  zip.file("xl/worksheets/sheet1.xml", `<worksheet ${NS}><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="str"><v>比例</v></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1234.5</v></c><c r="C2" s="1"><v>46224</v></c><c r="D2" s="2"><v>0.25</v></c></row>
    <row r="3"><c r="A3" t="s"><v>4</v></c><c r="C3"><f>SUM(B2)</f><v>0.30000000000000004</v></c></row>
  </sheetData><mergeCells><mergeCell ref="A3:B3"/></mergeCells></worksheet>`);
  zip.file("xl/worksheets/sheet2.xml", `<worksheet ${NS}><sheetData/></worksheet>`);
  zip.file("xl/worksheets/sheet3.xml", `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>李大同</t></is></c><c r="B1" t="b"><v>1</v></c></row></sheetData></worksheet>`);
  return (await zip.generateAsync({ type: "nodebuffer" })).toString("base64");
}

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
async function powerPointFile() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("ppt/presentation.xml", `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", rels(rel("rId2", "slide", "slides/slide1.xml"), rel("rId3", "slide", "slides/slide2.xml")));
  const title = (text) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const bullets = (...items) => `<p:sp><p:nvSpPr><p:cNvPr id="3" name="b"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody>${items.map(([t, lvl]) => `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ""}<a:r><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
  zip.file("ppt/slides/slide1.xml", `<p:sld ${P}><p:cSld><p:spTree>${title("產品介紹")}${bullets(["第一點", 0], ["補充說明", 1])}<p:pic><p:nvPicPr><p:cNvPr id="4" name="圖" descr="架構圖"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId9"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", rels(rel("rId9", "image", "../media/image1.png")));
  zip.file("ppt/media/image1.png", PNG, { base64: true });
  zip.file("ppt/slides/slide2.xml", `<p:sld ${P}><p:cSld><p:spTree>${title("時程")}<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>階段</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>日期</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>上線</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>12 月</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`);
  return (await zip.generateAsync({ type: "nodebuffer" })).toString("base64");
}

test("Excel 檔：每個工作表一個頁籤（隱藏的不顯示），數字、日期、百分比、合併儲存格；可以複製、轉成 Markdown 表格", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: { $by: "path", values: { [ROOT]: [entry("預算.xlsx")] } },
      read_office: { $base64: await excelFile() },
    },
  });
  await row(page, "預算.xlsx").click();
  const view = page.locator(".office-view .office-view-content");
  await view.locator(".office-sheet table").waitFor();
  assert.deepEqual(await view.locator(".office-sheet-tabs button").allTextContents(), ["預算", "摘要"]);
  const cells = await view.locator(".office-sheet td").allTextContents();
  assert.deepEqual(cells.slice(0, 8), ["項目", "金額", "日期", "比例", "王小明的差旅", "1234.5", "2026/07/21", "25%"]);
  assert.equal(await view.locator('.office-sheet td[colspan="2"]').textContent(), "合計", "合併儲存格");
  assert.ok(cells.includes("0.3"), "浮點數尾巴去掉");
  await view.locator(".office-sheet-tabs button", { hasText: "摘要" }).click();
  assert.deepEqual(await view.locator(".office-sheet td").allTextContents(), ["李大同", "TRUE"]);
  await view.locator(".office-sheet-tabs button", { hasText: "預算" }).click();
  await view.locator(".office-sheet-markdown").click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "預算-預算.md");
  await page.click('.statusbar [data-view="editor"]');
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("| 項目 | 金額 | 日期 | 比例 |"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("PowerPoint 檔：逐張投影片列出標題、文字（照縮排）、表格與圖片", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: { $by: "path", values: { [ROOT]: [entry("簡報.pptx")] } },
      read_office: { $base64: await powerPointFile() },
    },
  });
  await row(page, "簡報.pptx").click();
  const slides = page.locator(".office-view .office-slide");
  await slides.first().waitFor();
  assert.equal(await slides.count(), 2);
  assert.deepEqual(await slides.locator("h2").allTextContents(), ["產品介紹", "時程"]);
  assert.deepEqual(await slides.first().locator("li").allTextContents(), ["第一點", "補充說明"]);
  assert.equal(await slides.first().locator("li.office-level-1").textContent(), "補充說明");
  assert.match(await slides.first().locator("img").getAttribute("src"), /^data:image\/png;base64,/);
  assert.equal(await slides.first().locator("img").getAttribute("alt"), "架構圖");
  assert.deepEqual(await slides.nth(1).locator("td").allTextContents(), ["階段", "日期", "上線", "12 月"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("Outlook 郵件（.msg）：主旨、寄件人、收件人、副本、HTML 內文（內嵌圖片、危險內容拿掉）與附件清單", async () => {
  const { mailFile } = await import("./msg-fixture.mjs");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: { $by: "path", values: { [ROOT]: [entry("上線時程確認.msg")] } },
      read_office: { $base64: mailFile({ png }) },
    },
  });
  await row(page, "上線時程確認.msg").click();
  const view = page.locator(".office-view .office-view-content");
  await view.locator(".office-mail-head h2").waitFor();
  assert.equal(await view.locator(".office-mail-head h2").textContent(), "上線時程確認");
  const fields = await view.locator(".office-mail-head dt, .office-mail-head dd").allTextContents();
  assert.deepEqual(fields, ["寄件人", "王小明 <ming@ado.test>", "收件人", "李大同 <datong@ado.test>", "副本", "陳小華 <hua@ado.test>"]);
  assert.equal(await view.locator(".office-mail-body b").textContent(), "上線時程");
  assert.match(await view.locator(".office-mail-body img").getAttribute("src"), /^data:image\/png;base64,/, "cid: 內嵌圖片換成 data:");
  assert.equal(await view.locator('.office-mail-body a[href^="javascript"]').count(), 0);
  assert.equal(await view.locator(".office-mail-body script, .office-mail-body style").count(), 0);
  assert.deepEqual(await view.locator(".office-mail-attachments li").allTextContents(), ["規格書.pdf（21 B）"], "內嵌圖片不重複列在附件");
  assert.deepEqual(errors, []);
  await context.close();
});
