import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { resolveLang, t, useLang } from "./i18n.ts";
import { en, enParts } from "./locales/en.ts";

const SRC = new URL(".", import.meta.url).pathname;
const CJK = /[㐀-鿿　-〿！-～]/;

function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "locales" ? [] : sources(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

interface Scan {
  keys: Map<string, string>;
  problems: string[];
}

/**
 * 找出所有中文字串：`t()` 的第一個參數是要翻譯的鍵；其他的中文字串必須標上
 * `i18n-ignore`（同一行或上一行的註解，例如詞庫、文件內容、比對中文用的正規表示式），
 * 或整個檔案開頭標 `i18n-ignore-file`。
 */
function scan(): Scan {
  const keys = new Map<string, string>();
  const problems: string[] = [];
  for (const file of sources()) {
    const text = readFileSync(file, "utf8");
    if (text.includes("i18n-ignore-file")) continue;
    const lines = text.split("\n");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const where = (node: ts.Node) => {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line;
      return { line, at: `${relative(SRC, file)}:${line + 1}` };
    };
    const ignored = (line: number) => /i18n-ignore/.test(lines[line] ?? "") || /i18n-ignore/.test(lines[line - 1] ?? "");
    const visit = (node: ts.Node) => {
      const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
      if (literal && CJK.test(node.getText(sf))) {
        const parent = node.parent;
        const isKey =
          ts.isCallExpression(parent) &&
          ts.isIdentifier(parent.expression) &&
          parent.expression.text === "t" &&
          parent.arguments[0] === node;
        const { line, at } = where(node);
        if (isKey && ts.isTemplateExpression(node)) problems.push(`${at} t() 裡不能用 \${}，改用 {參數}`);
        else if (isKey) keys.set((node as ts.StringLiteral).text, at);
        else if (!ignored(line)) problems.push(`${at} 中文字串沒有經過 t()：${node.getText(sf).slice(0, 40)}`);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { keys, problems };
}

const result = scan();

test("介面上的中文字串都經過 t()", () => {
  assert.deepEqual(result.problems, []);
});

test("每一句都有英文翻譯，翻譯裡的參數和原文一致", () => {
  const missing = [...result.keys].filter(([k]) => !(k in en)).map(([k, at]) => `${at} ${k}`);
  assert.deepEqual(missing, []);
  const params = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join();
  const wrong: string[] = [];
  for (const [zh, tr] of Object.entries(en)) {
    // 單複數：單數可以省略數字（例如 "1 file" 寫成 "one file"），複數要和原文一致。
    const forms = typeof tr === "string" ? [tr] : [tr[1]];
    for (const s of forms) if (params(s) !== params(zh)) wrong.push(`參數不一致：${zh} → ${s}`);
    for (const s of typeof tr === "string" ? [tr] : tr) if (CJK.test(s)) wrong.push(`英文翻譯裡有中文：${zh} → ${s}`);
  }
  assert.deepEqual(wrong, []);
});

test("同一句中文只出現在一個翻譯檔", () => {
  const seen = new Map<string, string>();
  const dup: string[] = [];
  for (const [part, dict] of Object.entries(enParts)) {
    for (const k of Object.keys(dict)) {
      if (seen.has(k)) dup.push(`${k}（${seen.get(k)}、${part}）`);
      seen.set(k, part);
    }
  }
  assert.deepEqual(dup, []);
});

test("跟隨系統：中文（任何地區）用繁體中文，其他用英文", () => {
  assert.equal(resolveLang(null, ["zh-TW"]), "zh-TW");
  assert.equal(resolveLang("system", ["zh-CN", "en"]), "zh-TW");
  assert.equal(resolveLang(null, ["en-US", "zh-TW"]), "en");
  assert.equal(resolveLang("zh-TW", ["en-US"]), "zh-TW");
  assert.equal(resolveLang("en", ["zh-TW"]), "en");
  assert.equal(resolveLang(null, []), "zh-TW");
});

test("參數與單複數", async () => {
  await useLang("zh-TW");
  assert.equal(t("找不到「{name}」", { name: "a.md" }), "找不到「a.md」");
  await useLang("en");
  assert.equal(t("還沒有翻譯的句子{x}", { x: 1 }), "還沒有翻譯的句子1");
  await useLang("zh-TW");
});
