import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDoc as parse } from "./test-wasm.ts";
import { backlinks, renameLinks, resolveWiki, rewriteLinks, samePath } from "./links.ts";

const parseDoc = (text: string) => parse(text, 2026);

const FILES = [
  { path: "/ws/週報.md", rel: "週報.md" },
  { path: "/ws/筆記/想法.md", rel: "筆記/想法.md" },
  { path: "/ws/封存/週報.md", rel: "封存/週報.md" },
  { path: "/ws/README.markdown", rel: "README.markdown" },
];

test("[[文件]] 找對應的檔案", () => {
  assert.equal(resolveWiki("週報", FILES, "/ws"), "/ws/週報.md");
  assert.equal(resolveWiki("週報", FILES, "/ws/封存"), "/ws/封存/週報.md", "同名時優先同一個資料夾");
  assert.equal(resolveWiki("想法", FILES, "/ws"), "/ws/筆記/想法.md");
  assert.equal(resolveWiki("筆記/想法.md", FILES, null), "/ws/筆記/想法.md");
  assert.equal(resolveWiki("readme", FILES, null), "/ws/README.markdown");
  assert.equal(resolveWiki("不存在", FILES, "/ws"), null);
});

test("反向連結", () => {
  const docs = [
    { path: "/ws/週報.md", info: parseDoc("# 週報\n連到自己 [[週報]]") },
    { path: "/ws/筆記/想法.md", info: parseDoc("見 [[週報]]\n\n還有 [週報](../週報.md#進度)\n[[週報|本週]]") },
    { path: "/ws/封存/週報.md", info: parseDoc("[[週報]] 指的是自己這個資料夾的") },
  ];
  const r = backlinks("/ws/週報.md", docs, FILES);
  assert.deepEqual(
    r.map((b) => [b.doc.path, b.lines]),
    [["/ws/筆記/想法.md", [1, 3, 4]]],
  );
});

test("改寫連結時略過程式碼", () => {
  const text = "[[a]] `[[a]]`\n```\n[[a]]\n```\n[x](a.md)";
  assert.equal(
    rewriteLinks(text, (kind, t) => (t === "a" || t === "a.md" ? (kind === "wiki" ? "b" : "b.md") : null)),
    "[[b]] `[[a]]`\n```\n[[a]]\n```\n[x](b.md)",
  );
});

test("檔案改名後更新連結", () => {
  const moved = (p: string) => (samePath(p, "/ws/筆記/想法.md") ? "/ws/筆記/點子 清單.md" : null);
  const text = "[[想法]]、[[想法#第一段|看這裡]]、[[筆記/想法]]、[說明](筆記/想法.md#a)、[[週報]]";
  assert.equal(
    renameLinks(text, "/ws/週報.md", FILES, moved),
    "[[點子 清單]]、[[點子 清單#第一段|看這裡]]、[[筆記/點子 清單]]、[說明](%E7%AD%86%E8%A8%98/%E9%BB%9E%E5%AD%90%20%E6%B8%85%E5%96%AE.md#a)、[[週報]]",
  );
  assert.equal(renameLinks("[[週報]]", "/ws/x.md", FILES, moved), null);
});

test("資料夾改名後更新連結", () => {
  const moved = (p: string) => (p.startsWith("/ws/筆記/") ? p.replace("/ws/筆記/", "/ws/靈感/") : null);
  assert.equal(
    renameLinks("[[筆記/想法]] [a](筆記/想法.md) [[想法]]", "/ws/週報.md", FILES, moved),
    "[[靈感/想法]] [a](靈感/想法.md) [[想法]]",
  );
});

test("Windows 路徑", () => {
  assert.ok(samePath("C:\\筆記\\週報.md", "c:/筆記/週報.md"));
  const files = [{ path: "C:\\ws\\筆記\\想法.md", rel: "筆記/想法.md" }];
  assert.equal(resolveWiki("想法", files, "C:\\ws"), "C:\\ws\\筆記\\想法.md");
  assert.equal(
    renameLinks("[a](筆記/想法.md)", "C:\\ws\\週報.md", files, (p) => (samePath(p, "C:\\ws\\筆記\\想法.md") ? "C:\\ws\\筆記\\新.md" : null)),
    "[a](筆記/新.md)",
  );
});
