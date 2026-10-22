/**
 * 合併重疊的範圍並排序，之後用二分搜尋判斷某段文字有沒有落在其中
 * （原本每個 `[[ ]]`、#標籤都要比對全部範圍，大文件會變成平方成長）。
 */
export function rangeChecker(ranges: [number, number][]): (from: number, to: number) => boolean {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return (from, to) => {
    // 起點小於 to 的最後一個範圍：只有它可能和 [from, to) 重疊。
    let lo = 0;
    let hi = merged.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (merged[mid][0] < to) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && merged[lo - 1][1] > from;
  };
}
