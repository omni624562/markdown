/**
 * 滑鼠位置對應到文件的哪個位置（`EditorView.posAtCoords`），出錯時當作「這裡沒有位置」。
 *
 * CodeMirror（@codemirror/view 6.43、6.44）的 posAtCoords 在滑鼠下面那一行還沒畫出來時
 * （`docView.lineAt` 找不到那一行，例如即時預覽把幾行換成表格、圖片之類的元件，或剛捲動、剛改完內容），
 * 會丟出「Cannot read properties of null (reading 'length')」。滑鼠移動時每次都呼叫的話，
 * 會一直跳「發生錯誤」。呼叫端本來就要處理找不到位置（null）的情況，這裡把例外也當成 null。
 */
export interface CoordsView {
  posAtCoords(coords: { x: number; y: number }): number | null;
}

export function posAt(view: CoordsView, x: number, y: number): number | null {
  try {
    return view.posAtCoords({ x, y });
  } catch {
    return null;
  }
}
