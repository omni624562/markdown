/**
 * 中文排序（數字依大小：「第2章」排在「第10章」前面）。
 * 共用同一個 Intl.Collator：`localeCompare(…, "zh-Hant", 選項)` 每次比較都會重建排序器，幾千筆就要上百毫秒。
 */
export const collator = new Intl.Collator("zh-Hant", { numeric: true });
