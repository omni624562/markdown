import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASSISTANT_ACTIONS,
  conversation,
  customActions,
  noteName,
  transcriptMarkdown,
  estimateUsd,
  formatUsd,
  insertPadding,
  listed,
  mermaidBlock,
  replacementText,
  systemPrompt,
  toggled,
  userContent,
} from "./assistant-text.ts";

test("使用者的資料放在標籤裡，問題放最後", () => {
  const text = userContent("  摘要  ", { doc: { name: "NAS 備份規劃.md", text: "# 規劃" }, selection: "現況" });
  assert.equal(text, '<document name="NAS 備份規劃.md">\n# 規劃\n</document>\n\n<selection>\n現況\n</selection>\n\n摘要');
  // 拿掉文件、沒有選取時只有問題。
  assert.equal(userContent("你好", { doc: null, selection: "  " }), "你好");
  // 檔名裡的引號不會弄壞標籤。
  assert.match(userContent("問", { doc: { name: 'a"b.md', text: "" }, selection: "" }), /name="a'b\.md"/);
});

test("對話紀錄接上這一輪", () => {
  const history = [
    { role: "user", content: "第一題" },
    { role: "assistant", content: "回答" },
  ] as const;
  assert.deepEqual(conversation([...history], "第二題").at(-1), { role: "user", content: "第二題" });
});

test("取代選取文字時只要新的內容", () => {
  assert.match(systemPrompt("replace"), /只輸出取代選取文字/);
  assert.doesNotMatch(systemPrompt("answer"), /只輸出取代選取文字/);
  assert.match(systemPrompt("insert"), /只輸出要插入文件的新內容/);
  assert.match(systemPrompt("answer"), /台灣用語/);
  assert.equal(replacementText("```markdown\n新的段落\n```"), "新的段落");
  assert.equal(replacementText("  新的段落\n"), "新的段落");
});

test("取代選取文字的動作都要先選取；插入、回答的不用", () => {
  const need = ASSISTANT_ACTIONS.filter((a) => a.needsSelection).map((a) => a.id);
  assert.deepEqual(need, ["rewrite", "translate", "table", "formal", "casual", "concise"]);
  assert.ok(ASSISTANT_ACTIONS.every((a) => (a.mode === "replace") === a.needsSelection));
  assert.deepEqual(ASSISTANT_ACTIONS.filter((a) => a.mode === "insert").map((a) => a.id), ["diagram", "todos", "continue"]);
  // 下方按鈕只放原本五個，其他放在「寫作」選單。
  assert.deepEqual(ASSISTANT_ACTIONS.filter((a) => a.group === "main").map((a) => a.id), ["summary", "rewrite", "translate", "review"]);
});

test("流程圖一定包成 mermaid 區塊", () => {
  assert.equal(mermaidBlock("```mermaid\nflowchart TD\n  A --> B\n```"), "```mermaid\nflowchart TD\n  A --> B\n```");
  assert.equal(mermaidBlock("說明\n```\nflowchart TD\n  A --> B\n```\n補充"), "```mermaid\nflowchart TD\n  A --> B\n```");
  assert.equal(mermaidBlock("flowchart TD\n  A --> B"), "```mermaid\nflowchart TD\n  A --> B\n```");
});

test("插入時自成段落：前後空一行", () => {
  // 接在一行文字後面：前面空一行；後面還有文字：後面也空一行。
  assert.deepEqual(insertPadding("。", "下"), { prefix: "\n\n", suffix: "\n\n" });
  // 在行首（前一個字是換行）：前面補一個換行就好；在文件結尾：後面不用補。
  assert.deepEqual(insertPadding("\n", ""), { prefix: "\n", suffix: "" });
  // 空白文件。
  assert.deepEqual(insertPadding("", ""), { prefix: "", suffix: "" });
});

test("估計費用", () => {
  // Sonnet：1 萬字輸入 + 1,000 token 回答 = 0.02 + 0.01。
  assert.ok(Math.abs(estimateUsd(10_000, "claude-sonnet-5-5") - 0.03) < 1e-9);
  assert.ok(estimateUsd(10_000, "claude-haiku-5-5") < estimateUsd(10_000, "claude-opus-5-5"));
  assert.equal(formatUsd(0.031), "US$0.03");
  assert.equal(formatUsd(0.001), "< US$0.01");
  assert.equal(formatUsd(0), "US$0.00");
});

test("允許的專案清單不分大小寫與斜線", () => {
  const list = ["C:\\Users\\me\\筆記"];
  assert.ok(listed(list, "c:/users/me/筆記/"));
  assert.ok(!listed(list, "C:\\Users\\me\\產品"));
  assert.deepEqual(toggled(list, "c:/users/me/筆記", false), []);
  assert.deepEqual(toggled(list, "C:\\Users\\me\\產品", true), ["C:\\Users\\me\\筆記", "C:\\Users\\me\\產品"]);
  // 重複加入不會出現兩次。
  assert.deepEqual(toggled(list, "C:\\Users\\me\\筆記", true), ["C:\\Users\\me\\筆記"]);
});

test("自訂動作：取代選取文字的才需要先選取，代號依順序", () => {
  const list = customActions([
    { name: "會議紀錄", prompt: "整理成會議紀錄", mode: "insert" },
    { name: "改成英文", prompt: "翻成英文", mode: "replace" },
  ]);
  assert.deepEqual(
    list.map((a) => [a.id, a.label(), a.prompt(), a.mode, a.needsSelection, a.group]),
    [
      ["custom-0", "會議紀錄", "整理成會議紀錄", "insert", false, "custom"],
      ["custom-1", "改成英文", "翻成英文", "replace", true, "custom"],
    ],
  );
});

test("對話存成筆記：檔名有日期時間，問題用引言，回答照原樣", () => {
  const d = new Date(2026, 10, 8, 9, 5);
  assert.equal(noteName(d), "助理對話 2026-11-08 0905.md");
  const md = transcriptMarkdown(
    [
      { question: "這份文件在講什麼？\n請簡短", answer: "在講 **NAS 備份**。" },
      { question: "摘要", answer: "- 兩份備份\n- 每晚自動" },
    ],
    d,
    "NAS 備份規劃",
  );
  assert.equal(
    md,
    "# 助理對話\n\n2026-11-08 09:05 · NAS 備份規劃\n\n---\n\n> 這份文件在講什麼？\n> 請簡短\n\n在講 **NAS 備份**。\n\n---\n\n> 摘要\n\n- 兩份備份\n- 每晚自動\n",
  );
});
