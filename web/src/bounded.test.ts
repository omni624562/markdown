import assert from "node:assert/strict";
import { test } from "node:test";
import { setBounded } from "./bounded.ts";

test("超過上限時刪掉最久沒有更新的", () => {
  const m = new Map<number, string>();
  for (let i = 0; i < 5; i++) setBounded(m, i, `v${i}`, 3);
  assert.deepEqual([...m.keys()], [2, 3, 4]);
  setBounded(m, 2, "新", 3);
  setBounded(m, 9, "v9", 3);
  assert.deepEqual([...m.keys()], [4, 2, 9]);
  assert.equal(m.get(2), "新");
});
