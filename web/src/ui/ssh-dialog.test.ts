import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTKEY_DECLINED, jumpPasswordHost } from "./ssh-dialog.ts";

test("跳板主機要密碼時，原生端回傳的代碼帶著跳板主機的名稱", () => {
  assert.equal(jumpPasswordHost("NEED_JUMP_PASSWORD\nwang@jump.example:22"), "wang@jump.example:22");
  assert.equal(jumpPasswordHost("NEED_JUMP_PASSWORD\nwang@[fe80::1]:2200"), "wang@[fe80::1]:2200");
  // 目標主機要密碼、其他錯誤：不是跳板主機的密碼。
  assert.equal(jumpPasswordHost("NEED_PASSWORD"), null);
  assert.equal(jumpPasswordHost(HOSTKEY_DECLINED), null);
  assert.equal(jumpPasswordHost("無法登入跳板主機 jump.example：帳號、密碼或金鑰不正確"), null);
});
