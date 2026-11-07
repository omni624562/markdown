/**
 * 按一下打開、再按一下關上的浮動視窗（`popover="auto"`，例如篩選的下拉選單）。
 *
 * 浮動視窗開著時在按鈕上按下滑鼠，瀏覽器會先當成「點到外面」把它關掉，放開時的 click 看到的已經是關著的，
 * 結果又打開了：看起來就是「再按一次關不掉，要點別的地方才關」。所以在按下時記住當時開著沒有，
 * click 時照那個狀態決定關或開。用鍵盤（Enter、空白鍵）按時沒有按下滑鼠，照現在的狀態。
 */
export function wasOpenOnPress(trigger: HTMLElement, pop: () => HTMLElement | null): () => boolean {
  let pressedOpen: boolean | null = null;
  trigger.addEventListener("pointerdown", () => {
    pressedOpen = !!pop()?.matches(":popover-open");
  });
  return () => {
    const open = pressedOpen ?? !!pop()?.matches(":popover-open");
    pressedOpen = null;
    return open;
  };
}
