import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { CHAT_LIMITS, loadChat, saveChat } from "./assistant-chat-store.ts";

const data = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => void data.delete(k),
  key: (i: number) => [...data.keys()][i] ?? null,
  get length() {
    return data.size;
  },
};
beforeEach(() => data.clear());

const ROOT = "C:\\Users\\me\\Documents\\旅遊";
const chat = (q: string, a: string) => ({
  history: [
    { role: "user" as const, content: q },
    { role: "assistant" as const, content: a },
  ],
  transcript: [{ question: q, answer: a }],
});

test("每個專案各記一份；路徑的大小寫、分隔線、結尾的斜線不影響", () => {
  saveChat(ROOT, chat("第一天怎麼去？", "搭地鐵。"));
  saveChat("C:\\Users\\me\\Documents\\工作", chat("週報呢？", "還沒寫。"));
  assert.deepEqual(loadChat("c:/users/me/documents/旅遊/"), chat("第一天怎麼去？", "搭地鐵。"));
  assert.equal(loadChat("C:\\Users\\me\\Documents\\工作")?.transcript[0].question, "週報呢？");
  assert.equal(loadChat("C:\\Users\\me\\Documents\\別的"), null);
});

test("空的對話等於清掉（新對話）", () => {
  saveChat(ROOT, chat("問題", "回答"));
  saveChat(ROOT, { history: [], transcript: [] });
  assert.equal(loadChat(ROOT), null);
});

test("壞掉的資料不會讓程式出錯；對話對不上一問一答時只顯示、不接著問", () => {
  data.set("md-editor:assistant-chats", "不是 JSON");
  assert.equal(loadChat(ROOT), null);
  data.set("md-editor:assistant-chats", JSON.stringify({ "c:/users/me/documents/旅遊": { history: [{ role: "assistant", content: "只有回答" }], transcript: [{ question: "問題", answer: "回答" }, { question: 3 }] } }));
  assert.deepEqual(loadChat(ROOT), { history: [], transcript: [{ question: "問題", answer: "回答" }] });
});

test("太多、太大時丟掉最久沒用的專案，目前這個一定留著；每個專案只留最近幾組", () => {
  for (let i = 0; i < CHAT_LIMITS.projects + 3; i++) saveChat(`C:\\p\\${i}`, chat(`問題 ${i}`, "回答"), 1000 + i);
  assert.equal(loadChat("C:\\p\\0"), null);
  assert.equal(loadChat("C:\\p\\2"), null);
  assert.ok(loadChat("C:\\p\\3"));
  // 一份很大的對話：把舊的擠掉，自己留著。
  saveChat("C:\\p\\big", chat("大", "字".repeat(CHAT_LIMITS.chars)), 5000);
  assert.ok(loadChat("C:\\p\\big"));
  assert.equal(loadChat(`C:\\p\\${CHAT_LIMITS.projects + 2}`), null);
  const many = { history: [], transcript: Array.from({ length: CHAT_LIMITS.items + 5 }, (_, i) => ({ question: `q${i}`, answer: "a" })) };
  saveChat(ROOT, many, 6000);
  assert.equal(loadChat(ROOT)?.transcript.length, CHAT_LIMITS.items);
  assert.equal(loadChat(ROOT)?.transcript[0].question, "q5");
});
