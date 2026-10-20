import assert from "node:assert/strict";
import { test } from "node:test";
import { hasStructure, htmlToMarkdown, pasteAsMarkdown } from "./html-paste.ts";

test("標題、清單、粗體、連結", () => {
  const md = htmlToMarkdown(
    '<h2>會議記錄</h2><p>這是<strong>重點</strong>，詳見<a href="https://example.com">網站</a>。</p><ul><li>第一項</li><li>第二項</li></ul>',
  );
  assert.equal(md, "## 會議記錄\n\n這是**重點**，詳見[網站](https://example.com)。\n\n- 第一項\n- 第二項");
});

test("Google 文件：外層的 <b> 不是粗體，粗體在 span 的樣式裡", () => {
  const html =
    '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-123"><p dir="ltr"><span style="font-weight:400;">一般</span><span style="font-weight:700;">粗體</span><span style="font-style:italic;">斜體</span></p></b>';
  assert.equal(htmlToMarkdown(html), "一般**粗體***斜體*");
});

test("表格轉成 GFM，第一列當標題列，儲存格中的 | 會跳脫", () => {
  const html =
    "<table><tbody><tr><td>品項</td><td>數量</td></tr><tr><td>蘋果 | 紅</td><td>3</td></tr><tr><td colspan=\"2\">合計</td></tr></tbody></table>";
  assert.equal(htmlToMarkdown(html), "| 品項 | 數量 |\n| --- | --- |\n| 蘋果 \\| 紅 | 3 |\n| 合計 | |");
});

test("腳本、樣式、表單與危險連結一律移除", () => {
  const md = htmlToMarkdown(
    '<p>安全</p><script>alert(1)</script><style>p{}</style><form><input value="x"></form><p><a href="javascript:alert(1)">點我</a></p><img src="file:///C:/tmp/a.png" alt="截圖"><img src="https://example.com/a.png" alt="圖">',
  );
  assert.ok(!md.includes("alert"));
  assert.ok(!md.includes("javascript"));
  assert.ok(!md.includes("file:"));
  assert.match(md, /點我/);
  assert.match(md, /截圖/);
  assert.match(md, /!\[圖\]\(https:\/\/example\.com\/a\.png\)/);
});

test("Word 清單：拿掉寫死的項目符號", () => {
  const html =
    "<p class=MsoListParagraphCxSpFirst><span style='mso-list:Ignore'>·<span>&nbsp;&nbsp;</span></span>甲</p><p class=MsoListParagraphCxSpLast><span style='mso-list:Ignore'>·<span>&nbsp;</span></span>乙</p>";
  assert.equal(htmlToMarkdown(html), "- 甲\n- 乙");
});

test("編號清單與巢狀清單", () => {
  assert.equal(
    htmlToMarkdown('<ol start="3"><li>甲<ul><li>子項</li></ul></li><li>乙</li></ol>'),
    "3. 甲\n   - 子項\n4. 乙",
  );
});

test("程式碼區塊保留內容與語言", () => {
  assert.equal(
    htmlToMarkdown('<pre><code class="language-js">const a = 1;\n</code></pre>'),
    "```js\nconst a = 1;\n```",
  );
  assert.equal(htmlToMarkdown("<pre>a  b\n  c</pre>"), "```\na  b\n  c\n```");
});

test("只有純文字時不轉換，保留原本的空白", () => {
  assert.equal(hasStructure("<p>只是文字</p>"), false);
  assert.equal(pasteAsMarkdown("<p>只是  文字</p>", "只是  文字"), null);
  assert.equal(pasteAsMarkdown("", "x"), null);
  assert.equal(pasteAsMarkdown("<p><b>粗</b></p>", "粗"), "**粗**");
});
