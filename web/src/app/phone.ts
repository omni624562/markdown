/**
 * 手機版面（Android 版、螢幕窄的時候）：像筆記 App 一樣操作，不是把電腦版縮小。
 *
 * - 首頁：文件清單（最近編輯的在上面）、搜尋、右下角「新增」。
 * - 編輯：上方只有「← 文件名稱 ✦ ⋮」與「編輯／預覽」切換；鍵盤打開時，鍵盤上方有一排常用格式。
 * - 「⋮」：從下面拉起來的選單（尋找、存檔、另存新檔、設定…），沒有快速鍵。
 * - 分頁列、狀態列、標題列、側邊欄都不顯示；Android 的「返回」鍵回到首頁。
 *
 * 桌面版、平板（螢幕寬）不受影響：只有 `body.phone` 時這些元件才出現（樣式在 styles.css 的「手機」）。
 */
import { t } from "../i18n.ts";
import { timeAgo } from "../history-label.ts";
import { isMobileApp } from "../platform.ts";
import { loadDraft } from "../session.ts";
import * as storage from "../storage.ts";
import { icon } from "../ui/icons.ts";
import type { Doc } from "../main.ts";
import { assistantEnabled, assistantOpen, toggleAssistant } from "./assistant.ts";
import { commands } from "./commands.ts";
import { app } from "./context.ts";

/** 手機版面的條件：Android 版、而且螢幕窄（平板直放也算寬，維持原本的版面）。 */
const NARROW = "(max-width: 600px)";

/** 每份文件最後編輯的時間（首頁依這個排序）。 */
const RECENT_KEY = "phone-recent";

function loadRecent(): Record<string, number> {
  try {
    const v = JSON.parse(storage.load(RECENT_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  e.append(...children);
  return e;
}

function iconButton(name: string, label: string, run: () => void): HTMLButtonElement {
  const b = el("button", "phone-icon", icon(name));
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", run);
  return b;
}

/** 執行指令（沒有這個指令或現在不能用時什麼都不做）。 */
async function run(id: string): Promise<void> {
  const cmd = commands.get(id);
  if (cmd && (!cmd.when || cmd.when())) await cmd.run();
}

/** 文件的內容（目前的文件從編輯器讀，其他從保存的狀態或草稿）。 */
function textOf(doc: Doc): string {
  if (doc === app.active) return app.editor.view.state.doc.toString();
  return doc.state?.doc.toString() ?? loadDraft(doc.id) ?? "";
}

/** 一行 Markdown 去掉符號後的文字（表格的格子用空白隔開）。 */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s*\|\s*/g, " ")
    .trim();
}

function plainLines(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => !/^\s*\|?[-:| ]+\|?\s*$/.test(l))
    .map(plainLine)
    .filter(Boolean);
}

/**
 * 首頁卡片與上方列的名稱，以及卡片上的摘要：還沒存成檔案的文件用第一行（通常是標題）當名稱，
 * 摘要從下一行開始；存過的檔案用檔名。
 */
export function describe(name: string, saved: boolean, text: string): { title: string; summary: string } {
  const lines = plainLines(text);
  const useFirst = !saved && lines.length > 0;
  return {
    title: useFirst ? lines[0].slice(0, 60) : name.replace(/\.(md|markdown|txt)$/i, ""),
    summary: (useFirst ? lines.slice(1) : lines).join(" ").slice(0, 120),
  };
}

let active = false;
let home: HTMLElement;
let bar: HTMLElement;
let fmt: HTMLElement;
let sheet: HTMLDialogElement;
let titleEl: HTMLElement;
let list: HTMLElement;
let search: HTMLInputElement;
let editTab: HTMLButtonElement;
let previewTab: HTMLButtonElement;
let assistantBtn: HTMLButtonElement;
const recent = loadRecent();

function touch(doc: Doc): void {
  recent[doc.id] = Date.now();
  // 只留現在開著的文件。
  const ids = new Set(app.docs.map((d) => d.id));
  for (const id of Object.keys(recent)) if (!ids.has(id)) delete recent[id];
  storage.save(RECENT_KEY, JSON.stringify(recent));
}

/** 首頁的文件：空白的未命名文件不列（「新增」就是它），最近編輯的在上面。 */
function homeDocs(): Doc[] {
  const q = search.value.trim().toLowerCase();
  return app.docs
    .filter((d) => !d.wiki)
    .map((d) => ({ d, text: textOf(d) }))
    .filter(({ d, text }) => text.trim() || d.fileBacked)
    .filter(({ d, text }) => !q || d.name.toLowerCase().includes(q) || text.toLowerCase().includes(q))
    .sort((a, b) => (recent[b.d.id] ?? 0) - (recent[a.d.id] ?? 0))
    .map(({ d }) => d);
}

function renderHome(): void {
  const docs = homeDocs();
  const cards = docs.map((d) => {
    const card = el("button", "phone-card");
    card.type = "button";
    const when = recent[d.id];
    const { title, summary } = describe(d.name, d.fileBacked, textOf(d));
    card.append(
      el("b", "", title),
      el("p", "", summary || t("（空白）")),
      el("small", "", [when ? timeAgo(when) : "", d.dirty ? t("未存檔") : ""].filter(Boolean).join(" · ")),
    );
    card.addEventListener("click", () => openDoc(d));
    const close = iconButton("x", t("關閉「{name}」", { name: d.name }), () => void app.closeTabs([d]).then(renderHome));
    close.classList.add("phone-card-close");
    close.addEventListener("click", (e) => e.stopPropagation());
    return el("div", "phone-card-wrap", card, close);
  });
  const empty = el(
    "p",
    "phone-empty",
    search.value.trim() ? t("找不到符合的文件") : t("還沒有文件。按「新增」開始寫，或開啟手機裡的檔案。"),
  );
  list.replaceChildren(...(cards.length ? cards : [empty]));
}

function openDoc(doc: Doc): void {
  if (doc !== app.active) app.activate(doc);
  showEditor();
}

/** 回到首頁（Android 的「返回」鍵也是）。 */
export function showHome(): void {
  if (!active) return;
  touch(app.active);
  if (assistantOpen()) toggleAssistant(false);
  sheet.open && sheet.close();
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.body.classList.add("phone-home-open");
  home.hidden = false;
  renderHome();
}

function showEditor(): void {
  document.body.classList.remove("phone-home-open");
  home.hidden = true;
  // 手機的「起始頁」就是首頁：空白文件直接開始寫。
  if (!app.startSkipped(app.active.id)) {
    app.skipStartPage(app.active.id);
    app.renderNow();
  }
  touch(app.active);
  syncBar();
  // 返回鍵回到首頁：進到文件時記一筆瀏覽紀錄。
  if (!history.state?.phoneDoc) history.pushState({ phoneDoc: true }, "");
}

function syncBar(): void {
  if (!active) return;
  titleEl.textContent = describe(app.cur.fileName, app.cur.fileBacked, app.editor.view.state.doc.line(1).text).title || app.cur.fileName;
  const preview = app.view === "preview";
  editTab.setAttribute("aria-pressed", String(!preview));
  previewTab.setAttribute("aria-pressed", String(preview));
  assistantBtn.hidden = !assistantEnabled();
  // 手機上沒有並排：只有「編輯」（所見即所得）與「預覽」。
  if (app.view === "split" || app.view === "editor") app.setView("live");
}

/** 新增或開啟之後（可能取消）：換了文件就進編輯畫面。 */
async function startFrom(id: string): Promise<void> {
  const before = app.active;
  await run(id);
  if (app.active !== before || id === "new") showEditor();
}

function buildHome(): HTMLElement {
  search = el("input", "phone-search");
  search.type = "search";
  search.placeholder = t("搜尋文件");
  search.addEventListener("input", renderHome);
  list = el("div", "phone-list");
  const chip = (label: string, name: string, runIt: () => void) => {
    const b = el("button", "phone-chip", icon(name), label);
    b.type = "button";
    b.addEventListener("click", runIt);
    return b;
  };
  const fab = el("button", "phone-fab", icon("plus"), t("新增"));
  fab.type = "button";
  fab.addEventListener("click", () => void startFrom("new"));
  const head = el(
    "header",
    "phone-appbar",
    el("h1", "", "oMarker"),
    iconButton("settings", t("設定"), () => void run("settings")),
  );
  const section = el(
    "section",
    "phone-home",
    head,
    el("div", "phone-search-wrap", icon("search"), search),
    el(
      "div",
      "phone-chips",
      chip(t("開啟檔案"), "folder-open", () => void startFrom("open")),
      chip(t("從範本新增"), "layout-template", () => void startFrom("new-from-template")),
    ),
    el("h2", "phone-sec", t("最近")),
    list,
    fab,
  );
  section.id = "phone-home";
  return section;
}

function buildBar(): HTMLElement {
  titleEl = el("span", "phone-title");
  assistantBtn = iconButton("sparkles", t("助理"), () => toggleAssistant());
  editTab = el("button", "", icon("pencil"), t("編輯"));
  previewTab = el("button", "", icon("eye"), t("預覽"));
  for (const [b, mode] of [
    [editTab, "live"],
    [previewTab, "preview"],
  ] as const) {
    b.type = "button";
    b.addEventListener("click", () => {
      app.setView(mode);
      syncBar();
    });
  }
  const header = el(
    "header",
    "phone-bar",
    el(
      "div",
      "phone-bar-row",
      iconButton("arrow-left", t("回到文件清單"), () => (history.state?.phoneDoc ? history.back() : showHome())),
      titleEl,
      assistantBtn,
      iconButton("ellipsis", t("更多"), openSheet),
    ),
    el("div", "phone-seg", editTab, previewTab),
  );
  header.id = "phone-bar";
  return header;
}

/** 鍵盤上方的格式列：按下時不搶走編輯區的焦點（鍵盤不會收起來）。 */
function buildFormat(): HTMLElement {
  const items: [string, string, string][] = [
    ["h2", "heading", t("標題")],
    ["bold", "bold", t("粗體")],
    ["italic", "italic", t("斜體")],
    ["bullet", "list", t("項目清單")],
    ["task", "list-checks", t("待辦清單")],
    ["link", "link", t("連結")],
    ["table", "table", t("表格")],
    ["undo", "undo-2", t("復原")],
  ];
  const toolbar = el("div", "phone-fmt");
  toolbar.id = "phone-fmt";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", t("格式"));
  for (const [id, name, label] of items) {
    const b = iconButton(name, label, () => void run(id));
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    toolbar.append(b);
  }
  return toolbar;
}

function buildSheet(): HTMLDialogElement {
  const d = el("dialog", "phone-sheet");
  d.id = "phone-sheet";
  const close = () => d.close();
  const act = (id: string) => () => {
    close();
    void run(id).then(syncBar);
  };
  const tile = (id: string, name: string, label: string) => {
    const b = el("button", "phone-tile", el("span", "", icon(name)), label);
    b.type = "button";
    b.dataset.cmd = id;
    b.addEventListener("click", act(id));
    return b;
  };
  const row = (id: string, name: string, label: string) => {
    const b = el("button", "phone-row", icon(name), label);
    b.type = "button";
    b.dataset.cmd = id;
    b.addEventListener("click", act(id));
    return b;
  };
  d.append(
    el("div", "phone-grab"),
    el("div", "phone-tiles", tile("find", "search", t("尋找")), tile("undo", "undo-2", t("復原")), tile("redo", "redo-2", t("重做")), tile("print", "printer", t("列印"))),
    el("div", "phone-rows", row("save", "save", t("存檔")), row("save-as", "file-down", t("另存新檔…")), row("rename-doc", "pencil", t("重新命名…")), row("settings", "settings", t("設定"))),
  );
  // 點選單外面（暗下來的地方）關閉。
  d.addEventListener("click", (e) => {
    if (e.target === d) close();
  });
  return d;
}

function openSheet(): void {
  // 現在不能用的指令不列（例如沒有改過的文件也能存檔，但沒有列印時就不顯示）。
  for (const b of sheet.querySelectorAll<HTMLElement>("[data-cmd]")) {
    const cmd = commands.get(b.dataset.cmd!);
    b.hidden = !cmd || (!!cmd.when && !cmd.when());
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
  sheet.showModal();
}

/** 鍵盤打開時，格式列貼在鍵盤上方（WebView 不一定會把視窗縮小）。 */
function followKeyboard(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const place = () => {
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    fmt.style.bottom = `${covered}px`;
  };
  vv.addEventListener("resize", place);
  vv.addEventListener("scroll", place);
  place();
}

function enable(on: boolean): void {
  active = on;
  document.body.classList.toggle("phone", on);
  if (!on) {
    document.body.classList.remove("phone-home-open");
    home.hidden = true;
    return;
  }
  syncBar();
  showHome();
}

export function initPhone(): void {
  if (!isMobileApp) return;
  home = buildHome();
  bar = buildBar();
  fmt = buildFormat();
  sheet = buildSheet();
  home.hidden = true;
  document.body.append(home, sheet, fmt);
  document.querySelector(".workspace")?.before(bar);
  followKeyboard();
  // 在編輯區打字時（鍵盤打開）才顯示格式列。
  const editorHost = document.getElementById("editor")!;
  editorHost.addEventListener("focusin", () => document.body.classList.add("phone-typing"));
  editorHost.addEventListener("focusout", () => document.body.classList.remove("phone-typing"));
  // 還沒存檔的文件用第一行當名稱：打字時上方列跟著換。
  editorHost.addEventListener("input", () => active && syncBar());
  // 助理在手機上蓋住整個畫面：返回鍵關閉它，不是回到首頁；標題列最左邊補一個「←」。
  new MutationObserver(() => {
    if (!active) return;
    const head = document.querySelector(".assistant-head");
    if (head && !head.querySelector(".phone-back")) {
      const back = iconButton("arrow-left", t("關閉助理"), () => (history.state?.phoneAssistant ? history.back() : toggleAssistant(false)));
      back.classList.add("phone-back");
      head.prepend(back);
    }
    if (assistantOpen() && !history.state?.phoneAssistant) history.pushState({ phoneDoc: true, phoneAssistant: true }, "");
  }).observe(document.getElementById("outline-right")!, { attributes: true, attributeFilter: ["hidden"], childList: true });
  window.addEventListener("popstate", () => {
    if (!active) return;
    if (!history.state?.phoneAssistant && assistantOpen()) toggleAssistant(false);
    if (!history.state?.phoneDoc) showHome();
  });
  // 從別的地方換了文件（開檔、指令面板）：標題跟著換，不在首頁時也記下時間。
  new MutationObserver(() => syncBar()).observe(document.getElementById("tab-bar")!, { childList: true, subtree: true, attributes: true });
  const query = matchMedia(NARROW);
  query.addEventListener("change", () => enable(query.matches));
  enable(query.matches);
}
