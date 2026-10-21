import assert from "node:assert/strict";
import { test } from "node:test";
import { TERMS, findTerms, sureFixes, termMessage } from "./terms.ts";

const words = (text: string, skip?: [number, number][]) => findTerms(text, skip).map((m) => m.term.word);

test("找出中國用語與錯字，長的詞優先", () => {
  assert.deepEqual(words("把源代碼的字符串存進數據庫，再看視頻"), ["源代碼", "字符串", "數據庫", "視頻"]);
  assert.deepEqual(words("即然如此，就再接再勵"), ["即然", "再接再勵"]);
  assert.deepEqual(words("人工智能與智能手機"), ["人工智能", "智能"]);
});

test("台灣也在用的說法不算", () => {
  assert.deepEqual(words("在線上開會，數據機壞了，質量守恆定律，智能障礙，點擊率"), []);
  assert.deepEqual(words("以經濟成長為目標，因該公司要求"), []);
  assert.deepEqual(words("程序正義與法律程序"), []);
});

test("略過指定範圍與不再提示的詞", () => {
  const text = "`視頻` 和 視頻";
  assert.deepEqual(words(text, [[0, 4]]), ["視頻"]);
  assert.deepEqual(findTerms(text, [], new Set(["視頻"])), []);
});

test("整份修正只換不需要判斷的詞", () => {
  const m = findTerms("默認的質量很好");
  assert.deepEqual(
    m.map((x) => [x.term.word, x.term.context]),
    [
      ["默認", false],
      ["質量", true],
    ],
  );
  assert.deepEqual(sureFixes(m), [{ from: 0, to: 2, insert: "預設" }]);
});

test("提示文字", () => {
  const get = (w: string) => TERMS.find((t) => t.word === w)!;
  assert.equal(termMessage(get("視頻")), "「視頻」是中國用語，台灣說「影片」");
  assert.equal(termMessage(get("截屏")), "「截屏」是中國用語，台灣說「截圖」或「螢幕截圖」");
  assert.equal(termMessage(get("即然")), "「即然」可能是錯字，應該是「既然」");
  assert.match(termMessage(get("質量")), /^「質量」指好壞時（物理的質量不用改），台灣說「品質」$/);
});

test("詞表沒有重複，也沒有建議成自己", () => {
  const seen = new Set<string>();
  for (const t of TERMS) {
    assert.ok(!seen.has(t.word), `重複：${t.word}`);
    seen.add(t.word);
    assert.ok(t.to.length > 0 && !t.to.includes(t.word) || t.context, `建議：${t.word}`);
  }
});
