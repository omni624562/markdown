import assert from "node:assert/strict";
import { test } from "node:test";
import { previousMonth, shiftDay, summarize, type UsageHistory } from "./usage-summary.ts";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("日期往前往後、跨月跨年", () => {
  assert.equal(shiftDay("2026-11-15", -1), "2026-11-14");
  assert.equal(shiftDay("2026-11-01", -1), "2026-10-31");
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDay("2028-02-28", 1), "2028-02-29");
  assert.equal(previousMonth("2026-11"), "2026-10");
  assert.equal(previousMonth("2026-01"), "2025-12");
});

const history: UsageHistory = {
  today: "2026-11-15",
  month: "2026-11",
  usd: 3.5,
  limit: 10,
  days: [
    { date: "2026-10-30", usd: 0.4 },
    { date: "2026-11-08", usd: 1.0 },
    { date: "2026-11-09", usd: 0.25 },
    { date: "2026-11-14", usd: 0.5 },
    { date: "2026-11-15", usd: 0.75 },
  ],
  months: [{ month: "2026-10", usd: 6.2 }],
};

test("今天、最近 7 天（含今天）、這個月、上個月", () => {
  const s = summarize(history);
  near(s.today, 0.75);
  // 11/9～11/15：11/8 不算。
  near(s.last7, 0.25 + 0.5 + 0.75);
  near(s.month, 3.5);
  near(s.lastMonth!, 6.2);
  assert.equal(s.lastMonthName, "2026-10");
  assert.equal(s.since, "2026-10-30");
});

test("這個月的總額比每日紀錄多：多的部分是升級前沒有每日紀錄的", () => {
  // 每日紀錄加起來 2.5，總額 3.5。
  near(summarize(history).untracked, 1.0);
  near(summarize({ ...history, usd: 2.5 }).untracked, 0);
  // 加總的小誤差不算。
  near(summarize({ ...history, usd: 2.5000001 }).untracked, 0);
});

test("最近幾天由新到舊，沒有用量的日子補 0", () => {
  const s = summarize(history, 4);
  assert.deepEqual(
    s.recent.map((d) => d.date),
    ["2026-11-15", "2026-11-14", "2026-11-13", "2026-11-12"],
  );
  assert.deepEqual(
    s.recent.map((d) => d.usd),
    [0.75, 0.5, 0, 0],
  );
});

test("上個月沒有收起來的總額：用每日紀錄；完全沒有紀錄是 null，不是 0", () => {
  near(summarize({ ...history, months: [] }).lastMonth!, 0.4);
  assert.equal(summarize({ ...history, months: [], days: history.days.slice(1) }).lastMonth, null);
});

test("還沒有任何紀錄", () => {
  const s = summarize({ today: "2026-11-15", month: "2026-11", usd: 0, limit: 10, days: [], months: [] });
  assert.deepEqual([s.today, s.last7, s.month, s.lastMonth, s.untracked, s.since], [0, 0, 0, null, 0, null]);
});
