import assert from "node:assert/strict";
import { test } from "node:test";
import { type HeadingLine, hiddenByCollapse, moveSection, sectionRange, subtreeEnd, swapSection } from "./sections.ts";

/** 從文字找出 ATX 標題（測試用；實際由 md-core 提供）。 */
function headingsOf(text: string): HeadingLine[] {
  return text
    .split("\n")
    .map((l, i) => ({ line: i + 1, m: /^(#{1,6}) /.exec(l) }))
    .filter((x) => x.m)
    .map((x) => ({ line: x.line, level: x.m![1].length }));
}

const DOC = `# 標題

前言

## 第一節

一

### 1.1

細節

## 第二節

二

## 第三節

三
`;

test("章節範圍包含子章節", () => {
  const h = headingsOf(DOC);
  assert.deepEqual(sectionRange(h, 1, 17), { first: 5, end: 13 });
  assert.deepEqual(sectionRange(h, 4, 17), { first: 17, end: 18 });
});

test("把第三節拖到第一節前面", () => {
  const h = headingsOf(DOC);
  const out = moveSection(DOC, h, 4, 1)!;
  assert.equal(
    out,
    `# 標題

前言

## 第三節

三

## 第一節

一

### 1.1

細節

## 第二節

二
`,
  );
});

test("把第一節（含子章節）搬到最後", () => {
  const h = headingsOf(DOC);
  const out = moveSection(DOC, h, 1, h.length)!;
  assert.equal(
    out,
    `# 標題

前言

## 第二節

二

## 第三節

三

## 第一節

一

### 1.1

細節
`,
  );
});

test("不能搬進自己的章節裡，位置沒變也不動", () => {
  const h = headingsOf(DOC);
  assert.equal(moveSection(DOC, h, 1, 2), null); // 1.1 在第一節裡
  assert.equal(moveSection(DOC, h, 1, 1), null);
  assert.equal(moveSection(DOC, h, 1, 3), null); // 第二節之前就是原位
});

test("最後一節沒有結尾換行也能搬", () => {
  const text = "## A\n\na\n\n## B\n\nb";
  const out = moveSection(text, headingsOf(text), 1, 0)!;
  assert.equal(out, "## B\n\nb\n\n## A\n\na");
});

test("Alt+↑／↓ 和同級章節交換", () => {
  const h = headingsOf(DOC);
  const down = swapSection(DOC, h, 1, 1)!;
  assert.match(down.text, /## 第二節\n\n二\n\n## 第一節\n\n一\n\n### 1\.1/);
  // 第一節往後移，前面多了「第二節」一個標題。
  assert.equal(down.index, 2);
  const up = swapSection(DOC, h, 3, -1)!;
  assert.match(up.text, /## 第二節\n\n二\n\n## 第一節/);
  assert.equal(up.index, 1);
  assert.equal(swapSection(DOC, h, 4, 1), null); // 已經是最後
  assert.equal(swapSection(DOC, h, 2, -1), null); // 1.1 前面沒有同級章節
});

test("大綱收合：子標題跟著隱藏，收合的標題本身仍顯示", () => {
  //            0  1  2  3  4  5
  const levels = [1, 2, 3, 2, 1, 2];
  assert.equal(subtreeEnd(levels, 0), 4);
  assert.equal(subtreeEnd(levels, 1), 3);
  assert.equal(subtreeEnd(levels, 2), 3);
  assert.equal(subtreeEnd(levels, 5), 6);
  const collapsed = (set: number[]) => hiddenByCollapse(levels, (i) => set.includes(i));
  assert.deepEqual(collapsed([]), [false, false, false, false, false, false]);
  assert.deepEqual(collapsed([1]), [false, false, true, false, false, false]);
  assert.deepEqual(collapsed([0]), [false, true, true, true, false, false]);
  // 外層收合時，裡面的收合不影響外面。
  assert.deepEqual(collapsed([0, 1]), [false, true, true, true, false, false]);
  // 沒有子標題的標題收合也沒有作用。
  assert.deepEqual(collapsed([2, 5]), [false, false, false, false, false, false]);
});
