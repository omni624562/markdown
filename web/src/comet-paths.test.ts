import assert from "node:assert/strict";
import { test } from "node:test";
import { cometAffected, cometItemKind, cometKind, relativePath } from "./comet-paths.ts";

const ROOT = "C:\\Users\\me\\Documents\\產品交付";

test("relativePath：相對於專案資料夾、用 / 分隔；不分大小寫；不在裡面時是 null", () => {
  assert.equal(relativePath(ROOT, `${ROOT}\\.comet.json`), ".comet.json");
  assert.equal(relativePath(ROOT, `${ROOT}\\docs\\spec\\需求.md`), "docs/spec/需求.md");
  assert.equal(relativePath(`${ROOT}\\`, `${ROOT.toLowerCase()}\\AGENTS.md`), "AGENTS.md");
  assert.equal(relativePath("/home/me/產品", "/home/me/產品/.comet/contexts/sprint-context.json"), ".comet/contexts/sprint-context.json");
  assert.equal(relativePath(ROOT, ROOT), null);
  assert.equal(relativePath(ROOT, `${ROOT}2\\.comet.json`), null);
  assert.equal(relativePath(ROOT, "C:\\Users\\me\\Documents\\筆記\\.comet.json"), null);
});

test("cometKind：設定檔、產生的 AGENTS.md、規格文件；資料夾裡面的也算", () => {
  assert.equal(cometKind(".comet.json"), "config");
  assert.equal(cometKind(".comet"), "config");
  assert.equal(cometKind(".comet/contexts/sprint-context.json"), "config");
  assert.equal(cometKind("AGENTS.md"), "generated");
  assert.equal(cometKind("agents.md"), "generated");
  assert.equal(cometKind("docs/spec"), "spec");
  assert.equal(cometKind("docs/spec/需求.md"), "spec");
  assert.equal(cometKind("docs/spec/templates"), "template");
  assert.equal(cometKind("Docs/Spec/Templates/feature.md"), "template");
  assert.equal(cometKind("docs/spec/templates/sub/a.md"), "template");
  assert.equal(cometKind("docs/spec/templates-old/a.md"), "spec");
  // 只有專案資料夾最上層的 AGENTS.md；名稱開頭一樣的不算。
  assert.equal(cometKind("docs/AGENTS.md"), null);
  assert.equal(cometKind(".comet.json.bak"), null);
  assert.equal(cometKind(".cometx/a.json"), null);
  assert.equal(cometKind("docs/specs/a.md"), null);
  assert.equal(cometKind("docs"), null);
  assert.equal(cometKind("README.md"), null);
});

test("cometItemKind：只有 COMET 的項目本身（檔案面板標「C」的），不含資料夾裡面的檔案", () => {
  assert.equal(cometItemKind(".comet.json"), "config");
  assert.equal(cometItemKind(".comet"), "config");
  assert.equal(cometItemKind("AGENTS.md"), "generated");
  assert.equal(cometItemKind("docs/spec"), "spec");
  assert.equal(cometItemKind("docs/spec/需求.md"), null);
  assert.equal(cometItemKind("docs/spec/templates"), "template");
  assert.equal(cometItemKind("docs/spec/templates/feature.md"), null);
  assert.equal(cometItemKind(".comet/contexts"), null);
  assert.equal(cometItemKind("docs"), null);
});

test("cometAffected：刪除或改名會動到的 COMET 項目", () => {
  assert.deepEqual(cometAffected(".comet.json"), [".comet.json"]);
  assert.deepEqual(cometAffected("docs/spec/需求.md"), ["docs/spec/需求.md"]);
  // 裝著 COMET 項目的資料夾：列出裡面的項目。
  assert.deepEqual(cometAffected("docs"), ["docs/spec"]);
  assert.deepEqual(cometAffected("Docs"), ["docs/spec"]);
  assert.deepEqual(cometAffected("docs/spec"), ["docs/spec"]);
  assert.deepEqual(cometAffected("docs/spec/templates/feature.md"), ["docs/spec/templates/feature.md"]);
  assert.deepEqual(cometAffected("README.md"), []);
  assert.deepEqual(cometAffected("doc"), []);
});
