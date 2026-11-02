import assert from "node:assert/strict";
import { test } from "node:test";
import { AdoOnline, OfflineError } from "./ado-online.ts";

test("連得上時不擋任何指令", async () => {
  const o = new AdoOnline(() => 0);
  await o.check("ado_work_items", "離線");
  await o.check("ado_work_item_update", "離線");
});

test("離線時 Azure DevOps 指令直接失敗；連線檢查、帳號設定與其他指令照常", async () => {
  let now = 1000;
  const o = new AdoOnline(() => now);
  o.set(true);
  await assert.rejects(o.check("ado_work_items", "目前離線"), (e) => e instanceof OfflineError && e.message === "目前離線");
  await o.check("ado_ping", "目前離線");
  await o.check("ado_account", "目前離線");
  await o.check("open_file", "目前離線");
  now += 5000;
  await assert.rejects(o.check("ado_wiki_save", "目前離線"), OfflineError);
});

test("離線一陣子後，下一個指令先重新檢查；恢復了就照常送出並通知", async () => {
  let now = 1000;
  const o = new AdoOnline(() => now);
  const changes: boolean[] = [];
  o.listen((off) => changes.push(off));
  let checks = 0;
  let back = false;
  o.setRecheck(async () => (checks++, !back));
  o.set(true);
  now += 20_000;
  await assert.rejects(o.check("ado_work_items", "離線"), OfflineError);
  assert.equal(checks, 1);
  // 剛檢查過：不再檢查。
  await assert.rejects(o.check("ado_work_items", "離線"), OfflineError);
  assert.equal(checks, 1);
  back = true;
  now += 20_000;
  await o.check("ado_work_items", "離線");
  assert.equal(checks, 2);
  assert.equal(o.offline, false);
  assert.deepEqual(changes, [true, false]);
});
