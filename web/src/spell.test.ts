import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { englishWords, worthChecking } from "./spell.ts";
import { Speller } from "./test-wasm.ts";

const words = (text: string, skip: [number, number][] = []) => englishWords(text, skip).map((w) => w.word);

test("找出英文字：中文裡的英文、撇號、連字號", () => {
  assert.deepEqual(words("請確認 recieve 的流程，don't forget the e-mail."), ["recieve", "don't", "forget", "the", "mail"]);
  // 位置以字串為準（中文、彎撇號）。
  const hits = englishWords("中文 Taiwan’s");
  assert.deepEqual(hits, [{ from: 3, to: 11, word: "Taiwan's" }]);
});

test("不檢查：縮寫、程式名稱、路徑、網址、檔名、標籤、版本號", () => {
  assert.deepEqual(
    words("UAT API TypeScript iPhone src/main.ts a@b.com #tag v1.2.3 user_name README.md foo.bar www.example.com done."),
    ["done"],
  );
  assert.equal(worthChecking("ok"), false);
  assert.equal(worthChecking("frontend"), false);
  assert.equal(worthChecking("Teh"), true);
});

test("跨到不檢查的範圍（程式碼、網址）的字略過", () => {
  const text = "use `recieve` here";
  assert.deepEqual(words(text, [[4, 13]]), ["use", "here"]);
});

test("拼字引擎：找出拼錯的字、給建議", () => {
  const dir = new URL("../public/dict/", import.meta.url);
  const speller = new Speller(readFileSync(new URL("en-US.aff", dir), "utf8"), readFileSync(new URL("en-US.dic", dir), "utf8"));
  assert.deepEqual([...speller.misspelled(["hello", "recieve", "Taiwan's", "teh", "running"])], [1, 3]);
  assert.equal(speller.suggest("recieve")[0], "receive");
  speller.free();
});
