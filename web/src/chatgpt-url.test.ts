import assert from "node:assert/strict";
import { test } from "node:test";
import { chatgptUrl, encodePrompt, MAX_URL_LENGTH } from "./chatgpt-url.ts";

// 和原生端（desktop/src/chatgpt.rs）的測試用同樣的例子：兩邊的編碼要一樣。
test("文字編碼進網址（和原生端一樣）", () => {
  assert.equal(chatgptUrl("desktop", "你好"), "codex://new?prompt=%E4%BD%A0%E5%A5%BD");
  assert.equal(chatgptUrl("web", "a b&c=d?#/"), "https://chatgpt.com/?q=a%20b%26c%3Dd%3F%23%2F");
  assert.equal(chatgptUrl("web", "1\n'x'"), "https://chatgpt.com/?q=1%0A%27x%27");
  assert.equal(encodePrompt("!*()-_.~"), "%21%2A%28%29-_.~");
});

test("沒有文字：網頁版開首頁，桌面版不開", () => {
  assert.equal(chatgptUrl("web", " "), "https://chatgpt.com/");
  assert.equal(chatgptUrl("desktop", ""), null);
});

test("太長放不下時回傳 null", () => {
  const fits = "a".repeat(MAX_URL_LENGTH - "https://chatgpt.com/?q=".length);
  assert.equal(chatgptUrl("web", fits)?.length, MAX_URL_LENGTH);
  assert.equal(chatgptUrl("web", `${fits}a`), null);
  assert.equal(chatgptUrl("desktop", "字".repeat(Math.floor(MAX_URL_LENGTH / 9))), null);
});
