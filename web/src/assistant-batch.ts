/**
 * 助理的批次處理（純函式）：哪些動作可以整個資料夾一起做、資料夾裡要處理哪些文件、結果的檔名、估計的費用。
 * 畫面在 app/assistant-batch.ts，送出與領結果在原生端（desktop/src/assistant_batch.rs）。
 */
import { type AssistantAction, estimateUsd } from "./assistant-text.ts";
import type { ClaudeModel } from "./settings.ts";

/** 一次最多幾份文件（和原生端一樣）。 */
export const BATCH_MAX_FILES = 100;

/**
 * 可以整批做的動作：結果是一份獨立的內容（摘要、審稿…），不需要先選取文字，也不需要專案的其他資料。
 * 改寫、翻譯這類「取代選取文字」的動作不行（沒有選取，也不該整批改原檔）。
 */
export function batchActions(actions: readonly AssistantAction[]): AssistantAction[] {
  return actions.filter((a) => a.mode === "answer" && !a.needsSelection && !a.needsIndex && !a.needsTasks && !a.mermaid);
}

/** 結果檔名裡的那一段（`行程.<這一段>.md`）：動作的名稱拿掉檔名不能用的字元與句點。 */
export function batchSuffix(label: string, fallback: string): string {
  const s = label
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*.\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
  return s || fallback;
}

const lower = (s: string) => s.replace(/\\/g, "/").toLowerCase();

/** `path` 在 `folder` 裡面嗎？（含子資料夾；分隔線與大小寫不分） */
export function inFolder(path: string, folder: string): boolean {
  const dir = lower(folder).replace(/\/+$/, "");
  return lower(path).startsWith(dir + "/");
}

/** 檔名是不是之前批次的結果（`行程.摘要.md`、`行程.摘要 2.md`）：再做一次同一個動作時不要連結果也拿去做。 */
export function isBatchResult(name: string, suffix: string): boolean {
  const stem = name.replace(/\.(md|markdown)$/i, "");
  const tail = stem.slice(stem.lastIndexOf(".") + 1);
  return stem.includes(".") && tail.replace(/ \d+$/, "") === suffix;
}

/** 資料夾（含子資料夾）裡要處理的 Markdown 文件，照路徑排序；之前同一個動作的結果不算。 */
export function batchFiles<T extends { path: string | null }>(docs: readonly T[], folder: string, suffix: string): (T & { path: string })[] {
  return docs
    .filter((d): d is T & { path: string } => !!d.path && inFolder(d.path, folder) && /\.(md|markdown)$/i.test(d.path))
    .filter((d) => !isBatchResult(d.path.replace(/^.*[\\/]/, ""), suffix))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** 整批估計的費用：每一份照平常的算法估，批次是一半。 */
export function batchEstimateUsd(chars: readonly number[], model: ClaudeModel): number {
  return chars.reduce((sum, n) => sum + estimateUsd(n, model), 0) / 2;
}
