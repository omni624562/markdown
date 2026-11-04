import assert from "node:assert/strict";
import { test } from "node:test";
import { sameHost, underServer } from "./server-url.ts";
import { parseRemoteLink } from "./remote-links.ts";
import { parseRepoFileLink } from "./repo-links.ts";

const base = "https://almsrv01.corp.local/DC";

test("同一台伺服器：只寫電腦名稱、完整名稱都算，大小寫不分", () => {
  assert.equal(sameHost("almsrv01", "ALMSRV01.corp.local"), true);
  assert.equal(sameHost("almsrv01.corp.local", "almsrv01"), true);
  assert.equal(sameHost("almsrv02", "almsrv01.corp.local"), false);
  assert.equal(sameHost("almsrv01.other.local", "almsrv01.corp.local"), false, "兩邊都是完整名稱時要一樣");
  assert.equal(sameHost("almsrv", "almsrv01.corp.local"), false);
});

test("集合底下的路徑：http／https、埠號不同也算；別的集合、別的伺服器不算", () => {
  assert.equal(underServer("http://almsrv01/DC/P/_wiki/wikis/P.wiki", base)?.rest, "/P/_wiki/wikis/P.wiki");
  assert.equal(underServer("https://almsrv01.corp.local:443/dc/P", base)?.rest, "/P");
  assert.equal(underServer("http://almsrv01:8080/DC/P", base)?.root, base);
  assert.equal(underServer("http://almsrv01/DCX/P", base), null);
  assert.equal(underServer("http://almsrv02/DC/P", base), null);
  assert.equal(underServer("ftp://almsrv01/DC/P", base), null);
  assert.equal(underServer("/DC/P", base), null, "相對路徑");
});

test("Wiki、工作項目的網址：主機名稱寫法不同也認得", () => {
  assert.deepEqual(parseRemoteLink("http://almsrv01/DC/Contoso/_wiki/wikis/Contoso.wiki/1234/GET-STARTED%2Dguide", base), {
    kind: "wiki",
    wiki: "Contoso.wiki",
    path: null,
    pageId: 1234,
    slug: "GET STARTED-guide",
  });
  assert.deepEqual(parseRemoteLink("http://ALMSRV01:8080/DC/Contoso/_workitems/edit/42#comment", base), { kind: "workitem", id: 42 });
  assert.equal(
    (parseRemoteLink("http://almsrv01/DC/Contoso/_wiki/wikis/Contoso.wiki?pagePath=/IRIS專區/COBALT&_a=view", base) as { path: string }).path,
    "/IRIS專區/COBALT",
  );
});

test("儲存庫檔案與附件：主機名稱寫法不同也認得，附件改用連線設定的伺服器", () => {
  const git = parseRepoFileLink("http://almsrv01/DC/Contoso/_git/cobalt?path=/release-notes.json&version=GBmain", base);
  assert.equal(git?.kind, "git");
  assert.equal(git?.kind === "git" && git.path, "/release-notes.json");
  const att = parseRepoFileLink("http://almsrv01/DC/Contoso/_apis/wit/attachments/abc?fileName=notes.md", base);
  assert.deepEqual(att, { kind: "attachment", url: `${base}/Contoso/_apis/wit/attachments/abc?fileName=notes.md`, name: "notes.md" });
});
