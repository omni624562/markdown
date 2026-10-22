import assert from "node:assert/strict";
import { test } from "node:test";
import { dateFormats, dateWords } from "./date-complete.ts";

// 2026-10-22 是星期四
const TODAY = new Date(2026, 9, 22);
const words = new Map(dateWords(TODAY).map(([w, d]) => [w, dateFormats(d)[1].text]));

test("相對日期", () => {
  assert.equal(words.get("今天"), "2026-10-22");
  assert.equal(words.get("明天"), "2026-10-23");
  assert.equal(words.get("昨天"), "2026-10-21");
  assert.equal(words.get("月底"), "2026-10-31");
  assert.equal(words.get("下個月"), "2026-11-01");
});

test("星期", () => {
  assert.equal(words.get("這週一"), "2026-10-19");
  assert.equal(words.get("週五"), "2026-10-23", "今天以後最近的星期五");
  assert.equal(words.get("週二"), "2026-10-27", "這週二已經過了，算下週二");
  assert.equal(words.get("週四"), "2026-10-22", "今天就是星期四");
  assert.equal(words.get("下週一"), "2026-10-26");
  assert.equal(words.get("下週日"), "2026-11-01");
  assert.equal(words.get("下週"), "2026-10-26");
});

test("寫法", () => {
  assert.deepEqual(
    dateFormats(TODAY).map((f) => f.text),
    ["2026-10-22（星期四）", "2026-10-22", "民國 115 年 10 月 22 日（星期四）", "10/22"],
  );
});
