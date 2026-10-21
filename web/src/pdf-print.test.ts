import assert from "node:assert/strict";
import { test } from "node:test";
import { type PdfOptions, coverHtml, cssString, pageCss, pageLayout, shadowCss } from "./pdf-print.ts";

const OPTS: PdfOptions = { header: "十月週報", pageNumbers: true, cover: false, subtitle: "", paper: "A4" };

test("頁首、頁碼與紙張", () => {
  const css = pageCss(OPTS);
  assert.match(css, /size: 210mm 297mm/);
  assert.match(css, /@top-left \{ content: "十月週報"/);
  assert.match(css, /counter\(page\) " 頁，共 " counter\(pages\)/);
  assert.doesNotMatch(css, /:first/);
  const bare = pageCss({ ...OPTS, header: " ", pageNumbers: false, paper: "Letter" });
  assert.doesNotMatch(bare, /@top-left|@bottom-center/);
  assert.match(bare, /size: 215.9mm 279.4mm/);
});

test("有封面時第一頁不顯示頁首與頁碼", () => {
  assert.match(pageCss({ ...OPTS, cover: true }), /@page :first \{ @top-left \{ content: none; \}/);
  const html = coverHtml({ ...OPTS, cover: true, subtitle: "業務部 <小明>" }, "十月週報", "2026-10-21");
  assert.match(html, /<h1>十月週報<\/h1>/);
  assert.match(html, /業務部 &lt;小明&gt;/);
  assert.match(html, new RegExp(`height:${Math.round((297 - 20 - 20) * 0.85)}mm`));
});

test("跳脫與 Shadow DOM 樣式", () => {
  assert.equal(cssString('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(shadowCss(':root { --x: 1 } :root[data-theme="light"] { a: b } :root[data-theme="dark"] { c: d }'), ':host { --x: 1 } :host { a: b } :host(.never-dark) { c: d }');
  assert.equal(pageLayout({ ...OPTS, paper: "A5" }).marginSideMm, 12);
});
