/**
 * app/ 的模組只能在函式裡取用 `app`（見 context.ts）：掃描所有模組，模組最上層（不在任何函式、方法、
 * 類別成員裡）直接取用 `app.xxx` 的列出來，一個都不能有。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { app, provideApp } from "./context.ts";

const DIR = fileURLToPath(new URL("./", import.meta.url));

/** 這個節點是不是「延後執行」的範圍：函式、方法、存取子、建構式、類別成員的初始值。 */
function deferred(node: ts.Node): boolean {
  return (
    ts.isFunctionLike(node) ||
    ts.isClassLike(node) ||
    ts.isPropertyDeclaration(node)
  );
}

/** 原始碼裡在模組最上層取用 `app.xxx` 的位置（`名稱:行 app.xxx`）。 */
function topLevelAppUses(name: string, src: string): string[] {
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (deferred(node)) return;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "app") {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      out.push(`${name}:${line + 1} app.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

test("掃描認得最上層的取用，函式、類別成員裡的不算", () => {
  const src = [
    'import { app } from "./context.ts";',
    "const a = app.settings.value;", // 最上層：不行
    "export const b = () => app.cur.kind;", // 箭頭函式裡：可以
    "function c() { return app.view; }",
    "class D { e = app.editor; f() { return app.docs; } }",
    "const g = { h: app.outlineShown };", // 物件字面值的最上層：不行
  ].join("\n");
  assert.deepEqual(topLevelAppUses("x.ts", src), ["x.ts:2 app.settings", "x.ts:6 app.outlineShown"]);
});

test("app/ 的模組不在最上層取用 app（只能在函式裡）", () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "context.ts")
    .map((f) => DIR + f);
  assert.ok(files.length > 30);
  assert.deepEqual(
    files.flatMap((f) => topLevelAppUses(f.slice(DIR.length), readFileSync(f, "utf8"))),
    [],
  );
});

test("provideApp 之前取用 app 會丟出清楚的錯誤；之後就是真正的物件", () => {
  assert.throws(() => (app as unknown as { cur: unknown }).cur, /provideApp.*app\.cur/);
  const real = { cur: { kind: "markdown" } } as unknown as Parameters<typeof provideApp>[0];
  provideApp(real);
  assert.equal(app, real);
});
