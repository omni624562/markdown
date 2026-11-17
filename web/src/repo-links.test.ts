import assert from "node:assert/strict";
import { test } from "node:test";
import { fenceLanguage, isImageName, isReadableFileName, parseImageLink, parseRepoFileLink, repoFileUrl, resolveRepoPath } from "./repo-links.ts";

const base = "https://tfs.corp/tfs/DC";

test("儲存庫裡的 Markdown 檔：路徑、分支", () => {
  const link = parseRepoFileLink(`${base}/%E7%94%A2%E5%93%81/_git/docs?path=%2Fguide%2F%E5%AE%89%E8%A3%9D.md&version=GBrelease%2F1.0&_a=contents`, base);
  assert.deepEqual(link, {
    kind: "git",
    project: "產品",
    repo: "docs",
    path: "/guide/安裝.md",
    version: "release/1.0",
    versionType: "branch",
    name: "安裝.md",
  });
  assert.equal(parseRepoFileLink(`${base}/P/_git/docs?path=/a.md&version=GT v1`, base)?.kind, "git");
  const legacy = parseRepoFileLink(`${base}/_git/docs?path=/README.md`, base);
  assert.equal(legacy?.kind === "git" && legacy.project, "docs", "省略專案時和儲存庫同名");
});

test("不是可以閱讀的檔案或別的伺服器：null", () => {
  assert.equal(parseRepoFileLink(`${base}/P/_git/docs?path=/a.png`, base), null);
  assert.equal(parseRepoFileLink(`${base}/P/_git/docs`, base), null, "沒有 path 是儲存庫首頁");
  assert.equal(parseRepoFileLink(`https://other/tfs/DC/P/_git/docs?path=/a.md`, base), null);
  assert.equal(parseRepoFileLink(`${base}/P/_workitems/edit/1`, base), null);
});

test("工作項目的附件", () => {
  const url = `${base}/P/_apis/wit/attachments/1234-abcd?fileName=%E8%AA%AA%E6%98%8E.md`;
  assert.deepEqual(parseRepoFileLink(url, base), { kind: "attachment", url, name: "說明.md" });
  assert.equal(parseRepoFileLink(`${base}/_apis/wit/attachments/1234?fileName=a.zip`, base), null);
});

test("相對路徑與瀏覽器網址", () => {
  assert.equal(resolveRepoPath("/docs/guide/a.md", "../img/b.png"), "/docs/img/b.png");
  assert.equal(resolveRepoPath("/docs/a.md", "./c%20d.md#x"), "/docs/c d.md");
  assert.equal(resolveRepoPath("/docs/a.md", "https://x/y"), null);
  const link = parseRepoFileLink(`${base}/P/_git/docs?path=/a.md&version=GBmain`, base);
  assert.ok(link && link.kind === "git");
  assert.equal(repoFileUrl(base, link, "/b c.md"), `${base}/P/_git/docs?path=%2Fb%20c.md&version=GBmain`);
});

test("檔名與上色語言", () => {
  assert.ok(isReadableFileName("README"));
  assert.ok(isReadableFileName("config.yml"));
  assert.ok(!isReadableFileName("a.docx"));
  assert.equal(fenceLanguage("a.yml"), "yaml");
  assert.equal(fenceLanguage("a.txt"), "");
  assert.equal(fenceLanguage("a.py"), "py");
});

test("連到伺服器上的圖片：附件、Git 網頁網址、API 網址都認得；文字檔與別的伺服器不算", () => {
  assert.deepEqual(parseImageLink(`${base}/_apis/wit/attachments/1f2e?fileName=S07%20%E7%95%AB%E9%9D%A2.png`, base), {
    kind: "attachment",
    url: `${base}/_apis/wit/attachments/1f2e?fileName=S07%20%E7%95%AB%E9%9D%A2.png`,
    name: "S07 畫面.png",
  });
  assert.deepEqual(parseImageLink(`${base}/%E7%94%A2%E5%93%81/_git/docs?path=%2Fimg%2FS08.jpg&version=GBmain`, base), {
    kind: "git",
    project: "產品",
    repo: "docs",
    path: "/img/S08.jpg",
    version: "main",
    versionType: "branch",
    name: "S08.jpg",
  });
  assert.deepEqual(parseImageLink(`${base}/Contoso/_apis/git/repositories/9a8b/items?path=/.attachments/S07-123.png&download=false`, base), {
    kind: "git",
    project: "Contoso",
    repo: "9a8b",
    path: "/.attachments/S07-123.png",
    version: null,
    versionType: null,
    name: "S07-123.png",
  });
  assert.equal(parseImageLink(`${base}/P/_git/docs?path=/a.md`, base), null);
  assert.equal(parseImageLink(`${base}/P/_git/docs?path=/a.svg`, base), null, "SVG 不算");
  assert.equal(parseImageLink(`https://other/tfs/DC/P/_git/docs?path=/a.png`, base), null);
  assert.equal(parseRepoFileLink(`${base}/P/_apis/git/repositories/r/items?path=/a.png`, base), null);
  assert.equal(isImageName("S07.PNG"), true);
});
