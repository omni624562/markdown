import assert from "node:assert/strict";
import test from "node:test";
import { type ItemPlacing, arrangeTabs, neighborAfterClose, parseSavedItemTabs, placeItem, placeNewItem } from "./item-tabs.ts";

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
    { key: "ado:1", name: "修正登入", title: "Bug 1：修正登入", origin: "ado", preview: true, ref: { workItem: 1, kind: "Bug", title: "修正登入" }, after: null, pinned: false },
    // 預覽分頁只留一個；沒有滑鼠提示時用名稱。
    { key: "wiki:w:/安裝", name: "安裝", title: "安裝", origin: "wiki", preview: false, ref: { wiki: "w", wikiName: "P.wiki", path: "/安裝" }, after: null, pinned: false },
  ]);
  // 位置與固定；固定的不是預覽分頁。
  const placed = parseSavedItemTabs(
    JSON.stringify([{ key: "ado:5", name: "x", origin: "ado", preview: true, pinned: true, after: "d1", ref: { workItem: 5, kind: "Task", title: "x" } }]),
  );
  assert.equal(placed[0].after, "d1");
  assert.equal(placed[0].pinned, true);
  assert.equal(placed[0].preview, false);
  assert.deepEqual(parseSavedItemTabs(null), []);
  assert.deepEqual(parseSavedItemTabs("{"), []);
  assert.deepEqual(parseSavedItemTabs("{}"), []);
});

test("分頁的順序：固定的在前，項目接在它後面的文件後面", () => {
  const docs = [{ id: "p", pinned: true }, { id: "a" }, { id: "b" }];
  const items = [
    { id: "i1", after: "a", pinned: false },
    { id: "i2", after: null, pinned: false },
    { id: "i3", after: "b", pinned: false },
    { id: "i4", after: "a", pinned: false },
    { id: "i5", after: "p", pinned: false },
    { id: "i6", after: "gone", pinned: false },
    { id: "i7", after: "b", pinned: true },
  ];
  assert.deepEqual(arrangeTabs(docs, items), ["p", "i7", "i2", "i5", "a", "i1", "i4", "b", "i3", "i6"]);
  assert.deepEqual(arrangeTabs([{ id: "a" }], []), ["a"]);
});

test("新的項目分頁放在目前分頁的右邊", () => {
  const docs = [{ id: "p", pinned: true }, { id: "a" }, { id: "b" }];
  const items = [
    { id: "i1", after: "a", pinned: false },
    { id: "i2", after: "a", pinned: false },
    { id: "i3", after: "b", pinned: false },
    { id: "i9", after: "b", pinned: true },
  ];
  // 目前是文件 a：接在 a 後面、排在 a 原有的項目前面。
  assert.deepEqual(placeNewItem(docs, items, "a"), { after: "a", index: 0 });
  // 目前是項目 i1：緊接在 i1 後面。
  assert.deepEqual(placeNewItem(docs, items, "i1"), { after: "a", index: 1 });
  // 目前是文件 b（後面已經有 i3）。
  assert.deepEqual(placeNewItem(docs, items, "b"), { after: "b", index: 2 });
  // 目前是固定的文件或項目：放在一般分頁最前面。
  assert.deepEqual(placeNewItem(docs, items, "p"), { after: null, index: 4 });
  assert.deepEqual(placeNewItem(docs, items, "i9"), { after: null, index: 4 });
  // 新的放進去後，順序符合「右邊」。
  const next: ItemPlacing[] = [...items];
  const at = placeNewItem(docs, items, "a");
  next.splice(at.index, 0, { id: "new", after: at.after, pinned: false });
  assert.deepEqual(arrangeTabs(docs, next), ["p", "i9", "a", "new", "i1", "i2", "b", "i3"]);
});
