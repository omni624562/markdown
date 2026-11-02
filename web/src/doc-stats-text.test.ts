import assert from "node:assert/strict";
import { test } from "node:test";
import { GOAL_LIMIT, dayOf, goalProgress, justReached, parseGoal, speakingMinutes, trackToday, withGoal } from "./doc-stats-text.ts";

test("朗讀時間：中文每分鐘約 240 字、英文約 150 個單字，無條件進位", () => {
  assert.equal(speakingMinutes({ cjkChars: 0, latinWords: 0 }), 0);
  assert.equal(speakingMinutes({ cjkChars: 10, latinWords: 0 }), 1);
  assert.equal(speakingMinutes({ cjkChars: 480, latinWords: 0 }), 2);
  assert.equal(speakingMinutes({ cjkChars: 481, latinWords: 0 }), 3);
  assert.equal(speakingMinutes({ cjkChars: 240, latinWords: 150 }), 2);
});

test("字數目標：可以寫千分位、千、萬、k；空白是清除，看不懂的不接受", () => {
  assert.equal(parseGoal("2000"), 2000);
  assert.equal(parseGoal(" 2,000 "), 2000);
  assert.equal(parseGoal("2，000 字"), 2000);
  assert.equal(parseGoal("3k"), 3000);
  assert.equal(parseGoal("2千"), 2000);
  assert.equal(parseGoal("1.5萬"), 15000);
  assert.equal(parseGoal(""), null);
  assert.equal(parseGoal("   "), null);
  assert.equal(parseGoal("0"), undefined);
  assert.equal(parseGoal("-5"), undefined);
  assert.equal(parseGoal("abc"), undefined);
  assert.equal(parseGoal("99999999999"), undefined);
});

test("字數目標的進度與剛好達成", () => {
  assert.deepEqual(goalProgress(500, 2000), { ratio: 0.25, left: 1500, reached: false });
  assert.deepEqual(goalProgress(2500, 2000), { ratio: 1, left: 0, reached: true });
  assert.equal(justReached(1990, 2001, 2000), true);
  assert.equal(justReached(2001, 2050, 2000), false, "已經達成過");
  assert.equal(justReached(null, 2050, 2000), false, "剛換到這份文件");
  assert.equal(justReached(10, 2050, undefined), false, "沒有目標");
});

test("今天的起點：同一天沿用，換日重新記，不是今天的紀錄清掉", () => {
  const day1 = trackToday({}, "a.md", 100, "2026-11-02");
  assert.equal(day1.start, 100);
  assert.equal(day1.changed, true);
  const again = trackToday(day1.map, "a.md", 350, "2026-11-02");
  assert.equal(again.start, 100);
  assert.equal(again.changed, false);
  const day2 = trackToday({ ...again.map, "old.md": { d: "2026-10-01", s: 5 } }, "b.md", 20, "2026-11-03");
  assert.deepEqual(day2.map, { "b.md": { d: "2026-11-03", s: 20 } });
  assert.equal(dayOf(new Date(2026, 0, 5)), "2026-01-05");
});

test("字數目標的對照表：設定、清除，超過上限時丟掉最舊的", () => {
  assert.deepEqual(withGoal({}, "a", 100), { a: 100 });
  assert.deepEqual(withGoal({ a: 100, b: 200 }, "a", null), { b: 200 });
  // 重新設定的排到最後（最近）。
  assert.deepEqual(Object.keys(withGoal({ a: 1, b: 2 }, "a", 3)), ["b", "a"]);
  let goals: Record<string, number> = {};
  for (let i = 0; i < GOAL_LIMIT + 5; i++) goals = withGoal(goals, `doc${i}`, 10);
  assert.equal(Object.keys(goals).length, GOAL_LIMIT);
  assert.equal(goals.doc0, undefined);
  assert.equal(goals[`doc${GOAL_LIMIT + 4}`], 10);
  // 壞掉的值丟掉。
  assert.deepEqual(withGoal({ a: -1, b: 1.5 } as Record<string, number>, "c", 5), { c: 5 });
});
