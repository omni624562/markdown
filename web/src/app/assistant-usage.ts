/**
 * 助理的用量面板：按助理面板下方的「本月 已用 / 上限」打開，選期間看用量——今天、最近 7 天、這個月、
 * 上個月，和最近 14 天每天的費用。金額是 oMarker 依每次回覆的用量估計、記在這台電腦上的
 * （desktop/src/assistant.rs），不是向 Anthropic 查的；Anthropic 沒有提供查詢餘額或儲值到期日的 API，
 * 所以面板最下面放一個到 Claude Console 的連結。
 */
import { formatUsd } from "../assistant-text.ts";
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { placeMenu } from "../ui/menu-place.ts";
import { wasOpenOnPress } from "../ui/popover-toggle.ts";
import { summarize, type UsageHistory } from "../usage-summary.ts";

/** Claude Console 的用量頁（帳單、儲值餘額也在 Console 裡）。 */
const CONSOLE_URL = "https://platform.claude.com/usage";

let pop: HTMLElement | null = null;
let trigger: HTMLElement | null = null;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

/** `2026-11-15` → `11/15`；`2026-10` → `10 月`。 */
const dayLabel = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const monthLabel = (month: string) => t("{n} 月", { n: Number(month.slice(5, 7)) });

function row(label: string, value: string, note = ""): HTMLElement[] {
  const dd = el("dd", "", value);
  if (note) dd.append(el("small", "", note));
  return [el("dt", "", label), dd];
}

function render(h: UsageHistory): void {
  const s = summarize(h);
  const head = el("h3", "", t("助理用量（估計）"));
  const grid = el("dl", "usage-grid");
  grid.append(
    ...row(t("今天"), formatUsd(s.today)),
    ...row(t("最近 7 天"), formatUsd(s.last7)),
    ...row(t("本月"), formatUsd(s.month), t("上限 {limit}", { limit: `US$${Math.round(h.limit)}` })),
    ...row(t("上個月（{month}）", { month: monthLabel(s.lastMonthName) }), s.lastMonth === null ? t("沒有紀錄") : formatUsd(s.lastMonth)),
  );

  const daysHead = el("h4", "", t("最近 14 天"));
  const days = el("ol", "usage-days");
  const max = Math.max(...s.recent.map((d) => d.usd), 0.000001);
  for (const d of s.recent) {
    const li = el("li", d.usd > 0 ? "" : "usage-zero");
    const bar = el("span", "usage-bar");
    const fill = el("i");
    fill.style.width = `${Math.round((d.usd / max) * 100)}%`;
    bar.append(fill);
    li.append(el("span", "usage-date", d.date === h.today ? t("今天") : dayLabel(d.date)), bar, el("span", "usage-amount", d.usd > 0 ? formatUsd(d.usd) : "–"));
    days.append(li);
  }

  const notes = el("div", "usage-notes");
  if (s.untracked > 0) {
    notes.append(el("p", "", t("本月有 {usd} 是開始記錄每天用量之前用掉的，只算在本月的總額裡。", { usd: formatUsd(s.untracked) })));
  } else if (!s.since) {
    notes.append(el("p", "", t("還沒有每天的用量紀錄；從現在開始記。")));
  }
  notes.append(
    el("p", "", t("金額是 oMarker 依每次回覆的用量估計的，日期以這台電腦的時區為準。實際帳單、儲值餘額與到期日要到 Claude Console 查看（Anthropic 沒有提供查詢餘額的 API）。")),
  );
  const link = el("button", "btn btn-small", t("打開 Claude Console"));
  link.type = "button";
  link.addEventListener("click", () => void desktop?.openExternal(CONSOLE_URL));
  notes.append(link);

  pop!.replaceChildren(head, grid, daysHead, days, notes);
  place();
}

function place(): void {
  if (!pop?.matches(":popover-open") || !trigger) return;
  pop.style.maxHeight = "";
  const anchor = trigger.getBoundingClientRect();
  const { width, height } = pop.getBoundingClientRect();
  const p = placeMenu(anchor, { width, height }, { width: innerWidth, height: innerHeight });
  Object.assign(pop.style, { left: `${p.left}px`, top: `${p.top}px`, maxHeight: `${p.maxHeight}px` });
}

function build(): HTMLElement {
  const node = el("div", "stats-pop usage-pop");
  node.popover = "auto";
  node.tabIndex = -1;
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-label", t("助理用量（估計）"));
  node.addEventListener("toggle", (e) => trigger?.setAttribute("aria-expanded", String((e as ToggleEvent).newState === "open")));
  document.body.append(node);
  return node;
}

async function open(): Promise<void> {
  if (!desktop || !trigger) return;
  pop ??= build();
  // 先顯示「讀取中…」，讀到了再換成內容（原生端只是讀一個小檔案，通常馬上就好）。
  pop.replaceChildren(el("h3", "", t("助理用量（估計）")), el("p", "usage-loading", t("讀取中…")));
  pop.showPopover();
  trigger.setAttribute("aria-expanded", "true");
  place();
  pop.focus({ preventScroll: true });
  try {
    const history = await desktop.assistantUsageHistory();
    if (pop.matches(":popover-open")) render(history);
  } catch (e) {
    pop.replaceChildren(el("h3", "", t("助理用量（估計）")), el("p", "usage-loading", e instanceof Error ? e.message : String(e)));
  }
}

/** 讓「本月 已用 / 上限」那一格可以按：按一下打開用量面板，再按一次關上。 */
export function initUsagePanel(button: HTMLButtonElement): void {
  trigger = button;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  const wasOpen = wasOpenOnPress(button, () => pop);
  button.addEventListener("click", () => {
    if (wasOpen()) {
      if (pop?.matches(":popover-open")) pop.hidePopover();
      button.setAttribute("aria-expanded", "false");
    } else void open();
  });
}
