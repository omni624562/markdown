import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutGraph, type GraphInput } from "./git-graph.ts";

const c = (id: string, ...parents: string[]): GraphInput => ({ id, parents });
const seg = (s: { from: number; to: number }) => `${s.from}>${s.to}`;

test("一直線：都在第 0 條線，上下接起來", () => {
  const { rows, width } = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
  assert.equal(width, 1);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.deepEqual(rows[0].top, []);
  assert.deepEqual(rows[1].top.map(seg), ["0>0"]);
  // 最早的提交沒有往下的線。
  assert.deepEqual(rows[2].bottom, []);
  assert.equal(new Set(rows.map((r) => r.color)).size, 1);
});

test("分支與合併：合併提交往右開一條線，兩條線在共同的提交收回來", () => {
  // m 合併了 b（主線）與 x（分支），兩邊都從 a 分出來。
  const { rows, width } = layoutGraph([c("m", "b", "x"), c("x", "a"), c("b", "a"), c("a")]);
  assert.equal(width, 2);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0, 0]);
  assert.deepEqual(rows[0].bottom.map(seg), ["0>0", "0>1"]);
  // x 在第 1 條線往下等 a；主線第 0 條直直通過。
  assert.deepEqual(rows[1].top.map(seg).sort(), ["0>0", "1>1"]);
  // b 也等 a，但留在自己的線上；兩條線在 a 那一列收回來。
  assert.deepEqual(rows[2].bottom.map(seg).sort(), ["0>0", "1>1"]);
  assert.deepEqual(rows[3].top.map(seg).sort(), ["0>0", "1>0"]);
  assert.notEqual(rows[0].color, rows[1].color);
});

test("兩個分支各自的最新提交：第二個開新的一條線", () => {
  const { rows } = layoutGraph([c("main2", "base"), c("draft", "base"), c("base")]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0]);
  assert.deepEqual(rows[2].top.map(seg).sort(), ["0>0", "1>0"]);
});

test("載入的範圍裡沒有上層提交時，線一直往下延伸", () => {
  const { rows } = layoutGraph([c("b", "a"), c("y", "x")]);
  assert.deepEqual(rows[1].top.map(seg), ["0>0"]);
  assert.deepEqual(rows[1].bottom.map(seg).sort(), ["0>0", "1>1"]);
});

test("還沒提交的變更（虛擬列）接在目前的提交上", () => {
  const { rows } = layoutGraph([c("__worktree__", "h"), c("h", "g"), c("g")]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
});

test("八條以上的線：顏色循環使用，寬度跟著變大", () => {
  const heads = Array.from({ length: 10 }, (_, i) => c(`h${i}`, "root"));
  const { rows, width } = layoutGraph([...heads, c("root")]);
  assert.equal(width, 10);
  assert.equal(rows[8].color, rows[0].color);
  assert.equal(rows.at(-1)!.top.length, 10);
});
