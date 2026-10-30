import assert from "node:assert/strict";
import { test } from "node:test";
import { baseName, fileLine, tagHue, tagLine } from "./work-item-marks.ts";

test("標籤行：用「 / 」分開、至少三個英文代號", () => {
  assert.deepEqual(tagLine("AI-CodeGen / Copilot / AIState-delivered / HumanAction-review"), ["AI-CodeGen", "Copilot", "AIState-delivered", "HumanAction-review"]);
  assert.deepEqual(tagLine("AI-CodeGen / Codex / AIState-delivered / HumanAction-review"), ["AI-CodeGen", "Codex", "AIState-delivered", "HumanAction-review"]);
  assert.equal(tagLine("src/main/java"), null);
  assert.equal(tagLine("A / B"), null);
  assert.equal(tagLine("通過 / 失敗 / 略過"), null);
  assert.equal(tagLine("AI 耗時 / 未量測 / x"), null);
});

test("檔案：整段是一個路徑或「標籤：檔名」", () => {
  assert.deepEqual(fileLine(".comet/reports/20261005-task-1911359.md"), { label: "", path: ".comet/reports/20261005-task-1911359.md" });
  assert.deepEqual(fileLine("附件：20261005-task-1911359.md"), { label: "附件", path: "20261005-task-1911359.md" });
  assert.deepEqual(fileLine("詳細報告: docs/a.pdf"), { label: "詳細報告", path: "docs/a.pdf" });
  assert.equal(fileLine("1.63.2"), null);
  assert.equal(fileLine("https://tfs/a.md"), null);
  assert.equal(fileLine("請看 a.md 的說明"), null);
  assert.equal(fileLine("完成："), null);
  assert.equal(baseName(".comet/reports/x.md"), "x.md");
  assert.equal(tagHue("Copilot"), tagHue("copilot"));
});
