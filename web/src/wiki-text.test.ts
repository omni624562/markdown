import assert from "node:assert/strict";
import { test } from "node:test";
import { childPagePath, flattenPages, imageRepoPath, pageFromGitPath, pageName, resolvePageLink, revisionNote, snippetParts, wikiMarkdown, wikiPageLink, wikiPageUrl, wikiTitleProblem, inPageScope } from "./wiki-text.ts";

const pages = ["/首頁", "/產品", "/產品/安裝 說明", "/產品/a-b", "/FAQ"];

test("頁面連結：- 是空白、%2D 是 -", () => {
  assert.equal(resolvePageLink("/產品/安裝-說明", "/首頁", pages), "/產品/安裝 說明");
  assert.equal(resolvePageLink("/%E7%94%A2%E5%93%81/a%2Db", "/首頁", pages), "/產品/a-b");
  assert.equal(resolvePageLink("/產品/a-b", "/首頁", pages), "/產品/a-b");
});

test("頁面連結：相對路徑以目前頁面的資料夾為準，可以加 .md 或 #標題", () => {
  assert.equal(resolvePageLink("安裝-說明.md#步驟", "/產品/a-b", pages), "/產品/安裝 說明");
  assert.equal(resolvePageLink("../faq", "/產品/a-b", pages), "/FAQ");
  assert.equal(resolvePageLink("./產品", "/首頁", pages), "/產品");
});

test("頁面連結：同一層找不到時，當成目前頁面底下的子頁面", () => {
  const tree = ["/ITA專區", "/ITA專區/COMET", "/ITA專區/COMET/START-HERE-illustrated", "/ITA專區/COMET/Skill自然語言使用範例"];
  assert.equal(resolvePageLink("START-HERE-illustrated", "/ITA專區/COMET", tree), "/ITA專區/COMET/START-HERE-illustrated");
  assert.equal(resolvePageLink("./Skill%E8%87%AA%E7%84%B6%E8%AA%9E%E8%A8%80%E4%BD%BF%E7%94%A8%E7%AF%84%E4%BE%8B.md", "/ITA專區/COMET", tree), "/ITA專區/COMET/Skill自然語言使用範例");
  // 同一層有同名的頁面時，照一般的規則（同一層）。
  assert.equal(resolvePageLink("產品", "/產品/a-b", ["/產品", "/產品/產品", "/產品/a-b"]), "/產品/產品");
  assert.equal(resolvePageLink("COMET", "/ITA專區/COMET", tree), "/ITA專區/COMET");
});

test("頁面連結：網址、找不到的頁面回傳 null", () => {
  assert.equal(resolvePageLink("https://example.com/產品", "/首頁", pages), null);
  assert.equal(resolvePageLink("mailto:a@b.c", "/首頁", pages), null);
  assert.equal(resolvePageLink("/沒有", "/首頁", pages), null);
  assert.equal(resolvePageLink("#標題", "/首頁", pages), null);
  assert.equal(resolvePageLink("/%E0", "/首頁", pages), null);
});

test("圖片：附件與相對路徑", () => {
  assert.equal(imageRepoPath("/.attachments/a%20b.png", "/產品/安裝 說明", "/"), "/.attachments/a b.png");
  assert.equal(imageRepoPath("./img/a.png", "/產品 說明/a-b", "/"), "/產品-說明/img/a.png");
  assert.equal(imageRepoPath("../a.png", "/A/B", "/docs"), "/docs/a.png");
  assert.equal(imageRepoPath(".attachments/a.png", "/首頁", "/docs"), "/docs/.attachments/a.png");
});

test("圖片：網址與 data: 不處理", () => {
  assert.equal(imageRepoPath("https://x/a.png", "/a", "/"), null);
  assert.equal(imageRepoPath("data:image/png;base64,AA", "/a", "/"), null);
  assert.equal(imageRepoPath("//x/a.png", "/a", "/"), null);
});

test("Wiki 語法：拿掉目錄、轉換 mermaid 與圖片大小", () => {
  const text = "[[_TOC_]]\n\n# 標題\n\n::: mermaid\ngraph TD\n A-->B\n:::\n\n![圖](/.attachments/a.png =300x200) ![小](b.png =x100)";
  const out = wikiMarkdown(text);
  assert.ok(!out.includes("[[_TOC_]]"));
  assert.ok(out.includes("```mermaid\ngraph TD\n A-->B\n```"));
  assert.ok(out.includes("![圖|300x200](/.attachments/a.png)"));
  assert.ok(out.includes("![小](b.png)"));
});

test("頁面名稱與攤平樹狀目錄", () => {
  assert.equal(pageName("/產品/安裝 說明"), "安裝 說明");
  assert.deepEqual(flattenPages([{ path: "/a", children: [{ path: "/a/b", children: [] }] }, { path: "/c", children: [] }]), [
    "/a",
    "/a/b",
    "/c",
  ]);
});

test("插入的頁面連結", () => {
  assert.equal(
    wikiPageLink("安裝 [說明]", "https://tfs/DC/P/_wiki/wikis/P.wiki/3/安裝 (說明)"),
    "[安裝 \\[說明\\]](https://tfs/DC/P/_wiki/wikis/P.wiki/3/安裝%20%28說明%29)",
  );
});

test("還沒讀過的頁面網址", () => {
  assert.equal(wikiPageUrl("https://tfs/DC/P/_wiki/wikis/P.wiki", "/產品/安裝 說明"), "https://tfs/DC/P/_wiki/wikis/P.wiki?pagePath=%2F%E7%94%A2%E5%93%81%2F%E5%AE%89%E8%A3%9D%20%E8%AA%AA%E6%98%8E");
  assert.equal(wikiPageUrl("https://tfs/x/", "/a"), "https://tfs/x?pagePath=%2Fa");
});

test("pageFromGitPath 把搜尋結果的檔案路徑換成頁面", () => {
  const pages = ["/產品", "/產品/安裝 說明", "/產品/a-b", "/Home"];
  assert.equal(pageFromGitPath("/產品/安裝-說明.md", "/", pages), "/產品/安裝 說明");
  assert.equal(pageFromGitPath("/產品/a%2Db.md", "/", pages), "/產品/a-b");
  assert.equal(pageFromGitPath("/home.md", "/", pages), "/Home");
  assert.equal(pageFromGitPath("/docs/產品.md", "/docs", pages), "/產品");
  assert.equal(pageFromGitPath("/other/產品.md", "/docs", pages), null);
  assert.equal(pageFromGitPath("/.attachments/a.png", "/", pages), null);
  assert.equal(pageFromGitPath("/新頁面.md", "/", pages), "/新頁面");
  assert.equal(pageFromGitPath("/%E0%A4.md", "/", pages), null);
});

test("snippetParts 拆出符合的字", () => {
  assert.deepEqual(snippetParts("先<highlighthit>安裝</highlighthit>工具\n再設定"), [
    { text: "先", hit: false },
    { text: "安裝", hit: true },
    { text: "工具 再設定", hit: false },
  ]);
  assert.deepEqual(snippetParts(""), []);
  assert.deepEqual(snippetParts("<b>x</b>"), [{ text: "<b>x</b>", hit: false }]);
});

test("wikiTitleProblem 檢查新頁面的標題", () => {
  assert.equal(wikiTitleProblem("  安裝說明 "), null);
  assert.equal(wikiTitleProblem("   "), "empty");
  assert.equal(wikiTitleProblem("A/B"), "chars");
  assert.equal(wikiTitleProblem("C#"), "chars");
  assert.equal(wikiTitleProblem("a\\b"), "chars");
  assert.equal(wikiTitleProblem(".隱藏"), "dot");
  assert.equal(wikiTitleProblem("很".repeat(80)), "long");
});

test("childPagePath 組出新頁面的路徑", () => {
  assert.equal(childPagePath(null, " 新頁面 "), "/新頁面");
  assert.equal(childPagePath("/", "新頁面"), "/新頁面");
  assert.equal(childPagePath("/產品/安裝", "Windows"), "/產品/安裝/Windows");
});

test("修改紀錄的說明：自動產生的英文說明換成簡短的說法，自己寫的照原樣", () => {
  const path = "/📕專案需求對焦專區/DGT_00098_新阿發3.0業務中台/消費明細查詢及爭議帳申請";
  assert.equal(revisionNote(`Updated page '${path}'.`, path), "修改這一頁");
  assert.equal(revisionNote(`Added page '${path}'.`, path), "新增這一頁");
  assert.equal(revisionNote("Updated page '/產品/安裝'.", path), "修改「安裝」");
  assert.equal(revisionNote("Deleted page '/產品/舊規格'", path), "刪除了「舊規格」");
  assert.equal(revisionNote("Renamed page '/產品/A' to '/產品/B'.", path), "移動：A → B");
  assert.equal(revisionNote("  補上驗收條件  ", path), "補上驗收條件");
});

test("頁面在不在樹狀目錄的範圍裡：範圍頁面本身與底下的子頁面才算；沒有範圍就是整個 Wiki", () => {
  const scope = ["/專案需求對焦專區", "/ITA專區"];
  assert.equal(inPageScope("/專案需求對焦專區", scope), true);
  assert.equal(inPageScope("/ITA專區/部署流程/檢查表", scope), true);
  assert.equal(inPageScope("/上線列車/2026年/1127上線", scope), false, "藏起來的最上層頁面");
  assert.equal(inPageScope("/ITA專區2", scope), false, "名稱開頭相同的別的頁面");
  assert.equal(inPageScope("/上線列車", null), true);
});
