/**
 * 給 @kenjiuno/msgreader 用的 iconv-lite 替代品（vite.config.ts 的 alias）：只需要把舊編碼（Big5、Windows-1252…）
 * 的位元組轉成文字，瀏覽器內建的 TextDecoder 就做得到；原本的 iconv-lite 要用 Node 的 Buffer，網頁裡沒有。
 * 讀郵件用不到寫入，`encode` 只照 UTF-8 處理。
 */
export function decode(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding.toLowerCase().replace(/^cp/, "windows-")).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export default { decode, encode };
