/**
 * 估計 PDF 的頁數（估費用用，不必精確）：數檔案裡的頁面物件（`/Type /Page`）。新版的 PDF 常把物件壓縮起來、
 * 數不到，這時用檔案大小估（每頁大約 100 KB）。至少算 1 頁。不碰 DOM，可以直接測試。
 */
export function pdfPages(bytes: Uint8Array): number {
  // 只看 ASCII：`/Type /Page`（後面不是 s，`/Pages` 是頁面樹不是頁面），中間的空白可有可無。
  const text = new TextDecoder("latin1").decode(bytes);
  const found = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  if (found > 0) return found;
  return Math.max(1, Math.round(bytes.length / 100_000));
}
