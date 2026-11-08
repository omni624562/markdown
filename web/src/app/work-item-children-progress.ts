/**
 * 工作項目分頁「相關工作項目」裡「子項目」那一組的上方：一條分色長條（完成、待驗證、進行中、還沒開始）、
 * 「4/8 完成・1 待驗證・2 進行中」（顏色和長條一樣）、圖例，與工時（有填才顯示）。點長條的一段或圖例，下面的子項目只留那個狀態；再點一次全部顯示。
 * 刪除子項目之後（不重新讀取整頁）也會跟著更新。
 */
import type { AdoWorkItemRelation } from "../desktop.ts";
import { t } from "../i18n.ts";
import { relationLabels, stateTone, workItemIdOf } from "../issue-doc.ts";
import { progressBar, progressTooltip, toneLabel } from "../ui/progress-bar.ts";
import { PROGRESS_TONES, type ProgressTone, hoursText, progressOf } from "../work-item-progress.ts";

/** 子項目那一組的標題（H3）與清單（UL）；沒有子項目時是 null。 */
function childGroup(box: HTMLElement): { h3: HTMLElement; ul: HTMLElement } | null {
  const label = relationLabels().child;
  for (const el of box.children) {
    if (el.tagName !== "H3" || el.textContent?.trim() !== label) continue;
    const ul = el.nextElementSibling;
    if (ul?.tagName === "UL") return { h3: el as HTMLElement, ul: ul as HTMLElement };
  }
  return null;
}

/** 畫上（或重畫）子項目的進度；`relations` 是讀到的關聯。 */
export function renderChildProgress(box: HTMLElement, relations: readonly AdoWorkItemRelation[]): void {
  box.querySelector(":scope > .wi-progress")?.remove();
  const group = childGroup(box);
  const children = relations.filter((r) => r.link === "child");
  if (!group || !children.length) return;
  const p = progressOf(children);
  if (!p.total) return;
  const toneOf = new Map(children.map((c) => [c.id, stateTone(c.state)]));
  const wrap = document.createElement("div");
  wrap.className = "wi-progress";
  const head = document.createElement("div");
  head.className = "wi-progress-head";
  // 「0/6 完成・2 進行中」：完成只算結束的項目；待驗證、進行中另外寫出來，顏色和長條的那一段一樣，
  // 才不會看到長條有藍色、數字卻是 0 而以為算錯。
  const part = (tone: ProgressTone, text: string) => {
    const s = document.createElement("span");
    s.className = `wi-progress-count ${tone}`;
    s.textContent = text;
    return s;
  };
  head.replaceChildren(part("closed", t("{done}/{total} 完成", { done: p.counts.closed, total: p.total })));
  if (p.counts.resolved) head.append(t("・"), part("resolved", t("{n} 待驗證", { n: p.counts.resolved })));
  if (p.counts.active) head.append(t("・"), part("active", t("{n} 進行中", { n: p.counts.active })));
  const bar = progressBar(p, false, "wi-bar wi-bar-big");
  bar.title = progressTooltip(t("子項目"), p);
  const legend = document.createElement("div");
  legend.className = "wi-progress-legend";
  let only: ProgressTone | null = null;
  const apply = () => {
    for (const li of group.ul.querySelectorAll<HTMLLIElement>(":scope > li")) {
      const a = li.querySelector<HTMLAnchorElement>("a[href]");
      const id = a ? workItemIdOf(a.getAttribute("href") ?? "") : null;
      li.hidden = only !== null && (id === null || toneOf.get(id) !== only);
    }
    for (const b of legend.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String(b.dataset.tone === only));
  };
  const pick = (tone: ProgressTone) => {
    only = only === tone ? null : tone;
    apply();
  };
  for (const tone of PROGRESS_TONES) {
    if (!p.counts[tone]) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.tone = tone;
    b.setAttribute("aria-pressed", "false");
    b.title = t("只看「{label}」的子項目（再按一次全部顯示）", { label: toneLabel(tone) });
    const dot = document.createElement("span");
    dot.className = `ado-state-dot ${tone}`;
    b.append(dot, t("{label} {n}", { label: toneLabel(tone), n: p.counts[tone] }));
    b.addEventListener("click", () => pick(tone));
    legend.append(b);
  }
  // 點長條的某一段：和點圖例一樣。
  bar.addEventListener("click", (e) => {
    const seg = (e.target as HTMLElement).closest<HTMLElement>("i");
    const tone = PROGRESS_TONES.find((x) => seg?.classList.contains(`wi-bar-${x}`));
    if (tone) pick(tone);
  });
  wrap.append(head, bar, legend);
  if (p.remaining !== null || p.completed !== null) {
    const hours = document.createElement("div");
    hours.className = "wi-progress-hours";
    const done = p.completed ?? 0;
    const left = p.remaining ?? 0;
    hours.textContent = t("剩餘 {remaining} 小時・已完成 {completed} 小時・合計 {all} 小時", {
      remaining: hoursText(left),
      completed: hoursText(done),
      all: hoursText(done + left),
    });
    wrap.append(hours);
  }
  group.h3.after(wrap);
}
