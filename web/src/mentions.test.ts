import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMentions, insertMention, mentionHtml, mentionQuery, mentionsIn } from "./mentions.ts";

const MING = { name: "王小明", id: "1a2b3c4d-0000-0000-0000-000000000001" };
const MING2 = { name: "王小", id: "1a2b3c4d-0000-0000-0000-000000000002" };
const WANG = { name: "Wang Da", id: "1a2b3c4d-0000-0000-0000-000000000003" };

test("找出游標前面正在打的 @", () => {
  assert.deepEqual(mentionQuery("請 @王", 4), { start: 2, query: "王" });
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionQuery("（@wa", 4), { start: 1, query: "wa" });
  // 中文緊接著 @ 也算（中文不用空白隔開）。
  assert.deepEqual(mentionQuery("麻煩@王", 4), { start: 2, query: "王" });
  // 信箱、打完空白之後不算。
  assert.equal(mentionQuery("ming@corp", 9), null);
  assert.equal(mentionQuery("@王 ", 3), null);
  assert.equal(mentionQuery("沒有", 2), null);
});

test("選了人：@… 換成 @名字，後面補一個空白", () => {
  assert.deepEqual(insertMention("請 @王 看一下", 2, 4, "王小明"), { text: "請 @王小明 看一下", caret: 7 });
  assert.deepEqual(insertMention("@w", 0, 2, "Wang Da"), { text: "@Wang Da ", caret: 9 });
});

test("送出時把選過的人換成 @ 的連結", () => {
  assert.equal(applyMentions("<p>@王小明 請看</p>", [MING]), `<p>${mentionHtml(MING)} 請看</p>`);
  // 名字長的先比對；名字裡有空白也可以。
  assert.equal(applyMentions("<p>@王小明、@王小</p>", [MING2, MING]), `<p>${mentionHtml(MING)}、${mentionHtml(MING2)}</p>`);
  assert.equal(applyMentions("<p>cc @Wang Da</p>", [WANG]), `<p>cc ${mentionHtml(WANG)}</p>`);
  // 程式碼、連結裡的不換；信箱不換；沒選過的名字不換。
  assert.equal(applyMentions("<p><code>@王小明</code></p>", [MING]), "<p><code>@王小明</code></p>");
  assert.equal(applyMentions('<p><a href="https://x">@王小明</a></p>', [MING]), '<p><a href="https://x">@王小明</a></p>');
  assert.equal(applyMentions("<p>a@王小明</p>", [MING]), "<p>a@王小明</p>");
  assert.equal(applyMentions("<p>@李大同</p>", [MING]), "<p>@李大同</p>");
  // HTML 的特殊字元。
  const amp = { name: "R&D 小組", id: "abc" };
  assert.equal(applyMentions("<p>@R&amp;D 小組</p>", [amp]), `<p><a href="#" data-vss-mention="version:2.0,abc">@R&amp;D 小組</a></p>`);
  // 編號不像 GUID（可能塞了引號）時不換。
  assert.equal(applyMentions("<p>@王小明</p>", [{ name: "王小明", id: 'x" onclick="y' }]), "<p>@王小明</p>");
});

test("讀出 HTML 裡已經有的 @", () => {
  const html = `<div>${mentionHtml(MING)} 和 <a href="#" data-vss-mention="version:2.0,${WANG.id}">@Wang Da</a>、${mentionHtml(MING)}，<a href="https://x">連結</a></div>`;
  assert.deepEqual(mentionsIn(html), [MING, WANG]);
  // 改完存回去還是 @。
  assert.equal(applyMentions("<p>@王小明 好</p>", mentionsIn(html)), `<p>${mentionHtml(MING)} 好</p>`);
  assert.deepEqual(mentionsIn('<a href="#" data-vss-mention="version:2.0,abc">@R&amp;D</a>'), [{ name: "R&D", id: "abc" }]);
});
