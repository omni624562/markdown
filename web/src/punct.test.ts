import assert from "node:assert/strict";
import { test } from "node:test";
import { findPunctuation, punctKey } from "./punct.ts";

const fix = (text: string, skip: [number, number][] = []) => {
  let out = text;
  for (const m of findPunctuation(text, skip).reverse()) out = out.slice(0, m.from) + m.term.to[0] + out.slice(m.to);
  return out;
};

test("中文句子裡的半形標點改成全形", () => {
  assert.equal(fix("今天開會, 討論預算.明天再說!真的嗎?"), "今天開會，討論預算。明天再說！真的嗎？");
  assert.equal(fix("時間: 10:00"), "時間：10:00");
  assert.equal(fix("注意;這很重要"), "注意；這很重要");
  assert.equal(fix("結束了.\n下一段"), "結束了。\n下一段");
});

test("數字、英文、網址、刪節號不動", () => {
  for (const t of ["版本 3.5 已發布", "Hello, world. OK?", "請看 example.com", "比例是 1:2", "然後...", "Version 2.0"]) {
    assert.equal(fix(t), t, t);
  }
});

test("括號裡是中文才換成全形括號", () => {
  assert.equal(fix("台北(信義區)的辦公室"), "台北（信義區）的辦公室");
  assert.equal(fix("用 Excel(試算表)"), "用 Excel(試算表)", "前面不是中文");
  assert.equal(fix("單位(kg)"), "單位(kg)", "括號裡沒有中文");
  assert.equal(fix("[說明](文件/說明.md)"), "[說明](文件/說明.md)", "連結位址");
});

test("略過的範圍與不再提示", () => {
  const text = "程式`中文,不改`之後, 要改";
  assert.equal(fix(text, [[2, 10]]), "程式`中文,不改`之後，要改");
  assert.equal(findPunctuation("中文,中文", [], new Set([punctKey(",")])).length, 0);
});

test("行尾的空白保留（Markdown 換行）", () => {
  assert.equal(fix("第一行.  \n第二行"), "第一行。  \n第二行");
});
