/**
 * 滑鼠位置對應到文件的哪個位置（`EditorView.posAtCoords`），元件出錯時改用「滑鼠所在那一行的開頭」。
 *
 * CodeMirror（@codemirror/view 6.43、6.44）的 posAtCoords 在滑鼠下面那一行還沒畫出來時
 * （高度表說那裡是一行文字，但畫面上找不到那一行），會丟出「Cannot read properties of null (reading 'length')」。
 * 即時預覽的拖曳把手在滑鼠移動時每次都呼叫，所以會一直跳「發生錯誤」。
 *
 * 出錯時不往外丟，改用高度表找出滑鼠所在的那一行，回傳那一行的開頭：
 * 右鍵、拖放圖片時游標還是會移到滑鼠指的那一行（只是不一定在那個字上）。
 * 第一次出錯時把細節記進錯誤紀錄（不跳通知），之後回報時看得到發生過；同時記下出錯那一行的「結構」
 * （行號、長度、語法節點的名稱、畫面上的元素類別、可見範圍），不含任何文字內容，方便找出根本原因。
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { logError } from "./error-log.ts";

export interface CoordsView {
  posAtCoords(coords: { x: number; y: number }): number | null;
  lineBlockAtHeight(height: number): { from: number };
  readonly documentTop: number;
}

let logged = false;

export function posAt(view: CoordsView, x: number, y: number): number | null {
  try {
    return view.posAtCoords({ x, y });
  } catch (e) {
    if (!logged) {
      logged = true;
      logError("posAtCoords", e, Date.now(), describe(view, x, y));
    }
    try {
      return view.lineBlockAtHeight(y - view.documentTop).from;
    } catch {
      return null;
    }
  }
}

/** 出錯位置的結構（不含文字內容）；拿不到就回傳空的。 */
export function describe(view: CoordsView, x: number, y: number): string {
  try {
    const v = view as Partial<EditorView> & CoordsView;
    if (!v.state || !v.viewport) return "";
    const block = view.lineBlockAtHeight(y - view.documentTop) as { from: number; to?: number; height?: number; type?: unknown };
    const line = v.state.doc.lineAt(block.from);
    const nodes: string[] = [];
    syntaxTree(v.state).iterate({
      from: line.from,
      to: line.to,
      enter: (n) => {
        if (nodes.length < 40) nodes.push(n.name);
      },
    });
    const at = typeof document === "undefined" ? null : document.elementFromPoint(x, y);
    const classes: string[] = [];
    for (let el = at; el && classes.length < 6; el = el.parentElement) classes.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : ""}`);
    const drawn = v.contentDOM ? v.contentDOM.querySelectorAll(".cm-line").length : -1;
    return [
      `line ${line.number}/${v.state.doc.lines} length ${line.length} block ${block.from}-${block.to ?? "?"} height ${Math.round(block.height ?? 0)} type ${String(block.type)}`,
      `viewport ${v.viewport.from}-${v.viewport.to} visibleRanges ${v.visibleRanges?.length ?? "?"} drawnLines ${drawn} docLength ${v.state.doc.length}`,
      `nodes ${nodes.join(" > ")}`,
      `element ${classes.join(" < ")}`,
    ].join("\n");
  } catch {
    return "";
  }
}
