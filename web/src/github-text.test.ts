import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, repoNameFrom } from "./github-text.ts";

test("資料夾名稱轉成 GitHub 允許的儲存庫名稱", () => {
  assert.equal(repoNameFrom("my notes"), "my-notes");
  assert.equal(repoNameFrom("週報 2026"), "2026");
  assert.equal(repoNameFrom("筆記"), "notes");
  assert.equal(repoNameFrom("--a..b--"), "a..b");
  assert.equal(repoNameFrom("Ｗｏｒｋ"), "Work");
});

test("相對時間", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  assert.equal(ago("2026-10-22T01:00:00Z", now), "今天更新");
  assert.equal(ago("2026-10-19T12:00:00Z", now), "3 天前更新");
  assert.equal(ago("2026-07-01T12:00:00Z", now), "3 個月前更新");
  assert.equal(ago(null, now), "");
});
