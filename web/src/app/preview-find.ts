/**
 * 「預覽」模式的尋找（Ctrl+F）：預覽沒有編輯區，編輯器的「尋找與取代」沒地方顯示，不處理的話按鍵會落到
 * 瀏覽器核心手上，跳出它內建的尋找框（蓋在視窗按鈕上，連檔案樹、大綱的字都找）。這裡在預覽上方放一列
 * 尋找列：只找預覽的內容，標出所有符合的地方，Enter／Shift+Enter 跳下一個、上一個，Esc 關閉。
 * 預覽不能編輯，所以沒有取代。用 CSS Custom Highlight API 標示，不改動預覽的 DOM。
 */
import { formatKeys } from "../commands.ts";
import { t } from "../i18n.ts";
import { type FindMatch, findMatches } from "../ui/issue-view.ts";
import { icon } from "../ui/icons.ts";
import { app } from "./context.ts";

const highlights = typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;

let bar: HTMLElement | null = null;
let input: HTMLInputElement;
let count: HTMLElement;
let matches: FindMatch[] = [];
let current = 0;
let observer: MutationObserver | null = null;
let timer = 0;

function button(label: string, iconName: string, run: () => void, keys?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn icon-only";
  b.title = keys ? t("{label}（{keys}）", { label, keys: formatKeys(keys) }) : label;
  b.setAttribute("aria-label", label);
  b.append(icon(iconName));
  b.addEventListener("click", run);
  return b;
}

function build(): HTMLElement {
  const el = document.createElement("div");
  el.className = "issue-find preview-find";
  el.hidden = true;
  input = document.createElement("input");
  input.type = "search";
  input.placeholder = t("在預覽中尋找");
  input.setAttribute("aria-label", t("在預覽中尋找"));
  input.addEventListener("input", () => search(false));
  count = document.createElement("span");
  count.className = "issue-find-count";
  count.setAttribute("aria-live", "polite");
  el.append(
    input,
    count,
    button(t("上一個"), "arrow-up", () => step(-1), "Shift-Enter"),
    button(t("下一個"), "arrow-down", () => step(1), "Enter"),
    button(t("關閉尋找"), "x", closePreviewFind),
  );
  el.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePreviewFind();
    } else if (e.key === "Enter" && e.target === input) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  });
  app.previewScroller.prepend(el);
  return el;
}

function textNodes(): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(app.previewEl, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** 重新找一次。`keep`：預覽重畫之後（內容變了）留在原來的第幾個，不跳回第一個、也不捲動。 */
function search(keep: boolean): void {
  matches = findMatches(textNodes(), input.value.trim());
  current = keep ? Math.min(current, Math.max(0, matches.length - 1)) : firstVisible();
  paint(!keep);
}

/** 從目前看到的地方往下的第一個符合處（不要每打一個字就跳回文件開頭）。 */
function firstVisible(): number {
  const top = app.previewScroller.getBoundingClientRect().top;
  const i = matches.findIndex((m) => range(m).getBoundingClientRect().bottom >= top);
  return Math.max(0, i);
}

function step(delta: number): void {
  const n = matches.length;
  if (!n) return;
  current = (current + delta + n) % n;
  paint(true);
}

function range(m: FindMatch): Range {
  const r = document.createRange();
  r.setStart(m.node, m.start);
  r.setEnd(m.node, m.end);
  return r;
}

function clearMarks(): void {
  highlights?.delete("issue-find");
  highlights?.delete("issue-find-current");
}

function paint(reveal: boolean): void {
  const n = matches.length;
  const q = input.value.trim();
  count.textContent = !q ? "" : n ? t("{current}／{total}", { current: current + 1, total: n }) : t("沒有結果");
  count.classList.toggle("issue-find-none", !!q && !n);
  if (!n) return clearMarks();
  // 目前的符合處在收合的區塊（<details>）裡：展開，才看得到、捲得過去。
  for (let el = matches[current].node.parentElement; el && el !== app.previewEl; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
  }
  const ranges = matches.map(range);
  highlights?.set("issue-find", new Highlight(...ranges));
  highlights?.set("issue-find-current", new Highlight(ranges[current]));
  if (!reveal) return;
  // 捲到目前的符合處（被尋找列蓋住、或在可視範圍外時，放到中間）。
  const box = ranges[current].getBoundingClientRect();
  const view = app.previewScroller.getBoundingClientRect();
  const covered = bar!.getBoundingClientRect().bottom;
  if (box.top < covered + 8 || box.bottom > view.bottom - 40) {
    app.previewScroller.scrollTop += box.top - view.top - view.height / 2;
  }
}

/** 打開尋找列；有選取一小段文字時先帶入。 */
export function openPreviewFind(): void {
  bar ??= build();
  bar.hidden = false;
  const sel = getSelection();
  const selected = sel?.toString().trim();
  if (selected && !selected.includes("\n") && app.previewEl.contains(sel?.anchorNode ?? null)) input.value = selected;
  input.focus();
  input.select();
  search(false);
  // 預覽重畫（文件被外部修改、助理改寫、復原…）之後，舊的文字節點可能已經不在畫面上：重新找。
  observer ??= new MutationObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => bar && !bar.hidden && search(true), 100);
  });
  observer.observe(app.previewEl, { childList: true, subtree: true, characterData: true });
}

export function closePreviewFind(): void {
  if (!bar || bar.hidden) return;
  const focused = bar.contains(document.activeElement);
  bar.hidden = true;
  observer?.disconnect();
  clearTimeout(timer);
  matches = [];
  clearMarks();
  // 焦點還給頁面（不留在藏起來的輸入框裡），Ctrl+Z 等按鍵照常。
  if (focused) (document.activeElement as HTMLElement | null)?.blur();
}

/** 尋找列開著。 */
export function previewFindOpen(): boolean {
  return !!bar && !bar.hidden;
}
