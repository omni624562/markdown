/**
 * 工作項目內文裡的標籤行與檔案（判斷規則在 work-item-marks.ts）：
 * 標籤行換成一排彩色小標籤；檔案換成檔案小方塊，工作項目有同名的附件時，點一下就開那個附件。
 * 只處理整段都是純文字的段落（有連結、粗體等的段落不動）。
 */
import { baseName, fileLine, tagHue, tagLine } from "../work-item-marks.ts";
import { icon } from "./icons.ts";

export function decorateMarks(body: HTMLElement): void {
  // 內容裡（附件段落、留言）連到附件的網址：檔名 → 網址。
  const attachments = new Map<string, string>();
  for (const a of body.querySelectorAll<HTMLAnchorElement>('a[href*="/_apis/wit/attachments/"]')) {
    try {
      const name = new URL(a.href).searchParams.get("fileName");
      if (name) attachments.set(name.toLowerCase(), a.getAttribute("href")!);
    } catch {
      // 網址不完整：略過。
    }
  }
  for (const el of body.querySelectorAll<HTMLElement>("p, li")) {
    if (el.children.length || el.closest("pre, code, table, .ado-tags, .ado-file")) continue;
    const text = el.textContent ?? "";
    const tags = tagLine(text);
    if (tags) {
      const row = document.createElement("span");
      row.className = "ado-tags";
      for (const tag of tags) {
        const chip = document.createElement("span");
        chip.className = "ado-tag";
        chip.textContent = tag;
        chip.style.setProperty("--hue", String(tagHue(tag)));
        row.append(chip);
      }
      el.replaceChildren(row);
      continue;
    }
    const file = fileLine(text);
    if (!file) continue;
    const href = attachments.get(baseName(file.path).toLowerCase());
    const box = document.createElement(href ? "a" : "span");
    box.className = "ado-file";
    if (box instanceof HTMLAnchorElement && href) box.href = href;
    const name = document.createElement("span");
    name.textContent = file.path;
    box.append(icon(href ? "paperclip" : "file-text"), name);
    // 標籤（「檔案：」之類）照原文留著。
    const prefix = text.slice(0, text.lastIndexOf(file.path)).trimStart();
    el.replaceChildren(...(prefix ? [prefix] : []), box);
  }
}
