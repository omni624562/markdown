import assert from "node:assert/strict";
import { test } from "node:test";
import { activity, colorIndex, commitWebUrl, initials, level } from "./git-history-text.ts";

test("頭像縮寫：中文取第一個字，英文取字首", () => {
  assert.equal(initials("王小明"), "王");
  assert.equal(initials("Ada Lovelace"), "AL");
  assert.equal(initials("omni624562"), "OM");
  assert.equal(initials("  "), "?");
  assert.equal(colorIndex("a@b.c"), colorIndex("A@B.C"));
});

test("提交的網頁連結：GitHub、Azure DevOps，去掉帳號密碼", () => {
  assert.equal(
    commitWebUrl("https://user:token@github.com/o/r.git", "abc"),
    "https://github.com/o/r/commit/abc",
  );
  assert.equal(
    commitWebUrl("https://dev.azure.com/org/proj/_git/repo", "abc"),
    "https://dev.azure.com/org/proj/_git/repo/commit/abc",
  );
  assert.equal(commitWebUrl("https://gitlab.com/o/r", "abc"), null);
  assert.equal(commitWebUrl("git@github.com:o/r.git", "abc"), null);
  assert.equal(commitWebUrl(null, "abc"), null);
});

test("活動統計：依提交當地的日期分組，最右邊一欄是這一週", () => {
  const today = new Date(2026, 9, 24); // 2026-10-24 星期六
  const at = (iso: string) => Date.parse(iso) / 1000;
  const commits = [
    // 台北時間 10/24 上午 1 點 = UTC 10/23 17:00。
    { author: "王", time: at("2026-10-23T17:00:00Z"), offset: 480 },
    { author: "王", time: at("2026-10-24T02:00:00Z"), offset: 480 },
    { author: "Ada", time: at("2026-10-19T02:00:00Z"), offset: 480 },
  ];
  const a = activity(commits, today, 2);
  assert.equal(a.weeks.length, 2);
  const lastWeek = a.weeks[1];
  assert.equal(lastWeek[6]?.date, "2026-10-24");
  assert.equal(lastWeek[6]?.count, 2);
  assert.equal(lastWeek[1]?.count, 1);
  assert.equal(a.total, 3);
  assert.equal(a.max, 2);
  assert.deepEqual(a.authors, [
    { name: "王", count: 2 },
    { name: "Ada", count: 1 },
  ]);
  // 星期三：這一週還沒到的日子是 null。
  const wed = activity([], new Date(2026, 9, 21), 1);
  assert.equal(wed.weeks[0][3]?.date, "2026-10-21");
  assert.equal(wed.weeks[0][4], null);
  assert.equal(level(0, 5), 0);
  assert.equal(level(5, 5), 4);
  assert.equal(level(1, 5), 1);
});
