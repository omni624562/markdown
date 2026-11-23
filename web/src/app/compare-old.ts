/**
 * 和舊的內容比較「改了哪些地方」：原始碼控制的變更清單（上次提交）、檔案的 Git 歷史（某次提交）、
 * 本機版本紀錄（某個存檔版本）都用這裡，看起來一樣：
 * 舊的內容當基準、目前的內容不動，綠色是之後新增或改過的，紅色是舊的樣子；每一段「保留」或「改回去」。
 * 上下對照或左右並排照設定（`gitCompareLayout`）。
 */
import { t } from "../i18n.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";

export interface CompareOld {
  /** 提示列的標題。 */
  title: string;
  /** 舊的內容是什麼時候的，接在「…的樣子」前面，例如「上次提交時」。 */
  when: string;
  /** 內容一樣時的提示。 */
  same: string;
}

export function compareWithOld(old: string, o: CompareOld): void {
  if (app.review.active) app.review.finish();
  const side = app.settings.value.gitCompareLayout === "side";
  const started = app.review.start(app.editor.view.state.doc.toString(), {
    original: old,
    layout: side ? "side" : "stacked",
    sideLabels: [o.when, t("現在")],
    title: o.title,
    hint: side
      ? t("左邊是{when}的樣子，右邊是現在；改過的地方標了顏色。哪一段不要了，按那一段的「改回去」", { when: o.when })
      : t("綠色是之後新增或改過的，紅色是{when}的樣子。哪一段不要了，按那一段的「改回去」", { when: o.when }),
    acceptLabel: t("保留"),
    rejectLabel: t("改回去"),
  });
  if (!started) toast(o.same);
}
