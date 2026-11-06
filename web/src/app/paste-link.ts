/**
 * 選取文字後貼上網址：變成連結 `[選取的文字](網址)`（和 GitHub、Notion、Slack 一樣）。
 * 沒有選取、選了好幾行、選的本身就是網址、在程式碼或已經是連結的地方，照原樣貼上。
 * 「貼上純文字」（Ctrl+Shift+V）也照原樣貼上。
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

const URL = /^(https?:\/\/|mailto:)\S+$/i;
/** 程式碼與已經是連結的地方：不再包成連結。 */
const SKIP = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText", "HTMLBlock", "Link", "Image", "URL", "Autolink"]);

/** 選取的文字加上貼上的網址組成的連結；不適合變成連結時回傳 null。 */
export function linkFromPaste(selected: string, pasted: string): string | null {
  const url = pasted.trim();
  const text = selected.trim();
  if (!URL.test(url) || !text || selected.includes("\n") || URL.test(text)) return null;
  // 文字裡的中括號跳脫；網址裡有括號時用 <…> 包起來，連結才不會提早結束。
  const label = selected.replace(/[[\]]/g, (c) => `\\${c}`);
  return `[${label}](${/[()<>]/.test(url) ? `<${url}>` : url})`;
}

function insideSkipped(state: EditorState, from: number, to: number): boolean {
  for (const pos of [from, to]) {
    for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
      if (SKIP.has(n.name)) return true;
    }
  }
  return false;
}

/** 選取了文字、貼上的是網址：換成連結並回傳 true；否則回傳 false（交給一般的貼上）。 */
export function pasteLink(view: EditorView, plain: string): boolean {
  const { state } = view;
  if (state.selection.ranges.length > 1) return false;
  const { from, to } = state.selection.main;
  if (from === to || insideSkipped(state, from, to)) return false;
  const link = linkFromPaste(state.sliceDoc(from, to), plain);
  if (!link) return false;
  view.dispatch({ changes: { from, to, insert: link }, selection: { anchor: from + link.length }, scrollIntoView: true, userEvent: "input.paste" });
  return true;
}
