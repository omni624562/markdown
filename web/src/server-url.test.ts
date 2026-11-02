import assert from "node:assert/strict";
import { test } from "node:test";
import { sameHost, underServer } from "./server-url.ts";
import { parseRemoteLink } from "./remote-links.ts";
import { parseRepoFileLink } from "./repo-links.ts";

const base = "https://pialm01.corp.local/DC";

test("同一台伺服器：只寫電腦名稱、完整名稱都算，大小寫不分", () => {
  assert.equal(sameHost("pialm01", "PIALM01.corp.local"), true);
  assert.equal(sameHost("pialm01.corp.local", "pialm01"), true);
  assert.equal(sameHost("pialm02", "pialm01.corp.local"), false);
  assert.equal(sameHost("pialm01.other.local", "pialm01.corp.local"), false, "兩邊都是完整名稱時要一樣");
  assert.equal(sameHost("pialm", "pialm01.corp.local"), false);
});

test("集合底下的路徑：http／https、埠號不同也算；別的集合、別的伺服器不算", () => {
  assert.equal(underServer("http://pialm01/DC/P/_wiki/wikis/P.wiki", base)?.rest, "/P/_wiki/wikis/P.wiki");
  assert.equal(underServer("https://pialm01.corp.local:443/dc/P", base)?.rest, "/P");
  assert.equal(underServer("http://pialm01:8080/DC/P", base)?.root, base);
  assert.equal(underServer("http://pialm01/DCX/P", base), null);
  assert.equal(underServer("http://pialm02/DC/P", base), null);
  assert.equal(underServer("ftp://pialm01/DC/P", base), null);
  assert.equal(underServer("/DC/P", base), null, "相對路徑");
});

test("Wiki、工作項目的網址：主機名稱寫法不同也認得", () => {
  assert.deepEqual(parseRemoteLink("http://pialm01/DC/Mgt/_wiki/wikis/Mgt.wiki/1234/START-HERE%2Dillustrated", base), {
    kind: "wiki",
    wiki: "Mgt.wiki",
    path: null,
    pageId: 1234,
    slug: "START HERE-illustrated",
  });
  assert.deepEqual(parseRemoteLink("http://PIALM01:8080/DC/Mgt/_workitems/edit/42#comment", base), { kind: "workitem", id: 42 });
  assert.equal(
    (parseRemoteLink("http://pialm01/DC/Mgt/_wiki/wikis/Mgt.wiki?pagePath=/ITA專區/COMET&_a=view", base) as { path: string }).path,
    "/ITA專區/COMET",
  );
});

test("儲存庫檔案與附件：主機名稱寫法不同也認得，附件改用連線設定的伺服器", () => {
  const git = parseRepoFileLink("http://pialm01/DC/Mgt/_git/comet?path=/release-zip-manifest.json&version=GBmain", base);
  assert.equal(git?.kind, "git");
  assert.equal(git?.kind === "git" && git.path, "/release-zip-manifest.json");
  const att = parseRepoFileLink("http://pialm01/DC/Mgt/_apis/wit/attachments/abc?fileName=notes.md", base);
  assert.deepEqual(att, { kind: "attachment", url: `${base}/Mgt/_apis/wit/attachments/abc?fileName=notes.md`, name: "notes.md" });
});
