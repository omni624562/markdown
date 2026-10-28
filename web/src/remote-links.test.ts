import assert from "node:assert/strict";
import { test } from "node:test";
import { findWikiPage, parseRemoteLink, urlAt } from "./remote-links.ts";

const base = "https://tfs.corp/tfs/DC";

test("工作項目網址", () => {
  assert.deepEqual(parseRemoteLink("https://tfs.corp/tfs/DC/產品/_workitems/edit/42", base), { kind: "workitem", id: 42 });
  assert.deepEqual(parseRemoteLink("https://TFS.corp/tfs/dc/P/_workitems/edit/7/?x=1", `${base}/`), { kind: "workitem", id: 7 });
  assert.equal(parseRemoteLink("https://other/tfs/DC/P/_workitems/edit/7", base), null, "別的伺服器");
  assert.equal(parseRemoteLink("https://tfs.corp/tfs/DCX/P/_workitems/edit/7", base), null, "名稱開頭相同的集合");
  assert.equal(parseRemoteLink("https://tfs.corp/tfs/DC/P/_workitems/edit/7abc", base), null);
});

test("Wiki 網址：pagePath、頁面編號與名稱", () => {
  assert.deepEqual(parseRemoteLink(`${base}/P/_wiki/wikis/P.wiki?pagePath=%2F%E7%94%A2%E5%93%81%2F%E5%AE%89%E8%A3%9D`, base), {
    kind: "wiki",
    wiki: "P.wiki",
    path: "/產品/安裝",
    pageId: null,
    slug: null,
  });
  assert.deepEqual(parseRemoteLink(`${base}/P/_wiki/wikis/%E7%94%A2%E5%93%81.wiki/12/%E5%AE%89%E8%A3%9D-%E8%AA%AA%E6%98%8E`, base), {
    kind: "wiki",
    wiki: "產品.wiki",
    path: null,
    pageId: 12,
    slug: "安裝 說明",
  });
  assert.equal(parseRemoteLink(`${base}/P/_git/repo`, base), null);
});

test("游標所在的網址", () => {
  const line = "見 [Bug 1](https://x/a) 與 [說明](<https://x/b c>) 還有 https://x/c。";
  assert.equal(urlAt(line, 4)?.url, "https://x/a");
  assert.equal(urlAt(line, line.indexOf("說明"))?.url, "https://x/b c");
  assert.equal(urlAt(line, line.indexOf("x/c"))?.url, "https://x/c");
  assert.equal(urlAt(line, 0), null);
});

test("依編號或名稱找 Wiki 頁面", () => {
  const pages = [
    { path: "/首頁", id: 1, children: [] },
    { path: "/產品", id: 2, children: [{ path: "/產品/安裝 說明", id: 12, children: [] }] },
  ];
  assert.equal(findWikiPage(pages, 12, "whatever"), "/產品/安裝 說明");
  assert.equal(findWikiPage([{ path: "/產品/安裝 說明", children: [] }], 99, "安裝 說明"), "/產品/安裝 說明");
  assert.equal(findWikiPage(pages, 99, null), null);
});
