import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_TEMPLATES, fillTemplate, isoWeek, templateFileName } from "./templates.ts";

const NOW = new Date(2026, 9, 21, 9, 5); // 2026-10-21 星期三 09:05

test("範本變數", () => {
  assert.equal(
    fillTemplate("{{日期}} {{時間}} {{年}}/{{月}}/{{日}} 星期{{星期}} 第{{週次}}週 {{不認得}}", NOW),
    "2026-10-21 09:05 2026/10/21 星期三 第43週 {{不認得}}",
  );
  assert.equal(fillTemplate("{{ 日期 }}", NOW), "2026-10-21");
});

test("ISO 週次", () => {
  assert.equal(isoWeek(new Date(2026, 0, 1)), 1); // 星期四
  assert.equal(isoWeek(new Date(2027, 0, 1)), 53); // 2026 年有 53 週
  assert.equal(isoWeek(new Date(2025, 11, 29)), 1); // 屬於 2026 年第 1 週
});

test("內建範本與檔名", () => {
  assert.deepEqual(
    BUILTIN_TEMPLATES.map((t) => t.name),
    ["週報", "會議記錄", "OKR", "專案提案", "空白文件"],
  );
  assert.equal(templateFileName("週報", NOW), "週報 2026-10-21.md");
  assert.equal(templateFileName("A/B:C", NOW), "ABC 2026-10-21.md");
  assert.equal(templateFileName("空白文件", NOW), "未命名.md");
});
