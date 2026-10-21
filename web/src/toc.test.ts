import assert from "node:assert/strict";
import { test } from "node:test";
import { tocBlock, tocList, updateToc } from "./toc.ts";

const H = [
  { level: 1, id: "十月週報", text: "十月週報" },
  { level: 2, id: "一背景", text: "一、背景" },
  { level: 3, id: "kr1-模型", text: "KR1 模型" },
  { level: 2, id: "二進度", text: "二、進度" },
];

test("目錄：唯一的一級標題當作文件標題，不列入", () => {
  assert.equal(
    tocList(H),
    "- [一、背景](#一背景)\n  - [KR1 模型](#kr1-模型)\n- [二、進度](#二進度)",
  );
  // 有兩個一級標題時都列入
  assert.ok(tocList([...H, { level: 1, id: "附錄", text: "附錄" }]).startsWith("- [十月週報]"));
  // 方括號要跳脫
  assert.equal(tocList([{ level: 2, id: "a", text: "[草稿] 計畫" }]), "- [\\[草稿\\] 計畫](#a)");
});

test("更新既有的目錄區塊", () => {
  const doc = `# 標題\n\n<!-- toc -->\n- [舊的](#舊的)\n<!-- /toc -->\n\n## 一、背景\n`;
  const next = updateToc(doc, H)!;
  assert.ok(next.includes("- [一、背景]"));
  assert.ok(!next.includes("舊的"));
  assert.equal(updateToc(next, H), null); // 已經是最新
  assert.equal(updateToc("沒有目錄", H), null);
  assert.ok(tocBlock([]).includes("還沒有標題"));
});
