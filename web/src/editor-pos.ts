/**
 * 滑鼠位置對應到文件的哪個位置（`EditorView.posAtCoords`），元件出錯時改用「滑鼠所在那一行的開頭」。
 *
 * CodeMirror（@codemirror/view 6.43、6.44）的 posAtCoords 在滑鼠下面那一行還沒畫出來時
 * （高度表說那裡是一行文字，但畫面上找不到那一行），會丟出「Cannot read properties of null (reading 'length')」。
 * 即時預覽的拖曳把手在滑鼠移動時每次都呼叫，所以會一直跳「發生錯誤」。
 *
 * 出錯時不往外丟，改用高度表找出滑鼠所在的那一行，回傳那一行的開頭：
 * 右鍵、拖放圖片時游標還是會移到滑鼠指的那一行（只是不一定在那個字上）。
 * 第一次出錯時把細節記進錯誤紀錄（不跳通知），之後回報時看得到發生過。
 */
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
      logError("posAtCoords", e);
    }
    try {
      return view.lineBlockAtHeight(y - view.documentTop).from;
    } catch {
      return null;
    }
  }
}
