import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_WORKFLOW } from "./ci-workflow.ts";

test("工作流程用 claude-code-action v1，GitHub 的運算式保持原樣", () => {
  assert.equal(CLAUDE_WORKFLOW.match(/anthropics\/claude-code-action@v1/g)?.length, 2);
  assert.ok(CLAUDE_WORKFLOW.includes("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"));
  assert.ok(CLAUDE_WORKFLOW.includes("${{ github.event.pull_request.number }}"));
  assert.ok(!CLAUDE_WORKFLOW.includes("\\$"));
});

test("YAML 只用空白縮排", () => {
  assert.ok(!CLAUDE_WORKFLOW.includes("\t"));
  for (const line of CLAUDE_WORKFLOW.split("\n")) {
    const indent = line.match(/^ */)![0].length;
    assert.equal(indent % 2, 0, `縮排不是 2 的倍數：${line}`);
  }
});

test("校對只能留言，不能改檔案", () => {
  const proofread = CLAUDE_WORKFLOW.slice(CLAUDE_WORKFLOW.indexOf("  proofread:"), CLAUDE_WORKFLOW.indexOf("  assistant:"));
  assert.ok(proofread.includes("contents: read"));
  assert.ok(!proofread.includes("contents: write"));
});
