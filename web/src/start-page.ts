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
