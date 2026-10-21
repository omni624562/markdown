/**
 * 下拉選單的位置：一律留在視窗內。下方放得下就往下開，否則往上開；
 * 兩邊都放不下時開在空間較大的一邊，並限制高度讓選單可以捲動。
 * 子選單開在上一層選單的右邊，右邊放不下時改開在左邊。
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placement {
  left: number;
  top: number;
  /** 選單最多可以多高（超過就捲動）。 */
  maxHeight: number;
}

const MARGIN = 8;
const GAP = 4;

export function placeMenu(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  side: "below" | "right" = "below",
): Placement {
  const maxLeft = Math.max(MARGIN, viewport.width - MARGIN - size.width);
  const clampLeft = (x: number) => Math.min(Math.max(MARGIN, x), maxLeft);

  if (side === "right") {
    let left = anchor.right + GAP;
    if (left + size.width > viewport.width - MARGIN) left = anchor.left - GAP - size.width;
    const maxHeight = viewport.height - 2 * MARGIN;
    const height = Math.min(size.height, maxHeight);
    // 和觸發的項目對齊（扣掉選單的內距），超出下緣就往上移。
    const top = Math.min(Math.max(MARGIN, anchor.top - GAP), viewport.height - MARGIN - height);
    return { left: clampLeft(left), top, maxHeight };
  }

  // 靠左對齊按鈕；超出右邊界時改成靠右對齊。
  const left = anchor.left + size.width > viewport.width - MARGIN ? anchor.right - size.width : anchor.left;
  const below = viewport.height - MARGIN - (anchor.bottom + GAP);
  const above = anchor.top - GAP - MARGIN;
  if (size.height <= below || below >= above) {
    return { left: clampLeft(left), top: anchor.bottom + GAP, maxHeight: Math.max(below, 80) };
  }
  const height = Math.min(size.height, above);
  return { left: clampLeft(left), top: anchor.top - GAP - height, maxHeight: above };
}
