import assert from "node:assert/strict";
import test from "node:test";
import { choiceList, choiceSummary, normalizeChoice } from "./multi-choice.ts";

test("都不勾或全部勾都等於不限", () => {
  assert.deepEqual(normalizeChoice([], ["Bug", "Task"]), []);
  assert.deepEqual(normalizeChoice(["Task", "Bug"], ["Bug", "Task"]), []);
  assert.deepEqual(normalizeChoice(["Bug", "Bug", " "], ["Bug", "Task"]), ["Bug"]);
  // 只有一個選項時，勾了就是勾了。
  assert.deepEqual(normalizeChoice(["Bug"], ["Bug"]), ["Bug"]);
  // 選項還沒讀到時，保留原本選的。
  assert.deepEqual(normalizeChoice(["Epic"], []), ["Epic"]);
  // 照選項的順序。
  assert.deepEqual(normalizeChoice(["Task", "Old", "Bug"], ["Bug", "Epic", "Task"]), ["Bug", "Task", "Old"]);
});

test("按鈕上的文字", () => {
  const same = (v: string) => v;
  assert.equal(choiceSummary([], same, "所有類型"), "所有類型");
  assert.equal(choiceSummary(["Bug"], same, "所有類型"), "Bug");
  assert.equal(choiceSummary(["Bug", "Task"], same, "所有類型"), "Bug、Task");
  assert.equal(choiceSummary(["Bug", "Task", "Epic"], same, "所有類型"), "Bug 等 3 項");
  assert.equal(choiceSummary(["P\\前端"], (v) => v.slice(2), "所有區域"), "前端");
});

test("讀回舊版的單一值與新版的陣列", () => {
  assert.deepEqual(choiceList("Bug"), ["Bug"]);
  assert.deepEqual(choiceList(""), []);
  assert.deepEqual(choiceList(null), []);
  assert.deepEqual(choiceList(["A", 3, "", "B"]), ["A", "B"]);
});
