/**
 * 工作項目的進度條（見 work-item-progress.ts）：清單上 Feature、Story 那一列的細條，與工作項目分頁「子項目」上方的粗條。
 * 「依數量」分四段（完成、待驗證、進行中、還沒開始，顏色和狀態圓點一樣）；「依工時」是已完成工時占剩餘＋已完成的比例。
 */
import { t } from "../i18n.ts";
import { PROGRESS_TONES, type Progress, type ProgressTone, doneRatio, hoursRatio, hoursText } from "../work-item-progress.ts";
import * as storage from "../storage.ts";

const MODE_KEY = "workitem-progress-hours";

/** 進度依工時（否則依數量）；記住上次的選擇。 */
export function progressByHours(): boolean {
  return storage.load(MODE_KEY) === "1";
}

export function setProgressByHours(on: boolean): void {
  if (on) storage.save(MODE_KEY, "1");
  else storage.remove(MODE_KEY);
}

export function toneLabel(tone: ProgressTone): string {
  switch (tone) {
    case "closed":
      return t("完成");
    case "resolved":
      return t("待驗證");
    case "active":
      return t("進行中");
    case "new":
      return t("還沒開始");
  }
}

/** 數字的寫法：依數量是「4/8」，依工時是「21/30 h」（沒有工時時改用數量）。 */
export function progressNumbers(p: Progress, hours: boolean): string {
  if (hours && hoursRatio(p) !== null) {
    const done = p.completed ?? 0;
    return t("{done}/{all} h", { done: hoursText(done), all: hoursText(done + (p.remaining ?? 0)) });
  }
  return `${p.counts.closed}/${p.total}`;
}

/** 滑鼠移上去看的說明：各類的數量（含狀態名稱）與工時。 */
export function progressTooltip(name: string, p: Progress): string {
  const ratio = doneRatio(p) ?? 0;
  const lines = [t("{name}：{done}/{total} 完成（{pct}%）", { name, done: p.counts.closed, total: p.total, pct: Math.round(ratio * 100) })];
  for (const tone of PROGRESS_TONES) {
    if (!p.counts[tone]) continue;
    // 只有一種狀態時不重複寫數字（「待驗證 1（Resolved）」）；好幾種時各自的數量（「完成 4（Closed 3、Done 1）」）。
    const list = p.states[tone];
    const states = list.length === 1 ? list[0][0] : list.map(([s, n]) => `${s} ${n}`).join(t("、"));
    lines.push(t("{label} {n}（{states}）", { label: toneLabel(tone), n: p.counts[tone], states }));
  }
  if (p.remaining !== null || p.completed !== null) {
    lines.push(t("剩餘 {remaining} 小時・已完成 {completed} 小時", { remaining: hoursText(p.remaining ?? 0), completed: hoursText(p.completed ?? 0) }));
  }
  return lines.join("\n");
}

/** 長條本身：`hours` 時只有已完成與剩餘兩段。 */
export function progressBar(p: Progress, hours: boolean, className = "wi-bar"): HTMLElement {
  const bar = document.createElement("span");
  bar.className = className;
  bar.setAttribute("role", "img");
  const seg = (tone: string, ratio: number) => {
    if (ratio <= 0) return;
    const i = document.createElement("i");
    i.className = `wi-bar-${tone}`;
    i.style.width = `${(ratio * 100).toFixed(2)}%`;
    bar.append(i);
  };
  const h = hours ? hoursRatio(p) : null;
  if (h !== null) {
    seg("closed", h);
    bar.setAttribute("aria-label", t("依工時完成 {pct}%", { pct: Math.round(h * 100) }));
  } else {
    for (const tone of PROGRESS_TONES) seg(tone, p.total ? p.counts[tone] / p.total : 0);
    bar.setAttribute("aria-label", t("完成 {done}/{total}", { done: p.counts.closed, total: p.total }));
  }
  return bar;
}
