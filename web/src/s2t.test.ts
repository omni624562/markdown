import assert from "node:assert/strict";
import { test } from "node:test";
import { conversionChanges, looksSimplified, segments } from "./s2t.ts";

const fake = (t: string) => t.replaceAll("软件", "軟體").replaceAll("这", "這");

test("程式碼、網址、連結位址不轉換", () => {
  const text = "这个软件 `软件` 看 https://example.com/软件 和 [软件](docs/软件.md)\n\n```\n软件\n```\n这";
  const kept = segments(text).filter((s) => !s.convert).map((s) => text.slice(s.from, s.to));
  assert.deepEqual(kept, ["`软件`", "https://example.com/软件", "](docs/软件.md)", "```\n软件\n```"]);
  const changes = conversionChanges(text, fake);
  let out = text;
  for (const c of [...changes].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  assert.equal(out, "這个軟體 `软件` 看 https://example.com/软件 和 [軟體](docs/软件.md)\n\n```\n软件\n```\n這");
});

test("選取範圍的位移", () => {
  assert.deepEqual(conversionChanges("软件", fake, 10), [{ from: 10, to: 12, insert: "軟體" }]);
  assert.deepEqual(conversionChanges("沒有要改的", fake), []);
});

test("判斷是不是簡體", () => {
  assert.equal(looksSimplified("这个软件的数据库设计"), true);
  assert.equal(looksSimplified("這個軟體的資料庫設計"), false);
  assert.equal(looksSimplified("皇后住在三公里外"), false, "兩邊都有的字不算");
  assert.equal(looksSimplified("这个"), false, "太少不提示");
});
