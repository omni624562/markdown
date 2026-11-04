/** 起始頁（空白文件時顯示）用到的資料處理；畫面在 ui/start-page.ts。 */

/**
 * 最近開啟的檔案或資料夾怎麼顯示：名稱，加上所在位置的最後兩層（例如 `Comet › docs`）。
 * 完整路徑太長、又被截斷，只放在滑鼠提示裡。
 */
export function recentLabel(path: string): { name: string; where: string } {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const name = parts.pop() ?? path;
  return { name, where: parts.slice(-2).join(" › ") };
}

/**
 * 專案怎麼顯示：名稱是專案的名稱（自訂的或資料夾名稱）；位置平常是資料夾所在的最後兩層，
 * 自訂了名稱時改成資料夾本身與上一層（看得出是哪個資料夾）。
 */
export function projectLabel(path: string, label: string): { name: string; where: string } {
  const { name, where } = recentLabel(path);
  if (label === name) return { name: label, where };
  return { name: label, where: [where.split(" › ").pop(), name].filter(Boolean).join(" › ") };
}
