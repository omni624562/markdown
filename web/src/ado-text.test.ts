import assert from "node:assert/strict";
import { test } from "node:test";
import { adoRepoNameFrom, isInsecureUrl, workItemLink } from "./ado-text.ts";

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

test("Azure DevOps 儲存庫名稱：中文與空白照用，不能用的符號換成 -，頭尾的 . _ 拿掉", () => {
  assert.equal(adoRepoNameFrom("產品筆記"), "產品筆記");
  assert.equal(adoRepoNameFrom("Contoso 週報"), "Contoso 週報");
  assert.equal(adoRepoNameFrom("a/b:c*d?"), "a-b-c-d");
  assert.equal(adoRepoNameFrom("_.hidden."), "hidden");
  assert.equal(adoRepoNameFrom("[產品]#1"), "產品-1");
  assert.equal(adoRepoNameFrom("???"), "notes");
  assert.equal([...adoRepoNameFrom("週".repeat(80))].length, 64);
});
