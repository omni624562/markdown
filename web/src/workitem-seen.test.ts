import assert from "node:assert/strict";
import { test } from "node:test";
import { markAllSeen, markOf, markSeen, remember, trimSeen } from "./workitem-seen.ts";

const a = { id: 1, changed: "2026-10-20T01:00:00Z" };
const b = { id: 2, changed: "2026-10-21T01:00:00.12Z" };

test("第一次使用：目前的項目都當成看過", () => {
  const { seen, changed } = remember(null, [a, b], true);
  assert.ok(changed);
  assert.equal(markOf(seen, a), null);
  assert.equal(markOf(seen, b), null);
  assert.equal(markOf(null, a), null, "還沒有記錄時不標示");
});

test("指派給你的清單上出現沒看過的項目：新的；其他清單：直接當成看過", () => {
  const base = remember(null, [a], true).seen;
  const mine = remember(base, [a, b], true);
  assert.equal(markOf(mine.seen, b), "new");
  assert.equal(mine.changed, false);
  const other = remember(base, [b], false);
  assert.equal(markOf(other.seen, b), null);
  assert.ok(other.changed);
});

test("看過之後有更新；開啟後清掉標示", () => {
  const seen = remember(null, [a], true).seen;
  const later = { ...a, changed: "2026-10-22T08:00:00.5Z" };
  assert.equal(markOf(seen, later), "updated");
  const after = markSeen(seen, later);
  assert.ok(after.changed);
  assert.equal(markOf(after.seen, later), null);
  assert.equal(markSeen(after.seen, later).changed, false, "已經看過就不用再存");
  assert.equal(markOf(seen, { ...a, changed: null }), null);
});

test("只留最近更新的項目", () => {
  const seen = { "1": 10, "2": 30, "3": 20 };
  assert.deepEqual(trimSeen(seen, 2), { "2": 30, "3": 20 });
  assert.equal(trimSeen(seen, 5), seen);
});

test("搜尋記下很多比較新的項目時，指派給你的項目不會被擠掉", () => {
  // 指派給你的項目（比較久沒更新）先看過。
  const mine = [a, b];
  let seen = remember(null, mine, true).seen;
  // 搜尋出 600 個比較新的項目。
  const search = Array.from({ length: 600 }, (_, i) => ({ id: 1000 + i, changed: "2026-10-29T00:00:00Z" }));
  seen = remember(seen, search, false).seen;
  seen = trimSeen(seen, 500, new Set(mine.map((w) => w.id)));
  assert.equal(Object.keys(seen).length, 500);
  assert.equal(markOf(seen, a), null, "沒有變成新的");
  assert.equal(markOf(seen, b), null);
});

test("全部標示為看過", () => {
  const seen = remember(null, [a], true).seen;
  const later = { ...a, changed: "2026-10-22T08:00:00Z" };
  const c = { id: 3, changed: "2026-10-23T08:00:00Z" };
  assert.equal(markOf(seen, later), "updated");
  assert.equal(markOf(seen, c), "new");
  const all = markAllSeen(seen, [later, c]);
  assert.equal(markOf(all, later), null);
  assert.equal(markOf(all, c), null);
});
