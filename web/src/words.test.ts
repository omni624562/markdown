import assert from "node:assert/strict";
import { test } from "node:test";
import { wordAt, wordLeft, wordRight } from "./words.ts";

test("中文按詞往右移：今天｜討論｜了", () => {
  const t = "今天討論了編輯器";
  const stops: number[] = [];
  let pos = 0;
  for (let i = 0; i < 3; i++) {
    pos = wordRight(t, pos)!;
    stops.push(pos);
  }
  assert.deepEqual(stops, [2, 4, 5]);
});

test("中文按詞往左移", () => {
  const t = "今天討論了編輯器";
  assert.equal(wordLeft(t, 5), 4);
  assert.equal(wordLeft(t, 4), 2);
  assert.equal(wordLeft(t, 3), 2);
  assert.equal(wordLeft(t, 0), null);
});

test("旁邊不是中文時交回原本的行為", () => {
  const t = "我們用Rust重寫";
  assert.equal(wordRight(t, 3), null); // 右邊是 R
  assert.equal(wordLeft(t, 7), null); // 左邊是 t
  assert.equal(wordRight(t, 7), 9); // 右邊是「重」
  assert.equal(wordRight("hello world", 0), null);
  assert.equal(wordLeft("中文，", 3), null); // 左邊是全形逗號
});

test("雙擊選詞", () => {
  const t = "中華民國臺灣的筆記軟體 note";
  assert.deepEqual(wordAt(t, 1), { from: 0, to: 4 });
  assert.deepEqual(wordAt(t, 4), { from: 4, to: 6 });
  assert.deepEqual(wordAt(t, 11), { from: 9, to: 11 }); // 行末的詞，看左邊的字
  assert.equal(wordAt(t, 13), null);
});
