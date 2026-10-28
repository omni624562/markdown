import assert from "node:assert/strict";
import { test } from "node:test";
import { linksInLine, stateTone } from "./workitem-chips.ts";

test("狀態的顏色", () => {
  assert.equal(stateTone("New"), "new");
  assert.equal(stateTone("Active"), "active");
  assert.equal(stateTone("In Progress"), "active");
  assert.equal(stateTone("Resolved"), "resolved");
  assert.equal(stateTone("Closed"), "done");
  assert.equal(stateTone(" Done "), "done");
  assert.equal(stateTone("Removed"), "removed");
  assert.equal(stateTone("已完成"), "done");
});

test("一行裡的連結", () => {
  const line = "見 [Bug 1](https://x/a) 與 [說明](<https://x/b c>) 還有 https://x/c。";
  assert.deepEqual(
    linksInLine(line).map((l) => [l.url, line.slice(l.end - 1, l.end)]),
    [
      ["https://x/a", ")"],
      ["https://x/b c", ")"],
      ["https://x/c", "c"],
    ],
  );
  assert.deepEqual(linksInLine("沒有連結"), []);
});
