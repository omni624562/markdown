/** 判斷按鍵是不是在打字（不碰 DOM，可以直接測試）。 */

/** 這個按鍵是想輸入或刪除文字（包括輸入法正在組字）。 */
export function isTypingKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing">): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.isComposing || e.key === "Process") return true;
  if (e.key === "Backspace" || e.key === "Delete") return true;
  // 一個字元的按鍵是打字；空白鍵在預覽是往下捲一頁。
  return [...e.key].length === 1 && e.key !== " ";
}
