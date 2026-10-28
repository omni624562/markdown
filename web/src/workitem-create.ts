/** 用文件裡選取的文字建立工作項目：第一行（拿掉清單、待辦、標題符號）當標題，其餘當內容。 */
export function draftFromSelection(text: string): { title: string; description: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return { title: "", description: "" };
  const title = lines[first]
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .trim()
    .slice(0, 255);
  const description = lines
    .slice(first + 1)
    .join("\n")
    .replace(/^\s*\n/, "")
    .trimEnd();
  return { title, description };
}
