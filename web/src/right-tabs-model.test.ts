import assert from "node:assert/strict";
import { test } from "node:test";
import { RIGHT_TABS, parseRightTab, pickRightTab } from "./right-tabs-model.ts";

test("記住的分頁：認得的照用，不認得的當成沒記", () => {
  assert.equal(parseRightTab("wiki"), "wiki");
  assert.equal(parseRightTab("assistant"), "assistant");
  assert.equal(parseRightTab("bogus"), null);
  assert.equal(parseRightTab(null), null);
  assert.deepEqual(RIGHT_TABS, ["outline", "backlinks", "wiki", "assistant"]);
});

test("選哪一頁：記住的還在就用；不在了用第一個不是助理的；只剩助理時不自動打開", () => {
  assert.equal(pickRightTab("wiki", ["outline", "backlinks", "wiki", "assistant"]), "wiki");
  assert.equal(pickRightTab("wiki", ["outline", "backlinks", "assistant"]), "outline");
  assert.equal(pickRightTab(null, ["outline", "backlinks"]), "outline");
  assert.equal(pickRightTab("assistant", ["outline", "assistant"]), "assistant");
  assert.equal(pickRightTab(null, ["assistant"]), null);
  assert.equal(pickRightTab("outline", ["assistant"]), null);
  assert.equal(pickRightTab(null, []), null);
});
