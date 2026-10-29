import assert from "node:assert/strict";
import { test } from "node:test";
import { migratePinned, parseDraggedPage, parseShortcuts, placeShortcut, SHORTCUT_LIMIT, shortcutHue, shortcutInitial } from "./wiki-shortcuts.ts";

const s = (path: string, wiki = "w1") => ({ wiki, wikiName: "", path });

test("捷徑：讀取時略過格式不對的", () => {
  assert.deepEqual(parseShortcuts(null), []);
  assert.deepEqual(parseShortcuts("壞掉"), []);
  assert.deepEqual(parseShortcuts(JSON.stringify([s("/A"), { wiki: 1, path: "/B" }, { wiki: "w1", path: "C" }, { wiki: "w2", path: "/D" }])), [s("/A"), s("/D", "w2")]);
});

test("捷徑：拖曳帶過來的頁面", () => {
  assert.deepEqual(parseDraggedPage(JSON.stringify({ wiki: "w1", wikiName: "P.wiki", path: "/安裝" })), { wiki: "w1", wikiName: "P.wiki", path: "/安裝" });
  assert.equal(parseDraggedPage("[文字](https://x)"), null);
  assert.equal(parseDraggedPage(JSON.stringify({ wiki: "w1" })), null);
});

test("捷徑：放到指定位置，已經有的移過去，滿了不能再加", () => {
  const list = [s("/A"), s("/B"), s("/C")];
  assert.deepEqual(placeShortcut(list, s("/D")), [s("/A"), s("/B"), s("/C"), s("/D")]);
  assert.deepEqual(placeShortcut(list, s("/D"), 1), [s("/A"), s("/D"), s("/B"), s("/C")]);
  // 往後移：A 拖到 C 的後面（位置 3）。
  assert.deepEqual(placeShortcut(list, s("/A"), 3), [s("/B"), s("/C"), s("/A")]);
  // 往前移：C 拖到最前面。
  assert.deepEqual(placeShortcut(list, s("/C"), 0), [s("/C"), s("/A"), s("/B")]);
  // 不同 Wiki 的同名頁面是不同捷徑。
  assert.equal(placeShortcut(list, s("/A", "w2"))?.length, 4);
  const full = Array.from({ length: SHORTCUT_LIMIT }, (_, i) => s(`/${i}`));
  assert.equal(placeShortcut(full, s("/新的")), null);
  assert.deepEqual(placeShortcut(full, s("/3"), 0)?.[0], s("/3"));
});

test("捷徑：舊的釘選搬過來（去重、有上限）", () => {
  assert.deepEqual(
    migratePinned([
      { wiki: "w1", pinned: ["/A", "/A", "壞"] },
      { wiki: "w2", pinned: ["/A"] },
    ]),
    [s("/A"), s("/A", "w2")],
  );
  const many = migratePinned([{ wiki: "w1", pinned: Array.from({ length: 40 }, (_, i) => `/${i}`) }]);
  assert.equal(many.length, SHORTCUT_LIMIT);
});

test("捷徑圖示上的字：跳過 emoji 與符號，中文一個字、英文兩個", () => {
  assert.equal(shortcutInitial("消費明細查詢及爭議帳申請"), "消");
  assert.equal(shortcutInitial("📕專案需求對焦專區"), "專");
  assert.equal(shortcutInitial("DGT_00098_新阿發3.0業務中台"), "DG");
  assert.equal(shortcutInitial("home"), "Ho");
  assert.equal(shortcutInitial("1730組專區"), "17");
  assert.equal(shortcutInitial("A專區"), "A");
  assert.equal(shortcutInitial("！！"), "?");
});

test("捷徑圖示的顏色：同一頁每次一樣", () => {
  assert.equal(shortcutHue("w1:/A"), shortcutHue("w1:/A"));
  assert.ok(shortcutHue("w1:/A") >= 0 && shortcutHue("w1:/A") < 360);
  assert.notEqual(shortcutHue("w1:/A"), shortcutHue("w1:/B"));
});
