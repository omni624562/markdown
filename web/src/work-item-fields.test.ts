import assert from "node:assert/strict";
import { test } from "node:test";
import { iterationGroups, iterationLabel, parseTags, sameTags } from "./work-item-fields.ts";

test("標籤：逗號、分號、頓號都可以隔開，去掉空白與重複", () => {
  assert.deepEqual(parseTags("UAT, AI 聊天；前端、 uat ,,"), ["UAT", "AI 聊天", "前端"]);
  assert.deepEqual(parseTags("   "), []);
});

test("標籤比較：不分大小寫與順序", () => {
  assert.equal(sameTags(["UAT", "AI 聊天"], ["ai 聊天", "uat"]), true);
  assert.equal(sameTags(["UAT"], ["UAT", "前端"]), false);
  assert.equal(sameTags([], []), true);
});

test("Sprint 名稱去掉專案名稱，專案本身是空字串", () => {
  assert.equal(iterationLabel("P\\Release 1\\Sprint 3"), "Release 1\\Sprint 3");
  assert.equal(iterationLabel("P"), "");
});

test("Sprint 分組：進行中與之後、沒有日期、已結束", () => {
  const now = Date.parse("2026-11-01T08:00:00Z");
  const groups = iterationGroups(
    [
      { path: "P", start: null, finish: null },
      { path: "P\\Sprint 100", start: "2026-10-01T00:00:00Z", finish: "2026-10-14T00:00:00Z" },
      { path: "P\\Sprint 102", start: "2026-11-15T00:00:00Z", finish: "2026-11-28T00:00:00Z" },
      { path: "P\\Sprint 101", start: "2026-10-18T00:00:00Z", finish: "2026-11-01T00:00:00Z" },
      { path: "P\\Sprint 99", start: "2026-09-15T00:00:00Z", finish: "2026-09-28T00:00:00Z" },
      { path: "P\\Backlog", start: null, finish: null },
    ],
    now,
  );
  assert.deepEqual(
    groups.map((g) => [g.kind, g.items.map((o) => `${o.label}${o.current ? "*" : ""}`)]),
    [
      // 結束日當天還算進行中。
      ["upcoming", ["Sprint 101*", "Sprint 102"]],
      ["undated", ["", "Backlog"]],
      ["past", ["Sprint 100", "Sprint 99"]],
    ],
  );
  assert.deepEqual(iterationGroups([{ path: "P", start: null, finish: null }], now).map((g) => g.kind), ["undated"]);
});
