/** AI 協作的文字處理（不依賴 DOM，方便測試）。 */

/** 依原文逐一取代。原文找不到或不只出現一次時丟出錯誤。 */
export function applyEdits(text: string, edits: { old_text: string; new_text: string }[]): string {
  let out = text;
  for (const edit of edits) {
    const oldText = edit.old_text.replace(/\r\n/g, "\n");
    const newText = edit.new_text.replace(/\r\n/g, "\n");
    if (!oldText) throw new Error("old_text 不能是空的");
    const first = out.indexOf(oldText);
    if (first < 0) throw new Error(`文件中找不到要取代的原文：「${oldText.slice(0, 80)}」。請先用 get_active_document 取得最新內容。`);
    if (out.indexOf(oldText, first + 1) >= 0) {
      throw new Error(`原文「${oldText.slice(0, 80)}」在文件中出現不只一次，請提供更長、能唯一辨識位置的原文。`);
    }
    out = out.slice(0, first) + newText + out.slice(first + oldText.length);
  }
  return out;
}

/** 整理 AI 的回覆：去掉多包的程式碼區塊標記，並保留原文結尾的換行。 */
export function cleanResult(result: string, original: string): string {
  let text = result.replace(/\r\n/g, "\n").trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced && !/^```/.test(original.trim())) text = fenced[1];
  const trailing = /\n*$/.exec(original)![0];
  return text + trailing;
}

export function buildPrompt(instruction: string, selection: string): string {
  return [
    "你是寫作助理。請依照下面的指示處理「原文」，只輸出處理後的文字本身：",
    "不要加任何開場白、說明、引號或程式碼區塊標記，並保留原本的 Markdown 格式（標題、清單、連結、粗體等）。",
    "",
    `指示：${instruction}`,
    "",
    "原文：",
    selection,
  ].join("\n");
}
