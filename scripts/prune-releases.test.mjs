import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVersion, plan } from "./prune-releases.mjs";

test("只認 v<主>.<次>.<修> 的版本號標籤", () => {
  assert.deepEqual(parseVersion("v1.121.1"), [1, 121, 1]);
  assert.equal(parseVersion("latest"), null);
  assert.equal(parseVersion("stable"), null);
  assert.equal(parseVersion("v1.2"), null);
  assert.equal(parseVersion("1.2.3"), null);
});

test("依版本號（不是字串）排序，保留最新的幾個，其他的刪掉；latest、stable 不在清理範圍", () => {
  const tags = ["latest", "v1.9.0", "v1.121.1", "v1.10.0", "v1.121.0", "v1.120.0", "stable", "v1.2.2", "v1.121.0"];
  assert.deepEqual(plan(tags, 3), {
    keep: ["v1.121.1", "v1.121.0", "v1.120.0"],
    remove: ["v1.10.0", "v1.9.0", "v1.2.2"],
  });
});

test("穩定版指向的舊版本一定保留", () => {
  const { keep, remove } = plan(["v1.5.0", "v1.4.0", "v1.3.0", "v1.2.0", "v1.1.0"], 2, ["v1.2.0"]);
  assert.deepEqual(keep, ["v1.5.0", "v1.4.0", "v1.2.0"]);
  assert.deepEqual(remove, ["v1.3.0", "v1.1.0"]);
});

test("版本不多時什麼都不刪；保留數量要是 1 以上的整數", () => {
  assert.deepEqual(plan(["v1.0.0", "latest"], 3), { keep: ["v1.0.0"], remove: [] });
  assert.throws(() => plan(["v1.0.0"], 0));
  assert.throws(() => plan(["v1.0.0"], Number.NaN));
});
