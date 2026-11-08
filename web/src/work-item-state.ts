/**
 * 工作項目狀態的分類（決定顏色，比照 TFS 網頁）：新增灰、進行中藍、已解決橘、完成綠、移除淡灰。
 * 文件裡的狀態標籤、工作項目的狀態點、子項目進度、工作板都用這一份，同一個狀態到處顏色一樣。
 * 只看狀態名稱（伺服器沒有回傳分類）；英文與中文的流程範本都認。
 */

export type StateTone = "new" | "active" | "resolved" | "closed" | "removed";

const TONES: [StateTone, string[]][] = [
  ["removed", ["removed", "cut", "已移除", "已刪除", "移除"]], // i18n-ignore
  ["closed", ["closed", "done", "completed", "inactive", "已關閉", "已完成", "關閉", "完成"]], // i18n-ignore
  ["resolved", ["resolved", "已解決", "解決"]], // i18n-ignore
  ["new", ["new", "to do", "proposed", "design", "新增", "新的", "待辦"]], // i18n-ignore
  ["active", ["active", "committed", "in progress", "doing", "approved", "open", "作用中", "進行中"]], // i18n-ignore
];

/** 狀態名稱對應的分類；認不得的（自訂狀態）當成進行中。 */
export function stateTone(state: string): StateTone {
  const s = state.trim().toLowerCase();
  return TONES.find(([, names]) => names.includes(s))?.[0] ?? "active";
}
