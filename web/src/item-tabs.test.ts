import assert from "node:assert/strict";
import test from "node:test";
import { neighborAfterClose, parseSavedItemTabs, placeItem } from "./item-tabs.ts";

test("開啟時：已經開著就切過去，否則換掉預覽分頁，要留著的或沒有預覽分頁時新開", () => {
  const tabs = [
    { key: "ado:1", preview: false },
    { key: "ado:2", preview: true },
  ];
  assert.deepEqual(placeItem(tabs, "ado:2", false), { kind: "same", index: 1 });
  assert.deepEqual(placeItem(tabs, "ado:1", true), { kind: "same", index: 0 });
  assert.deepEqual(placeItem(tabs, "ado:3", false), { kind: "preview", index: 1 });
  assert.deepEqual(placeItem(tabs, "ado:3", true), { kind: "new" });
  assert.deepEqual(placeItem([{ key: "ado:1", preview: false }], "ado:3", false), { kind: "new" });
  assert.deepEqual(placeItem([], "ado:3", false), { kind: "new" });
});

test("關掉分頁後切到右邊那一個，最右邊時切到左邊", () => {
  assert.equal(neighborAfterClose(["a", "b", "c"], "b"), "c");
  assert.equal(neighborAfterClose(["a", "b", "c"], "c"), "b");
  assert.equal(neighborAfterClose(["a"], "a"), null);
  assert.equal(neighborAfterClose(["a"], "x"), null);
});

test("讀回存下的分頁", () => {
  const raw = JSON.stringify([
    { key: "ado:1", name: "修正登入", title: "Bug 1：修正登入", origin: "ado", preview: true, ref: { workItem: 1, kind: "Bug", title: "修正登入" } },
    { key: "wiki:w:/安裝", name: "安裝", origin: "wiki", preview: true, ref: { wiki: "w", wikiName: "P.wiki", path: "/安裝" } },
    { key: "ado:1", name: "重複", origin: "ado", ref: { workItem: 1, kind: "Bug", title: "x" } },
    { key: "github:3", name: "不能還原", origin: "github", ref: { workItem: 3, kind: "Bug", title: "x" } },
    { key: "ado:4", name: "壞的", origin: "ado", ref: { workItem: -4 } },
    "x",
  ]);
  assert.deepEqual(parseSavedItemTabs(raw), [
    { key: "ado:1", name: "修正登入", title: "Bug 1：修正登入", origin: "ado", preview: true, ref: { workItem: 1, kind: "Bug", title: "修正登入" } },
    // 預覽分頁只留一個；沒有滑鼠提示時用名稱。
    { key: "wiki:w:/安裝", name: "安裝", title: "安裝", origin: "wiki", preview: false, ref: { wiki: "w", wikiName: "P.wiki", path: "/安裝" } },
  ]);
  assert.deepEqual(parseSavedItemTabs(null), []);
  assert.deepEqual(parseSavedItemTabs("{"), []);
  assert.deepEqual(parseSavedItemTabs("{}"), []);
});
