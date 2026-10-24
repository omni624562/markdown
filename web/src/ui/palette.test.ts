import assert from "node:assert/strict";
import { test } from "node:test";
import type { Command } from "../commands.ts";
import { paletteItems, sortByGroup } from "./palette.ts";

const cmd = (id: string, group: string, title = id): Command => ({ id, title, group, run() {} });
const all = [cmd("help", "說明"), cmd("bold", "格式"), cmd("new", "檔案"), cmd("save", "檔案"), cmd("palette", "說明"), cmd("x", "其他")];

test("依分類的固定順序排列，同一分類保持原本順序，沒列到的分類排最後", () => {
  assert.deepEqual(
    sortByGroup(all).map((c) => c.id),
    ["new", "save", "bold", "help", "palette", "x"],
  );
});

test("沒有輸入時：最近使用在最前面，其餘分區；不列出指令面板自己", () => {
  const items = paletteItems(all, "", ["bold", "gone"]);
  assert.deepEqual(
    items.map((i) => `${i.section}:${i.c.id}`),
    ["最近使用:bold", "檔案:new", "檔案:save", "說明:help", "其他:x"],
  );
});

test("輸入時依符合程度排序、不分區", () => {
  const items = paletteItems(all, "save", []);
  assert.equal(items[0].c.id, "save");
  assert.ok(items.every((i) => i.section === undefined));
});
