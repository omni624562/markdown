/**
 * 桌面版的右鍵選單：沒有自己選單的地方（搜尋框、設定欄位、預覽裡選取的文字等），
 * 用這個簡單的選單取代 WebView2 內建的選單。內建選單裡有「重新整理」「列印」，
 * 還有 Windows 的「語音輸入」，誤按會打開 Windows 的視窗，在編輯器裡也用不到。
 */
import { t } from "../i18n.ts";
import type { MenuEntry } from "./menu.ts";
import { toast } from "./toast.ts";

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** 可以打字的輸入框（數字、日期這類欄位沒有可選取的文字，不算）。 */
const TEXT_TYPES = new Set(["text", "search", "url", "email", "tel", "password", ""]);

export function textField(el: Element | null): TextField | null {
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type)) return el;
  return null;
}

function item(label: string, icon: string, run: () => void): MenuEntry {
  return { label, icon, checked: () => false, run };
}

/** 把輸入框選取的範圍換成 `text`，並通知輸入框內容改了（和打字一樣觸發 input 事件）。 */
function replaceSelection(el: TextField, text: string, start: number, end: number): void {
  el.focus();
  el.setRangeText(text, start, end, "end");
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: text ? "insertFromPaste" : "deleteByCut", data: text || null }));
}

/** 輸入框的選單：剪下、複製、貼上、全選。選取範圍在開選單時先記下來（點選單會讓輸入框失去焦點）。 */
export function fieldMenu(el: TextField): MenuEntry[] {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;
  const selected = el.value.slice(start, end);
  // 密碼欄位不能複製或剪下（和瀏覽器的做法一樣）。
  const secret = el instanceof HTMLInputElement && el.type === "password";
  const editable = !el.readOnly && !el.disabled;
  const entries: MenuEntry[] = [];
  if (selected && !secret) {
    if (editable) {
      entries.push(
        item(t("剪下"), "scissors", () => {
          void navigator.clipboard.writeText(selected);
          replaceSelection(el, "", start, end);
        }),
      );
    }
    entries.push(item(t("複製"), "copy", () => void navigator.clipboard.writeText(selected)));
  }
  if (editable) {
    entries.push(
      item(t("貼上"), "clipboard-paste", () => {
        navigator.clipboard.readText().then(
          (text) => replaceSelection(el, text, start, end),
          () => toast(t("無法從選單讀取剪貼簿，請按 {keys} 貼上。", { keys: "Ctrl+V" })),
        );
      }),
    );
  }
  if (el.value) {
    entries.push(
      item(t("全選"), "square-dashed-text", () => {
        el.focus();
        el.select();
      }),
    );
  }
  return entries;
}

/** 其他地方（預覽、比較檢視等）：選取了文字就可以複製。 */
export function selectionMenu(): MenuEntry[] {
  const text = document.getSelection()?.toString() ?? "";
  return text ? [item(t("複製"), "copy", () => void navigator.clipboard.writeText(text))] : [];
}
