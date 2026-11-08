import assert from "node:assert/strict";
import { test } from "node:test";
import { linksInLine } from "./workitem-chips.ts";

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
