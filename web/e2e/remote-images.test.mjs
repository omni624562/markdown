/**
 * 封鎖遠端圖片：少了 `//` 的網址（`https:主機/…`）、流程圖標籤裡的圖片、圖片節點、`themeCSS` 的
 * `url()`、`image-set()` 與跳脫字元都不會連到外部；按「載入這份文件的遠端圖片」之後才照常載入。
 * 外部連線都會被 helpers.mjs 擋下並記在 `external`。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand, setText } from "./helpers.mjs";

const fence = (...lines) => ["```mermaid", ...lines, "```", ""];

const DOC = [
  "# 遠端圖片",
  "",
  "![甲](https:evil.example/md.png)",
  "",
  "| 圖 |",
  "|---|",
  "| ![乙](https:evil.example/table.png) |",
  "",
  ...fence("graph TD", `  A["<img src='https:evil.example/label.png'>"]`),
  ...fence("flowchart TD", '  B@{ img: "https:evil.example/node.png", label: "節點" }'),
  ...fence('%%{init: {"themeCSS": ".nodeLabel{background-image:url(https:evil.example/theme.png)}"}}%%', "graph TD", "  C-->D"),
  ...fence('%%{init: {"themeCSS": ".nodeLabel{background-image:image-set(\\"https://evil.example/set.png\\" 1x)}"}}%%', "graph TD", "  E-->F"),
  ...fence('%%{init: {"themeCSS": ".nodeLabel{background-image:url(\\\\68ttps://evil.example/escape.png)}"}}%%', "graph TD", "  G-->H"),
  "結尾",
].join("\n");

const evil = (external) => external.filter((url) => url.includes("evil.example"));

test("封鎖遠端圖片：特殊寫法的網址、流程圖裡的圖片與樣式都不會連到外部", async () => {
  const { page, context, errors, external } = await open();
  await page.click('button[data-view="split"]');
  await setText(page, DOC);
  await page.waitForFunction(() => document.querySelectorAll("#preview figure.mermaid-diagram > svg").length === 5, null, { timeout: 30000 });
  assert.equal(await page.locator("#preview img.remote-blocked").count(), 2);
  // 即時預覽的表格與流程圖也一樣。
  await page.click('button[data-view="live"]');
  await page.keyboard.press("Control+Home");
  await page.waitForSelector(".cm-content table img.remote-blocked");
  await page.waitForFunction(() => [...document.querySelectorAll(".cm-lp-diagram")].some((d) => d.querySelector("svg")), null, { timeout: 30000 });
  await page.waitForTimeout(500);
  assert.deepEqual(evil(external), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test("載入這份文件的遠端圖片之後照常連線", async () => {
  const { page, context, errors, external } = await open();
  await page.click('button[data-view="split"]');
  await setText(page, ["![甲](https:evil.example/allowed.png)", "", "![乙](//evil.example/allowed2.png)", "", ...fence("graph TD", `  A["<img src='https://evil.example/allowed3.png'>"]`)].join("\n"));
  await page.waitForSelector("#preview figure.mermaid-diagram > svg");
  assert.equal(await page.locator("#preview img.remote-blocked").count(), 2);
  assert.deepEqual(evil(external), []);

  await runCommand(page, "載入這份文件的遠端圖片");
  // `//主機/…` 跟著頁面的協定（測試用的頁面是 http），只比對主機與路徑。
  const wanted = ["evil.example/allowed.png", "evil.example/allowed2.png", "evil.example/allowed3.png"];
  const seen = () => wanted.every((u) => evil(external).some((e) => e.replace(/^https?:\/\//, "") === u));
  for (let i = 0; i < 100 && !seen(); i++) await page.waitForTimeout(100);
  assert.ok(seen(), `沒有載入遠端圖片：${evil(external).join("、")}`);
  assert.equal(await page.locator("#preview img.remote-blocked").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
