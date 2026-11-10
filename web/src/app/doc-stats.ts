/**
 * 文件統計：狀態列的字數（設了目標時顯示進度），按一下打開「文件統計」：
 * 字數、字元、標題、閱讀與朗讀時間、今天寫了多少、選取範圍，以及這份文件的字數目標。
 *
 * 字數目標與「今天」的起點存在這台電腦（每份文件各自記，用路徑辨認），不會寫進檔案。
 */
import { wasOpenOnPress } from "../ui/popover-toggle.ts";
import { type RenderResult, type Stats, render as renderMarkdown } from "../../pkg/md_wasm.js";
import {
  type TodayMap,
  dayOf,
  goalProgress,
  justReached,
  parseGoal,
  speakingMinutes,
  trackToday,
  withGoal,
} from "../doc-stats-text.ts";
import { t } from "../i18n.ts";
import * as storage from "../storage.ts";
import { placeMenu } from "../ui/menu-place.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";

/** 選取範圍太大時不另外計算（避免卡住）。 */
const SELECTION_LIMIT = 2_000_000;

/** 最近一次的統計（打開統計面板時用）；`today` 是今天第一次看到這份文件時的字數。 */
let last: { stats: Stats; headings: number; key: string; today: number } | null = null;
let pop: HTMLDivElement | null = null;
let goalInput: HTMLInputElement;
let goalNote: HTMLElement;
/**
 * 剛輸入了看不懂的目標：提示留著，直到改了輸入框、設好目標或關掉面板。
 * 打字後字數晚一點才重新計算、面板重畫時，才不會把提示蓋回原本的說明。
 */
let goalError = false;
let goalBar: HTMLElement;
let goalClear: HTMLButtonElement;
let grid: HTMLElement;

// ---- 每份文件的目標與今天的起點 ---------------------------------------------

/** 辨認文件的鍵：先用路徑（關掉再開也找得到），沒有路徑時用分頁的 id。 */
function docKeys(): [string, string] {
  const a = app.active;
  const idKey = `doc:${a.id}`;
  if (a.path) return [`file:${a.path}`, idKey];
  if (a.wiki) return [`wiki:${a.wiki.wikiId}:${a.wiki.path}`, idKey];
  return [idKey, idKey];
}

function loadJson<T extends object>(key: string): T {
  try {
    const v = JSON.parse(storage.load(key) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

/** 第一次存檔前用分頁 id 記的，存成檔案後搬到路徑底下。 */
function migrate<T>(map: Record<string, T>, [key, idKey]: [string, string]): boolean {
  if (key === idKey || map[key] !== undefined || map[idKey] === undefined) return false;
  map[key] = map[idKey];
  delete map[idKey];
  return true;
}

function goalOf(keys: [string, string]): number | undefined {
  const goals = loadJson<Record<string, number>>("word-goals");
  if (migrate(goals, keys)) storage.save("word-goals", JSON.stringify(goals));
  const g = goals[keys[0]];
  return Number.isInteger(g) && g > 0 ? g : undefined;
}

function setGoal(goal: number | null): void {
  const keys = docKeys();
  storage.save("word-goals", JSON.stringify(withGoal(loadJson("word-goals"), keys[0], goal)));
  if (last) renderStatus(last.stats);
  renderPop();
}

/** 今天第一次看到這份文件時的字數。 */
function todayStart(keys: [string, string], words: number): number {
  const map = loadJson<TodayMap>("words-today");
  const moved = migrate(map, keys);
  const r = trackToday(map, keys[0], words, dayOf(new Date()));
  if (r.changed || moved) storage.save("words-today", JSON.stringify(r.map));
  return r.start;
}

// ---- 狀態列 ---------------------------------------------------------------------

const fmt = (n: number) => n.toLocaleString();

/** 狀態列的字數：設了目標時是「1,234 / 2,000 字」加上一條小小的進度。 */
function renderStatus(stats: Stats): void {
  const el = app.status.stats;
  const goal = goalOf(docKeys());
  el.replaceChildren();
  el.classList.toggle("has-goal", !!goal);
  if (goal) {
    const p = goalProgress(stats.words, goal);
    const bar = document.createElement("span");
    bar.className = "stats-mini-bar";
    bar.style.setProperty("--progress", String(p.ratio));
    el.append(bar, t("{n} / {goal} 字", { n: fmt(stats.words), goal: fmt(goal) }));
    el.classList.toggle("reached", p.reached);
  } else {
    el.classList.remove("reached");
    el.textContent = t("{n} 字", { n: fmt(stats.words) });
  }
  el.title =
    t("{words} 字 · {chars} 字元", { words: fmt(stats.words), chars: fmt(stats.chars) }) +
    (stats.readingMinutes ? t(" · 約 {n} 分鐘讀完", { n: stats.readingMinutes }) : "") +
    "\n" +
    t("按一下看文件統計、設定字數目標");
}

export function renderStats({ stats, headings }: RenderResult): void {
  const el = app.status.stats;
  if (app.cur.kind === "json") {
    el.classList.remove("has-goal", "reached");
    el.textContent = t("{lines} 行 · {chars} 字元", {
      lines: app.editor.view.state.doc.lines.toLocaleString(),
      chars: app.editor.text.length.toLocaleString(),
    });
    el.title = "";
    last = null;
    renderPop();
    return;
  }
  const keys = docKeys();
  const goal = goalOf(keys);
  // 同一份文件繼續寫、剛好跨過目標時恭喜一下（換文件、重新開啟不算）。
  if (last?.key === keys[0] && justReached(last.stats.words, stats.words, goal)) {
    toast(t("達成字數目標：{n} 字", { n: fmt(goal!) }), { tone: "success" });
  }
  // 內容還沒讀進來的文件（暫時是空的）不記今天的起點，免得之後整份都算成今天寫的。
  const today = app.active.unloaded ? stats.words : todayStart(keys, stats.words);
  last = { stats, headings: headings.length, key: keys[0], today };
  renderStatus(stats);
  renderPop();
}

// ---- 文件統計面板 -----------------------------------------------------------------

function selectionStats(): Stats | null {
  const state = app.editor.view.state;
  let text = "";
  for (const r of state.selection.ranges) {
    if (r.empty) continue;
    if (text.length + (r.to - r.from) > SELECTION_LIMIT) return null;
    text += `${state.sliceDoc(r.from, r.to)}\n`;
  }
  if (!text) return null;
  return renderMarkdown(text, { kind: app.cur.kind, skipHtml: true }).stats;
}

function row(label: string, value: string, note?: string): HTMLElement[] {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (note) dd.append(Object.assign(document.createElement("small"), { textContent: note }));
  return [dt, dd];
}

/**
 * 依目前的大小放在狀態列的字數旁邊。內容變了（統計算好、設了字數目標、選取範圍）就重新放：
 * 不然打開後變高的部分會往下長、蓋住字數本身，再按一次字數會點到面板裡，關不掉。
 */
function placePop(): void {
  if (!pop?.matches(":popover-open")) return;
  pop.style.maxHeight = "";
  const anchor = app.status.stats.getBoundingClientRect();
  const { width, height } = pop.getBoundingClientRect();
  const p = placeMenu(anchor, { width, height }, { width: innerWidth, height: innerHeight });
  Object.assign(pop.style, { left: `${p.left}px`, top: `${p.top}px`, maxHeight: `${p.maxHeight}px` });
}

function renderPop(): void {
  try {
    fillPop();
  } finally {
    placePop();
  }
}

function fillPop(): void {
  if (!pop?.matches(":popover-open")) return;
  if (!last) {
    // JSON 等沒有字數的文件。
    const doc = app.editor.view.state.doc;
    grid.replaceChildren(...row(t("行數"), fmt(doc.lines)), ...row(t("字元"), fmt(app.editor.text.length)));
    pop.querySelector<HTMLElement>(".stats-goal")!.hidden = true;
    return;
  }
  const { stats, headings } = last;
  const keys = docKeys();
  const today = stats.words - last.today;
  const speak = speakingMinutes(stats);
  const parts = [
    stats.cjkChars ? t("中文 {n}", { n: fmt(stats.cjkChars) }) : "",
    stats.latinWords ? t("英文 {n}", { n: fmt(stats.latinWords) }) : "",
  ].filter(Boolean);
  const rows = [
    ...row(t("字數"), fmt(stats.words), parts.length > 1 ? parts.join(t("、")) : undefined),
    ...row(t("字元"), fmt(stats.chars), t("不含空白")),
    ...row(t("標題數"), fmt(headings)),
    ...row(t("閱讀時間"), stats.readingMinutes ? t("約 {n} 分鐘", { n: stats.readingMinutes }) : "—"),
    ...row(t("朗讀時間"), speak ? t("約 {n} 分鐘", { n: speak }) : "—", t("報告、簡報的語速")),
    ...row(t("今天"), today > 0 ? t("+{n} 字", { n: fmt(today) }) : today < 0 ? t("−{n} 字", { n: fmt(-today) }) : t("還沒有新增")),
  ];
  const sel = selectionStats();
  if (sel) rows.push(...row(t("選取範圍"), t("{n} 字", { n: fmt(sel.words) }), t("{n} 字元", { n: fmt(sel.chars) })));
  grid.replaceChildren(...rows);

  const goalBox = pop.querySelector<HTMLElement>(".stats-goal")!;
  goalBox.hidden = false;
  const goal = goalOf(keys);
  if (document.activeElement !== goalInput) goalInput.value = goal ? String(goal) : "";
  goalClear.hidden = !goal;
  goalBar.parentElement!.hidden = !goal;
  if (goal) {
    const p = goalProgress(stats.words, goal);
    goalBar.style.setProperty("--progress", String(p.ratio));
    goalBar.parentElement!.classList.toggle("reached", p.reached);
    goalNote.textContent = p.reached
      ? t("已達成目標（{n} 字）", { n: fmt(goal) })
      : t("已完成 {pct}%，還差 {n} 字", { pct: Math.floor(p.ratio * 100), n: fmt(p.left) });
  } else {
    goalNote.textContent = t("設定這份文件要寫多少字，狀態列會顯示進度");
  }
  goalNote.classList.remove("error");
  if (goalError) showGoalError();
}

function showGoalError(): void {
  goalNote.textContent = t("請輸入 1 到 10,000,000 之間的字數，例如 2000、3k 或 1.5萬");
  goalNote.classList.add("error");
}

function buildPop(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "stats-pop";
  el.popover = "auto";
  el.tabIndex = -1;
  el.role = "dialog";
  el.setAttribute("aria-label", t("文件統計"));
  const h = document.createElement("h3");
  h.textContent = t("文件統計");
  grid = document.createElement("dl");
  grid.className = "stats-grid";

  const goalBox = document.createElement("div");
  goalBox.className = "stats-goal";
  const label = document.createElement("label");
  label.htmlFor = "stats-goal-input";
  label.textContent = t("字數目標");
  const line = document.createElement("div");
  line.className = "stats-goal-row";
  goalInput = document.createElement("input");
  goalInput.id = "stats-goal-input";
  goalInput.inputMode = "numeric";
  goalInput.autocomplete = "off";
  goalInput.placeholder = t("例如 2000");
  const unit = document.createElement("span");
  unit.textContent = t("字");
  goalClear = document.createElement("button");
  goalClear.type = "button";
  goalClear.className = "btn btn-small";
  goalClear.textContent = t("清除");
  goalClear.addEventListener("click", () => {
    goalInput.value = "";
    setGoal(null);
    goalInput.focus();
  });
  line.append(goalInput, unit, goalClear);
  const track = document.createElement("div");
  track.className = "stats-goal-track";
  goalBar = document.createElement("span");
  track.append(goalBar);
  goalNote = document.createElement("p");
  goalNote.className = "stats-goal-note";
  goalNote.setAttribute("aria-live", "polite");
  goalBox.append(label, line, track, goalNote);

  const apply = () => {
    const v = parseGoal(goalInput.value);
    goalError = v === undefined;
    if (goalError) {
      showGoalError();
      return;
    }
    setGoal(v ?? null);
  };
  goalInput.addEventListener("change", apply);
  // 改了輸入框：先收起錯誤提示，按 Enter 或離開欄位時再檢查。
  goalInput.addEventListener("input", () => {
    if (!goalError) return;
    goalError = false;
    renderPop();
  });
  goalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      apply();
    }
  });
  el.append(h, grid, goalBox);
  document.body.append(el);
  el.addEventListener("toggle", (e) => {
    const open = (e as ToggleEvent).newState === "open";
    if (!open) goalError = false;
    app.status.stats.setAttribute("aria-expanded", String(open));
    if (!open && document.activeElement === document.body) app.editor.view.focus();
  });
  return el;
}

/** 打開（或關閉）文件統計；`focusGoal` 時游標直接放在字數目標。 */
export function showDocStats(focusGoal = false): void {
  pop ??= buildPop();
  if (pop.matches(":popover-open") && !focusGoal) {
    pop.hidePopover();
    app.status.stats.setAttribute("aria-expanded", "false");
    return;
  }
  if (!pop.matches(":popover-open")) pop.showPopover();
  // toggle 事件晚一點才觸發，這裡先改，讀螢幕軟體一按下去就知道已經展開。
  app.status.stats.setAttribute("aria-expanded", "true");
  renderPop();
  // 焦點放進面板：按 Tab 就到字數目標，Esc 關閉後回到編輯區。
  if (focusGoal && !pop.querySelector<HTMLElement>(".stats-goal")!.hidden) {
    goalInput.focus();
    goalInput.select();
  } else pop.focus({ preventScroll: true });
}

/** 狀態列有顯示字數（看工作項目、Wiki 頁面、Git 歷史時沒有）。 */
export function statsShown(): boolean {
  return !document.querySelector(".statusbar")?.classList.contains("viewing");
}

export function initDocStats(): void {
  const el = app.status.stats;
  el.setAttribute("aria-haspopup", "dialog");
  el.setAttribute("aria-expanded", "false");
  // 再按一次狀態列的字數要關上（見 ui/popover-toggle.ts）。
  const wasOpen = wasOpenOnPress(el, () => pop);
  el.addEventListener("click", () => {
    if (wasOpen()) {
      if (pop?.matches(":popover-open")) pop.hidePopover();
      app.status.stats.setAttribute("aria-expanded", "false");
    } else showDocStats();
  });
}
