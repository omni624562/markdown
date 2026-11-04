/**
 * 工作項目、Wiki 內容裡寫成「#編號」的文字（例如「Story #1895964 / Task #1895969」）：找出位置，之後換成工作項目連結。
 * 只認三位數以上：「#1」「#2」常是條列的編號，不是工作項目。前面接著字母、數字、`&`（HTML 字元參照）、`#`、`/`、`\`
 * （網址、路徑）的不算；後面接著字母、數字的也不算（例如 `#123abc`）。
 */

export interface WorkItemRef {
  /** 「#」在文字裡的位置。 */
  index: number;
  /** 「#」加上編號的長度。 */
  length: number;
  id: number;
}

const REF = /(?<![\p{L}\p{N}_&#/\\])#(\d{3,9})(?![\p{L}\p{N}_])/gu;

export function findWorkItemRefs(text: string): WorkItemRef[] {
  return [...text.matchAll(REF)].map((m) => ({ index: m.index, length: m[0].length, id: Number(m[1]) }));
}
