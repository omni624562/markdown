/** AI 協作的文字處理（不依賴 DOM，方便測試）。 */

/** 依原文逐一取代。原文找不到或不只出現一次時丟出錯誤（錯誤訊息只回覆給 AI，不顯示在介面上，所以維持中文）。 */
export function applyEdits(text: string, edits: { old_text: string; new_text: string }[]): string {
  let out = text;
  for (const edit of edits) {
    const oldText = edit.old_text.replace(/\r\n/g, "\n");
    const newText = edit.new_text.replace(/\r\n/g, "\n");
    if (!oldText) throw new Error("old_text 不能是空的"); // i18n-ignore（回覆給 AI）
    const first = out.indexOf(oldText);
    // i18n-ignore（回覆給 AI）
    if (first < 0) throw new Error(`文件中找不到要取代的原文：「${oldText.slice(0, 80)}」。請先用 get_active_document 取得最新內容。`);
    if (out.indexOf(oldText, first + 1) >= 0) {
      // i18n-ignore（回覆給 AI）
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

/** 送給 `claude -p`／`codex exec` 的提示（不是介面，維持中文）。 */
export function buildPrompt(instruction: string, selection: string): string {
  return [
    "你是寫作助理。請依照下面的指示處理「原文」，只輸出處理後的文字本身：", // i18n-ignore
    "不要加任何開場白、說明、引號或程式碼區塊標記，並保留原本的 Markdown 格式（標題、清單、連結、粗體等）。", // i18n-ignore
    "",
    `指示：${instruction}`, // i18n-ignore
    "",
    "原文：", // i18n-ignore
    selection,
  ].join("\n");
}

/**
 * 給終端機中 Claude Code／Codex 的檔案參照：`@相對路徑#L10-20`。
 * 檔案在工作區內時用相對於工作區（終端機的工作目錄）的路徑，否則用完整路徑；有空白時加引號。
 */
export function fileReference(path: string, root: string | null, lines: [number, number] | null): string {
  const inside = root ? relativeInside(root, path) : null;
  const p = inside ?? path;
  let ref = `@${/\s/.test(p) ? `"${p}"` : p}`;
  if (lines) ref += lines[0] === lines[1] ? `#L${lines[0]}` : `#L${lines[0]}-${lines[1]}`;
  return ref;
}

/** `path` 在 `root` 底下時回傳相對路徑（用 /），否則 null。 */
function relativeInside(root: string, path: string): string | null {
  const windows = /^[a-zA-Z]:|^\\\\/.test(root) || root.includes("\\");
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const p = norm(path);
  const same = windows ? p.toLowerCase().startsWith(`${r.toLowerCase()}/`) : p.startsWith(`${r}/`);
  return same ? p.slice(r.length + 1) : null;
}

/**
 * 要貼到終端機的文字：拿掉控制字元（保留 Tab 與換行）。文件裡可能藏著看不見的跳脫字元，
 * 例如 `ESC[201~` 會提早結束括號貼上模式，之後的文字（含 Enter）就變成在終端機裡打字、執行指令。
 */
export function sanitizeForTerminal(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
