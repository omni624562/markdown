import assert from "node:assert/strict";
import { test } from "node:test";
import { detailsRegions, lineTokens } from "./details-blocks.ts";

const lines = (text: string) => text.split("\n").map((t, i) => ({ number: i + 1, text: t }));

test("lineTokens 只認可收合區塊的標籤", () => {
  assert.deepEqual(lineTokens("<details><summary>本次差異<b>技術</b>追溯 A&amp;B</summary>"), [
    { kind: "open", open: false },
    { kind: "summary", title: "本次差異技術追溯 A&B" },
  ]);
  assert.deepEqual(lineTokens("  <DETAILS open>"), [{ kind: "open", open: true }]);
  assert.deepEqual(lineTokens("</details>"), [{ kind: "close" }]);
  assert.equal(lineTokens("<div>x</div>"), null);
  assert.equal(lineTokens("<details>內容"), null);
  assert.equal(lineTokens("<detailsx>"), null);
  assert.equal(lineTokens(""), null);
});

test("detailsRegions 找出標題列與結尾列，巢狀也可以", () => {
  const doc = lines(
    [
      "前面",
      "<details>",
      "<summary>外層</summary>",
      "",
      "- 第一點",
      "<details><summary>內層</summary>",
      "",
      "內容",
      "</details>",
      "</details>",
      "<details>",
      "沒有結尾",
    ].join("\n"),
  );
  assert.deepEqual(detailsRegions(doc), [
    { headStart: 2, headEnd: 3, close: 10, title: "外層", open: false },
    { headStart: 6, headEnd: 6, close: 9, title: "內層", open: false },
  ]);
  // 標題和 <details> 中間隔了其他內容：不算標題。
  assert.deepEqual(detailsRegions(lines("<details>\n\n- a\n<summary>x</summary>\n</details>")), [
    { headStart: 1, headEnd: 1, close: 5, title: "", open: false },
  ]);
});
