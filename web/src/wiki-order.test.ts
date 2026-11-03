import assert from "node:assert/strict";
import { test } from "node:test";
import { dropIndex, movePage, parentOf, siblingsOf, type OrderedPage } from "./wiki-order.ts";

const tree = (): OrderedPage[] => [
  { path: "/A", children: [] },
  {
    path: "/B",
    children: [
      { path: "/B/1", children: [] },
      { path: "/B/2", children: [] },
      { path: "/B/3", children: [] },
    ],
  },
  { path: "/C", children: [] },
];
const paths = (list: OrderedPage[] | null) => list?.map((p) => p.path);

test("上層與同一層的頁面", () => {
  assert.equal(parentOf("/A"), "");
  assert.equal(parentOf("/B/1"), "/B");
  assert.deepEqual(paths(siblingsOf(tree(), "/C")), ["/A", "/B", "/C"]);
  assert.deepEqual(paths(siblingsOf(tree(), "/B/2")), ["/B/1", "/B/2", "/B/3"]);
  assert.equal(siblingsOf(tree(), "/B/9"), null);
  assert.equal(siblingsOf(tree(), "/X/1"), null);
});

test("拖到前面或後面：搬完之後的位置", () => {
  const t = tree();
  // 往上：拖到 /B/1 前面 → 第 0 個。
  assert.equal(dropIndex(t, "/B/3", "/B/1", false), 0);
  assert.equal(dropIndex(t, "/B/3", "/B/1", true), 1);
  // 往下：先拿掉自己，後面的往前一格。
  assert.equal(dropIndex(t, "/B/1", "/B/3", true), 2);
  assert.equal(dropIndex(t, "/B/1", "/B/3", false), 1);
  // 位置沒變、拖到自己、不同層：不動。
  assert.equal(dropIndex(t, "/B/1", "/B/2", false), null);
  assert.equal(dropIndex(t, "/B/2", "/B/1", true), null);
  assert.equal(dropIndex(t, "/B/2", "/B/2", true), null);
  assert.equal(dropIndex(t, "/B/2", "/C", false), null);
  assert.equal(dropIndex(t, "/A", "/B/1", false), null);
});

test("移到新的位置，回傳原本的位置（失敗時放回去）", () => {
  const t = tree();
  assert.equal(movePage(t, "/C", 0), 2);
  assert.deepEqual(paths(t), ["/C", "/A", "/B"]);
  assert.equal(movePage(t, "/B/1", 2), 0);
  assert.deepEqual(paths(t[2].children), ["/B/2", "/B/3", "/B/1"]);
  // 放回去。
  movePage(t, "/B/1", 0);
  assert.deepEqual(paths(t[2].children), ["/B/1", "/B/2", "/B/3"]);
  // 超出範圍時放到最後；找不到時不動。
  movePage(t, "/A", 99);
  assert.deepEqual(paths(t), ["/C", "/B", "/A"]);
  assert.equal(movePage(t, "/X", 0), -1);
});
