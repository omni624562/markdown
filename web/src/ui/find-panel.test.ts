import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { countLabel, countMatches } from "./find-panel.ts";

const doc = "週報 週報\n週報 weekly Weekly";
const at = (from: number, to: number) => EditorState.create({ doc, selection: EditorSelection.single(from, to) });

test("算出符合數量與目前是第幾個", () => {
  const q = new SearchQuery({ search: "週報" });
  assert.deepEqual(countMatches(at(3, 5), q), { current: 2, total: 3, more: false });
  assert.deepEqual(countMatches(at(0, 0), q), { current: 0, total: 3, more: false });
  assert.equal(countMatches(at(0, 0), new SearchQuery({ search: "weekly" })).total, 2);
  assert.equal(countMatches(at(0, 0), new SearchQuery({ search: "weekly", caseSensitive: true })).total, 1);
  assert.deepEqual(countMatches(at(0, 0), q, 2), { current: 0, total: 2, more: true });
});

test("顯示文字", () => {
  assert.equal(countLabel({ current: 2, total: 3, more: false }), "2／3");
  assert.equal(countLabel({ current: 0, total: 3, more: false }), "3 個結果");
  assert.equal(countLabel({ current: 0, total: 1000, more: true }), "1000+ 個結果");
  assert.equal(countLabel({ current: 0, total: 0, more: false }), "沒有結果");
  assert.equal(countLabel({ current: 0, total: 0, more: false }, false), "格式錯誤");
  // 不合法的正規表示式不會丟例外。
  assert.equal(countMatches(at(0, 0), new SearchQuery({ search: "(", regexp: true })).total, 0);
});
