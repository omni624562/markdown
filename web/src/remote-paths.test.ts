import assert from "node:assert/strict";
import { test } from "node:test";
import { displayPath, isRemote, remoteId, remoteRoot } from "./desktop.ts";
import { dirname, isInside, relativePath } from "./paths.ts";

test("WebDAV 與 SSH 的遠端路徑", () => {
  assert.ok(isRemote("webdav://ab12/筆記/週報.md"));
  assert.ok(isRemote("ssh://cd34/a.md"));
  assert.ok(!isRemote("C:\\筆記\\ssh.md"));
  assert.ok(!isRemote("/home/u/ssh://x"));
  assert.ok(!isRemote(null));
  assert.equal(remoteId("ssh://cd34/筆記/a.md"), "cd34");
  assert.equal(remoteId("webdav://ab12"), "ab12");
  assert.equal(remoteId("/home/u/a.md"), null);
  assert.equal(remoteRoot({ id: "cd34", kind: "ssh" }), "ssh://cd34");
  assert.equal(remoteRoot({ id: "ab12", kind: "webdav" }), "webdav://ab12");
  // 還不知道連線的網址時照原樣顯示。
  assert.equal(displayPath("ssh://zz99/a.md"), "ssh://zz99/a.md");
  // SSH 路徑和 WebDAV 一樣可以算上一層、相對路徑。
  assert.equal(dirname("ssh://cd34/筆記/a.md"), "ssh://cd34/筆記");
  assert.ok(isInside("ssh://cd34/筆記/a.md", "ssh://cd34"));
  assert.equal(relativePath("ssh://cd34/筆記", "ssh://cd34/日記/今天.md"), "../日記/今天.md");
});
