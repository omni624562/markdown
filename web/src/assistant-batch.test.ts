import assert from "node:assert/strict";
import { test } from "node:test";
import { batchActions, batchEstimateUsd, batchFiles, batchSuffix, inFolder, isBatchResult } from "./assistant-batch.ts";
import { ASSISTANT_ACTIONS, customActions, estimateUsd } from "./assistant-text.ts";

test("可以整批做的動作：結果是獨立內容的（摘要、審稿…），取代選取文字的不行", () => {
  const ids = batchActions(ASSISTANT_ACTIONS).map((a) => a.id);
  assert.ok(ids.includes("summary"));
  assert.ok(ids.includes("review"));
  for (const no of ["rewrite", "translate", "diagram", "briefing", "links", "continue"]) assert.ok(!ids.includes(no), no);
  const custom = customActions([
    { name: "會議紀錄", prompt: "整理成會議紀錄", mode: "answer" },
    { name: "改正式", prompt: "改成正式語氣", mode: "replace" },
  ]);
  assert.deepEqual(
    batchActions(custom).map((a) => a.label()),
    ["會議紀錄"],
  );
});

test("結果檔名裡的那一段：拿掉檔名不能用的字元與句點，空的用預設", () => {
  assert.equal(batchSuffix("摘要", "結果"), "摘要");
  assert.equal(batchSuffix(" 會議/紀錄: v1.2 ", "結果"), "會議 紀錄 v1 2");
  assert.equal(batchSuffix("?.*", "結果"), "結果");
  assert.equal(batchSuffix("很".repeat(60), "結果").length, 40);
});

test("資料夾裡要處理的文件：含子資料夾、只有 Markdown、之前的結果不算", () => {
  const root = "C:\\Users\\me\\Documents\\旅遊";
  const docs = [
    { path: `${root}\\行程\\第二天.md` },
    { path: `${root}\\行程\\第一天.md` },
    { path: `${root}\\行程\\住宿\\飯店.MD` },
    { path: `${root}\\行程\\第一天.摘要.md` },
    { path: `${root}\\行程\\第一天.摘要 2.md` },
    { path: `${root}\\行程\\第一天.審稿.md` },
    { path: `${root}\\行程表.md` },
    { path: `${root}\\行程\\地圖.png` },
    { path: null },
  ];
  assert.deepEqual(
    batchFiles(docs, `${root}\\行程`, "摘要").map((d) => d.path.slice(root.length + 1)),
    ["行程\\住宿\\飯店.MD", "行程\\第一天.md", "行程\\第一天.審稿.md", "行程\\第二天.md"],
  );
  // 分隔線、大小寫、結尾的斜線都不影響。
  assert.ok(inFolder("c:/users/me/documents/旅遊/行程/a.md", `${root}\\行程\\`));
  assert.ok(!inFolder(`${root}\\行程`, `${root}\\行程`));
  assert.ok(isBatchResult("v1.2.摘要.md", "摘要"));
  assert.ok(!isBatchResult("摘要.md", "摘要"));
  assert.ok(!isBatchResult("第一天.摘要版.md", "摘要"));
});

test("估計的費用是平常的一半", () => {
  assert.equal(batchEstimateUsd([], "claude-sonnet-5-5"), 0);
  const usual = estimateUsd(3000, "claude-sonnet-5-5") + estimateUsd(500, "claude-sonnet-5-5");
  assert.ok(Math.abs(batchEstimateUsd([3000, 500], "claude-sonnet-5-5") - usual / 2) < 1e-12);
});
