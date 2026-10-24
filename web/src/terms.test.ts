import assert from "node:assert/strict";
import { test } from "node:test";
import { termList } from "./test-wasm.ts";
import { checkText, sureFixes, termMessage } from "./terms.ts";

// 比對的規則在 Rust（crates/md-text，那裡有完整的測試）；這裡確認位置換算與前端用的格式。

test("位置是 JavaScript 字串的位置", () => {
  const text = "😀 把源代碼存進數據庫, 再看視頻";
  assert.deepEqual(
    checkText(text).map((m) => text.slice(m.from, m.to)),
    ["源代碼", "數據庫", ", ", "視頻"],
  );
  assert.deepEqual(checkText(text, [[0, 8]]).map((m) => m.term.word), ["數據庫", "半形標點 ,", "視頻"]);
  assert.deepEqual(checkText(text, [], new Set(["視頻"])).map((m) => m.term.word), ["源代碼", "數據庫", "半形標點 ,"]);
});

test("半形括號的建議是換成全形括號", () => {
  const [m] = checkText("台北(信義區)的辦公室");
  assert.deepEqual([m.from, m.to, m.term.to], [2, 7, ["（信義區）"]]);
  assert.equal(termMessage(m.term), "括號裡是中文，用全形括號：改成「（信義區）」");
});

test("整份修正只換不需要判斷的詞", () => {
  const m = checkText("默認的質量很好");
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
  const get = (w: string) => termList().find((t) => t.word === w)!;
  assert.equal(termMessage(get("視頻")), "「視頻」是中國用語，台灣說「影片」");
  assert.equal(termMessage(get("截屏")), "「截屏」是中國用語，台灣說「截圖」或「螢幕截圖」");
  assert.equal(termMessage(get("即然")), "「即然」可能是錯字，應該是「既然」");
  assert.match(termMessage(get("質量")), /^「質量」指好壞時（物理的質量不用改），台灣說「品質」$/);
  assert.equal(termMessage(get("半形標點 ,")), "中文句子裡用全形標點：改成「，」");
});
