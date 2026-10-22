import assert from "node:assert/strict";
import { test } from "node:test";
import { isInsecureUrl, workItemLink } from "./ado-text.ts";

test("工作項目連結會跳脫標題裡的中括號與網址裡的括號、空白", () => {
  assert.equal(
    workItemLink({ id: 42, title: "修正 [登入] 問題", webUrl: "https://tfs/DC/產品/_workitems/edit/42" }),
    "[#42 修正 \\[登入\\] 問題](https://tfs/DC/產品/_workitems/edit/42)",
  );
  assert.equal(
    workItemLink({ id: 7, title: "", webUrl: "https://tfs/DC/My Project(1)/_workitems/edit/7" }),
    "[#7](https://tfs/DC/My%20Project%281%29/_workitems/edit/7)",
  );
});

test("http 網址要提醒沒有加密", () => {
  assert.ok(isInsecureUrl("http://tfs:8080/tfs"));
  assert.ok(!isInsecureUrl("https://tfs.corp.com/tfs"));
});
