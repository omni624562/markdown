import assert from "node:assert/strict";
import { test } from "node:test";
import { type Choice, favoriteOptions, favoritesFirst, parseFavorites } from "./favorites.ts";

const items: Choice[] = [
  ["a", "ALM"],
  ["b", "CUB"],
  ["c", "Contoso"],
  ["d", "MIDL"],
];

test("沒設常用：全部列出，沒有切換", () => {
  assert.deepEqual(favoriteOptions(items, [], false, "a"), { items, toggle: null, total: 4 });
  assert.equal(favoriteOptions(items, ["已經不在的"], false, "a").toggle, null, "常用的都不在清單裡也一樣");
});

test("有常用：只列常用的（照原本順序），最下面是「顯示全部」", () => {
  const o = favoriteOptions(items, ["d", "b"], false, "b");
  assert.deepEqual(
    o.items.map(([v]) => v),
    ["b", "d"],
  );
  assert.equal(o.toggle, "all");
  assert.equal(o.total, 4);
});

test("目前選的不是常用的：也留在選單裡", () => {
  assert.deepEqual(
    favoriteOptions(items, ["d"], false, "a").items.map(([v]) => v),
    ["a", "d"],
  );
});

test("顯示全部：全部列出，最下面是「只顯示常用」", () => {
  const o = favoriteOptions(items, ["d"], true, "d");
  assert.equal(o.items.length, 4);
  assert.equal(o.toggle, "favorites");
});

test("常用的排前面；存下來的清單壞掉就當沒有", () => {
  assert.deepEqual(
    favoritesFirst(items, ["c"]).map(([v]) => v),
    ["c", "a", "b", "d"],
  );
  assert.deepEqual(parseFavorites('["a",1,"b"]'), ["a", "b"]);
  assert.deepEqual(parseFavorites("{壞掉"), []);
  assert.deepEqual(parseFavorites(null), []);
});
