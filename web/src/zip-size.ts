/**
 * .docx 是 zip 壓縮檔。惡意的檔案可以只有幾 MB、解壓縮後卻有好幾 GB（zip 炸彈），
 * 匯入時把記憶體用光讓程式當掉。解壓縮之前先讀 zip 的目錄，加總每個檔案解壓縮後的大小。
 */

/** zip 目錄中所有檔案解壓縮後的總大小；不是有效的 zip 時回傳 null。 */
export function zipUncompressedSize(data: ArrayBuffer): number | null {
  const view = new DataView(data);
  // 檔尾的「中央目錄結尾」記錄（End of Central Directory），後面最多接 65535 位元組的註解。
  const min = Math.max(0, data.byteLength - 22 - 0xffff);
  let eocd = -1;
  for (let i = data.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > data.byteLength || view.getUint32(p, true) !== 0x02014b50) return null;
    let size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    // ZIP64：真正的大小在額外欄位裡；保守起見當成超過上限。
    if (size === 0xffffffff) size = Number.MAX_SAFE_INTEGER;
    total += size;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return total;
}
