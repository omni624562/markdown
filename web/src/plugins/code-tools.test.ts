import assert from "node:assert/strict";
import { test } from "node:test";
import { languageOf } from "./code-tools.ts";

test("程式碼區塊的語言", () => {
  assert.equal(languageOf("language-js"), "js");
  assert.equal(languageOf("language-rust hljs"), "rust");
  assert.equal(languageOf("hljs language-c++"), "c++");
  assert.equal(languageOf(""), "");
  assert.equal(languageOf("hljs"), "");
});
