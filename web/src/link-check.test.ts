import assert from "node:assert/strict";
import { test } from "node:test";
import { linkKind, planLinkCheck } from "./link-check.ts";

const files = [
  { path: "C:\\筆記\\週報.md", rel: "週報.md" },
  { path: "C:\\筆記\\專案\\計畫.md", rel: "專案/計畫.md" },
];

test("連結的種類：文件、圖片、其他檔案", () => {
  assert.equal(linkKind({ line: 1, target: "週報", kind: "wiki" }), "page");
  assert.equal(linkKind({ line: 1, target: "專案/計畫.md", kind: "markdown" }), "page");
  assert.equal(linkKind({ line: 1, target: "img/a.PNG", kind: "markdown" }), "image");
  assert.equal(linkKind({ line: 1, target: "附件/報表.xlsx", kind: "markdown" }), "file");
});

test("[[文件]] 在資料夾裡找；檔案連結交給後端查", () => {
  const plan = planLinkCheck(
    [
      { line: 1, target: "週報", kind: "wiki" },
      { line: 2, target: "不存在的頁面", kind: "wiki" },
      { line: 3, target: "../圖/a.png", kind: "markdown" },
      { line: 4, target: "計畫.md", kind: "markdown" },
    ],
    "C:\\筆記\\專案\\README.md",
    files,
  );
  assert.deepEqual(plan.broken, [{ line: 2, target: "不存在的頁面", kind: "page" }]);
  assert.deepEqual(
    plan.paths.map((p) => [p.path, p.problem.line, p.problem.kind]),
    [
      ["C:\\筆記\\圖\\a.png", 3, "image"],
      ["C:\\筆記\\專案\\計畫.md", 4, "page"],
    ],
  );
  assert.equal(plan.checked, 4);
});

test("不檢查：沒開資料夾時的 [[文件]]、網址、網站根目錄、網路路徑", () => {
  const plan = planLinkCheck(
    [
      { line: 1, target: "週報", kind: "wiki" },
      { line: 2, target: "/docs/a.md", kind: "markdown" },
      { line: 3, target: "\\\\nas\\共用\\a.png", kind: "markdown" },
      { line: 4, target: "mailto:a@b.c", kind: "markdown" },
    ],
    "C:\\筆記\\a.md",
    null,
  );
  assert.deepEqual(plan, { broken: [], paths: [], checked: 0 });
});
