import "../../crates/md-core/src/document.css";
import "./styles.css";

import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import init, {
  type Heading,
  type RenderResult,
  formatAllTables,
  formatJson,
  formatTable,
  kindFromFileName,
} from "../pkg/md_wasm.js";
import { type Command, Commands, formatKeys } from "./commands.ts";
import { Editor, cursorInfo } from "./editor.ts";
import { desktop } from "./desktop.ts";
import { type FileHandle, type OpenedFile, download, openFile, openInitialFile, replaceExtension, saveFile, stem } from "./files.ts";
import { TABLE_TEMPLATE, insertBlock, insertLink, toggleLineStyle, toggleWrap } from "./format.ts";
import { type DocKind, KINDS, isKind } from "./kinds.ts";
import { highlightPlugin } from "./plugins/highlight.ts";
import { mathPlugin } from "./plugins/math.ts";
import { mermaidPlugin } from "./plugins/mermaid.ts";
import { Preview } from "./preview.ts";
import sample from "./sample.md?raw";
import { type Block, collectBlocks, offsetForLine } from "./scroll-sync.ts";
import { type Settings, SettingsStore } from "./settings.ts";
import * as storage from "./storage.ts";
import { editTable } from "./table.ts";
import { choose } from "./ui/choice.ts";
import { hydrateIcons, icon } from "./ui/icons.ts";
import { setupMenu } from "./ui/menu.ts";
import { Palette } from "./ui/palette.ts";
import { Review } from "./ui/review.ts";
import { SettingsDialog } from "./ui/settings-dialog.ts";
import { setupSplitter } from "./ui/splitter.ts";
import { toast } from "./ui/toast.ts";

type ViewMode = "editor" | "split" | "preview";
type ThemePref = "system" | "light" | "dark";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const workspace = $(".workspace");
const previewEl = $("#preview");
const previewScroller = $("#preview-scroller");
const outlineList = $<HTMLOListElement>("#outline-list");
const outlineEmpty = $("#outline-empty");
const parseErrorEl = $("#parse-error");
const emptyStateEl = $("#empty-state");
const formatBar = $("#format-bar");
const fileNameInput = $<HTMLInputElement>("#file-name");
const kindSelect = $<HTMLSelectElement>("#doc-kind");
const dirtyEl = $("#dirty");
const fileInput = $<HTMLInputElement>("#file-input");
const status = {
  kind: $("#status-kind"),
  cursor: $("#status-cursor"),
  stats: $("#status-stats"),
  save: $("#status-save"),
};

hydrateIcons();
await init();
const { store: settings, recovered: settingsRecovered } = await SettingsStore.load();

// ---- 狀態 ---------------------------------------------------------------

const narrowQuery = matchMedia("(max-width: 720px)");
const storedKind = storage.load("kind");
let kind: DocKind = isKind(storedKind) ? storedKind : "markdown";
let fileName = storage.load("name") ?? `未命名${KINDS[kind].ext}`;
let fileHandle: FileHandle | null = null;
/** 最後一次存檔／開檔／新增時內容的雜湊；目前內容與它不同就代表有未存檔的變更。 */
let baseline = storage.load("baseline");
/** 目前內容是否對應到一個實際存過或開啟過的檔案。 */
let fileBacked = storage.load("file-backed") === "1";
let draftSaved = false;
let view: ViewMode = "split";
let outlineShown = storage.load("outline") !== "hidden";
let splitRatio = Number(storage.load("split")) || 0.5;
let themePref: ThemePref = (storage.load("theme") as ThemePref | null) ?? "system";
let blocks: Block[] | null = null;
let editorTopLine = 1;

/** FNV-1a，只用來比較內容是否相同。 */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

// ---- 編輯器與預覽 -------------------------------------------------------

const preview = new Preview(previewEl, [
  highlightPlugin(),
  mathPlugin(() => settings.value.math),
  mermaidPlugin(() => settings.value.mermaid),
]);

/** 表格排版：關閉自動對齊時只移動游標，不重排。 */
const tableFormatter = (block: string) => (settings.value.tableAutoFormat ? formatTable(block) : undefined);

const review = new Review($("#review-bar"));

const editor = new Editor($("#editor"), storage.load("doc") ?? sample, kind, {
  onChange(doc) {
    scheduleRender();
    scheduleAutosave(doc);
  },
  onSelection: updateCursor,
  onScroll(line) {
    editorTopLine = line;
    syncPreview();
    updateActiveHeading();
  },
  getError: () => preview.result?.error ?? null,
}, {
  lineNumbers: settings.value.lineNumbers,
  autoPairBrackets: settings.value.autoPairBrackets,
  formatTable: tableFormatter,
  extra: [review.extension],
});
review.attach(editor.view);

function updateCursor(v: EditorView): void {
  const { line, column, selected } = cursorInfo(v);
  status.cursor.textContent = `第 ${line} 行，第 ${column} 欄` + (selected ? `（已選取 ${selected} 字）` : "");
}

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderNow();
  });
}

function renderNow(): void {
  const text = editor.text;
  const result = preview.update(text, kind);
  blocks = null;
  renderError(result);
  renderEmptyState(text);
  renderOutline(result.headings);
  renderStats(result);
  renderSaveState();
  editor.relint();
  syncPreview();
  updateActiveHeading();
}

function renderError({ error }: RenderResult): void {
  previewEl.classList.toggle("stale", !!error);
  parseErrorEl.hidden = !error;
  if (!error) return;
  const msg = document.createElement("p");
  msg.append(icon("circle-alert"));
  const strong = document.createElement("strong");
  strong.textContent = `${KINDS[kind].label} 格式錯誤（第 ${error.line} 行，第 ${error.column} 欄）`;
  const detail = document.createElement("span");
  detail.textContent = error.message;
  msg.append(strong, detail);
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "btn";
  jump.textContent = "跳到錯誤位置";
  jump.addEventListener("click", () => editor.reveal(error.line, error.column));
  parseErrorEl.replaceChildren(msg, jump);
}

function renderEmptyState(text: string): void {
  const empty = text.trim() === "";
  emptyStateEl.hidden = !empty;
  if (!empty) return;
  const hints: Record<DocKind, string> = {
    markdown: "在左邊開始寫，這裡會即時顯示排版結果。",
    text: "在左邊輸入文字，這裡會顯示閱讀版面。",
    json: "貼上 JSON，這裡會顯示可摺疊的樹狀檢視，並即時檢查語法。",
  };
  emptyStateEl.innerHTML = `<h2>空白文件</h2><p></p><div class="empty-actions"></div><p class="empty-tip">也可以直接把 .md、.txt、.json 檔拖曳進來</p>`;
  emptyStateEl.querySelector("p")!.textContent = hints[kind];
  const actions = emptyStateEl.querySelector(".empty-actions")!;
  const mk = (label: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = label;
    b.addEventListener("click", run);
    actions.append(b);
  };
  mk("開啟檔案", () => void commands.run("open"));
  if (kind === "markdown") mk("載入範例文件", () => editor.replaceAll(sample));
}

function renderOutline(headings: Heading[]): void {
  outlineEmpty.hidden = headings.length > 0;
  outlineEmpty.textContent =
    kind === "markdown" ? "文件中還沒有標題。用 # 開頭的行會出現在這裡。" : "只有 Markdown 文件的標題會顯示在大綱中。";
  outlineList.replaceChildren(
    ...headings.map((h) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `#${encodeURIComponent(h.id)}`;
      a.dataset.id = h.id;
      a.dataset.line = String(h.line);
      a.textContent = h.text || "（空白標題）";
      a.style.setProperty("--level", String(h.level));
      a.addEventListener("click", (e) => {
        e.preventDefault();
        if (view !== "preview") editor.reveal(h.line);
        if (view !== "editor") document.getElementById(h.id)?.scrollIntoView({ block: "start" });
        if (narrowQuery.matches) setOutline(false);
      });
      li.append(a);
      return li;
    }),
  );
}

/** 大綱標示目前閱讀到的段落。 */
function updateActiveHeading(): void {
  const links = [...outlineList.querySelectorAll<HTMLAnchorElement>("a")];
  if (!links.length) return;
  let active: HTMLAnchorElement | undefined;
  if (view === "preview") {
    const top = previewScroller.getBoundingClientRect().top + 48;
    for (const a of links) {
      const el = document.getElementById(a.dataset.id!);
      if (el && el.getBoundingClientRect().top <= top) active = a;
    }
  } else {
    for (const a of links) if (Number(a.dataset.line) <= editorTopLine + 1) active = a;
  }
  active ??= links[0];
  for (const a of links) {
    if (a === active) {
      if (a.getAttribute("aria-current") !== "location") {
        a.setAttribute("aria-current", "location");
        a.scrollIntoView({ block: "nearest" });
      }
    } else {
      a.removeAttribute("aria-current");
    }
  }
}

function renderStats({ stats }: RenderResult): void {
  status.kind.textContent = KINDS[kind].label;
  if (kind === "json") {
    status.stats.textContent = `${editor.view.state.doc.lines.toLocaleString()} 行 · ${editor.text.length.toLocaleString()} 字元`;
    return;
  }
  status.stats.textContent =
    `${stats.words.toLocaleString()} 字 · ${stats.chars.toLocaleString()} 字元` +
    (stats.readingMinutes ? ` · 約 ${stats.readingMinutes} 分鐘` : "");
}

function renderSaveState(): void {
  const text = editor.text;
  const dirty = baseline !== hash(text);
  dirtyEl.hidden = !dirty;
  const title = `${dirty ? "● " : ""}${fileName} - Markdown 編輯器`;
  if (document.title !== title) {
    document.title = title;
    desktop?.setTitle(title).catch(console.error);
  }
  status.save.dataset.state = dirty ? "dirty" : "saved";
  if (!dirty) status.save.textContent = fileBacked ? "已儲存" : "";
  else status.save.textContent = (fileBacked ? "尚未存檔" : "尚未存成檔案") + (draftSaved ? " · 草稿已自動保存" : "");
}

// ---- 捲動同步：編輯器帶動預覽 ---------------------------------------------

function syncPreview(): void {
  if (view !== "split" || narrowQuery.matches) return;
  const scroller = editor.view.scrollDOM;
  const max = scroller.scrollHeight - scroller.clientHeight;
  if (scroller.scrollTop <= 0) {
    previewScroller.scrollTop = 0;
  } else if (scroller.scrollTop >= max - 1) {
    // 編輯器捲到底時，預覽也捲到底，避免最後幾行對不上。
    previewScroller.scrollTop = previewScroller.scrollHeight;
  } else {
    blocks ??= collectBlocks(previewEl, previewScroller);
    previewScroller.scrollTop = blocks.length
      ? offsetForLine(blocks, editorTopLine)
      : // JSON 樹狀檢視沒有行號對應，改用捲動比例。
        (scroller.scrollTop / max) * (previewScroller.scrollHeight - previewScroller.clientHeight);
  }
}

new ResizeObserver(() => {
  blocks = null;
}).observe(previewEl);
previewScroller.addEventListener("scroll", () => view === "preview" && updateActiveHeading(), { passive: true });

// ---- 自動儲存草稿 -------------------------------------------------------

let saveTimer: number | undefined;
function scheduleAutosave(doc: string): void {
  clearTimeout(saveTimer);
  draftSaved = false;
  saveTimer = window.setTimeout(() => {
    draftSaved = storage.save("doc", doc);
    if (!draftSaved) toast("瀏覽器封鎖了儲存空間，草稿無法自動保存，請記得手動存檔。", { tone: "error" });
    renderSaveState();
  }, 400);
}

// ---- 文件操作 -----------------------------------------------------------

function setFileName(name: string): void {
  fileName = name;
  fileNameInput.value = name;
  storage.save("name", name);
  renderSaveState();
}

function setKind(next: DocKind, { rename = true } = {}): void {
  if (next === kind) return;
  kind = next;
  kindSelect.value = next;
  storage.save("kind", next);
  editor.setKind(next);
  // 還沒對應到實際檔案時，順便改副檔名，存檔時才會是正確的類型。
  if (rename && !fileHandle) setFileName(replaceExtension(fileName, KINDS[next].ext));
  preview.clear();
  buildFormatBar();
  renderNow();
}

function setBaseline(text: string, backed: boolean): void {
  baseline = hash(text);
  fileBacked = backed;
  storage.save("baseline", baseline);
  storage.save("file-backed", backed ? "1" : "");
}

function openDocument(
  name: string,
  text: string,
  handle: FileHandle | null,
  { kind: docKind, fromFile = true }: { kind?: DocKind; fromFile?: boolean } = {},
): void {
  if (review.active) review.finish();
  fileHandle = handle;
  kind = docKind ?? kindFromFileName(name);
  kindSelect.value = kind;
  storage.save("kind", kind);
  setFileName(name);
  editor.load(text, kind);
  editorTopLine = 1;
  previewScroller.scrollTop = 0;
  storage.save("doc", text);
  setBaseline(text, fromFile);
  preview.clear();
  buildFormatBar();
  renderNow();
}

function openOpenedFile(file: OpenedFile): void {
  openDocument(file.name, file.text, file.handle);
  if (file.encoding === "big5") {
    toast("這個檔案是 Big5 編碼，已轉換後顯示；存檔時會改存成 UTF-8。", { duration: 8000 });
  }
}

async function save(saveAs: boolean, force = false): Promise<void> {
  if (review.active) review.finish();
  const text = editor.text;
  const out = await saveFile(text, fileName, kind, fileHandle, { saveAs, force });
  if (!out) return;
  if (out.status === "conflict") {
    await resolveConflict(out.name, out.diskText);
    return;
  }
  fileHandle = out.handle;
  setBaseline(text, true);
  setFileName(out.name);
  toast(out.handle ? `已儲存到「${out.name}」` : `已下載「${out.name}」`, { tone: "success" });
}

/** 檔案在開啟後被別的程式改過：讓使用者比較差異、覆蓋或另存。 */
async function resolveConflict(name: string, diskText: string): Promise<void> {
  const choice = await choose(
    "檔案已被其他程式修改",
    `「${name}」在你開啟之後被其他程式（例如同步軟體或另一個編輯器）改過。要怎麼處理？`,
    [
      { id: "compare", label: "比較差異", primary: true },
      { id: "overwrite", label: "用我的版本覆蓋", danger: true },
      { id: "save-as", label: "另存新檔" },
      { id: "cancel", label: "取消" },
    ],
  );
  if (choice === "overwrite") await save(false, true);
  else if (choice === "save-as") await save(true);
  else if (choice === "compare") {
    const started = review.start(diskText, {
      title: "與磁碟上的版本比較",
      hint: "逐段選擇要採用哪個版本，全部處理完會自動存檔。",
      acceptLabel: "採用磁碟版本",
      rejectLabel: "保留我的版本",
      onFinish: () => void save(false, true).catch(reportError),
    });
    if (!started) await save(false, true);
  }
}

/** 對游標所在的表格執行操作；不在表格中時提示使用者。 */
function runTableEdit(kind: Parameters<typeof editTable>[0]): void {
  const ok = editTable(kind, (b) => formatTable(b))({
    state: editor.view.state,
    dispatch: (tr) => editor.view.dispatch(tr),
  });
  if (!ok) toast(kind === "delete-row" ? "標題列與分隔列不能刪除，或游標不在表格中。" : "請先把游標移到表格裡。");
  editor.view.focus();
}

// ---- 指令 ---------------------------------------------------------------

const commands = new Commands();
const isMarkdown = () => kind === "markdown" && view !== "preview";

function fmt(id: string, title: string, iconName: string, run: () => void, keys?: string): Command {
  return { id, title, group: "格式", icon: iconName, keys, when: isMarkdown, run };
}

commands.register(
  {
    id: "new",
    title: "新增文件",
    group: "檔案",
    icon: "file-plus",
    run() {
      const prev = { name: fileName, text: editor.text, handle: fileHandle, kind, baseline, fileBacked };
      openDocument(`未命名${KINDS[kind].ext}`, "", null, { kind, fromFile: false });
      if (prev.text) {
        toast("已建立新文件", {
          action: {
            label: "復原",
            run() {
              openDocument(prev.name, prev.text, prev.handle, { kind: prev.kind });
              baseline = prev.baseline;
              fileBacked = prev.fileBacked;
              storage.save("baseline", baseline ?? "");
              storage.save("file-backed", fileBacked ? "1" : "");
              renderSaveState();
            },
          },
        });
      }
      editor.view.focus();
    },
  },
  {
    id: "open",
    title: "開啟檔案…",
    group: "檔案",
    icon: "folder-open",
    keys: "Mod-o",
    async run() {
      const file = await openFile(fileInput);
      if (file) openOpenedFile(file);
    },
  },
  { id: "save", title: "儲存", group: "檔案", icon: "save", keys: "Mod-s", run: () => save(false) },
  { id: "save-as", title: "另存新檔…", group: "檔案", keys: "Mod-Shift-s", run: () => save(true) },
  {
    id: "export-html",
    title: "匯出成 HTML 檔",
    group: "檔案",
    icon: "download",
    async run() {
      const html = await preview.exportDocument(editor.text, kind, stem(fileName));
      const name = replaceExtension(fileName, ".html");
      if ((await download(name, html, "text/html")) && desktop) toast(`已匯出「${name}」`, { tone: "success" });
    },
  },
  {
    id: "copy-html",
    title: "複製 HTML",
    group: "檔案",
    icon: "copy",
    async run() {
      const result = preview.result;
      if (!result || result.error) {
        toast("文件有格式錯誤，修正後才能複製。", { tone: "error" });
        return;
      }
      // 複製出去的 HTML 不需要捲動同步用的 data-sourcepos。
      await navigator.clipboard.writeText(result.html.replace(/ data-sourcepos="[^"]*"/g, ""));
      toast("已複製 HTML 到剪貼簿", { tone: "success" });
    },
  },
  { id: "palette", title: "開啟指令面板", group: "說明", icon: "command", keys: "Mod-Shift-p", run: () => palette.open() },
  {
    id: "find",
    title: "搜尋與取代",
    group: "編輯",
    keys: "Mod-f",
    when: () => view !== "preview",
    run: () => void openSearchPanel(editor.view),
  },
  {
    id: "format-json",
    title: "格式化 JSON",
    group: "編輯",
    icon: "wand-sparkles",
    keys: "Shift-Alt-f",
    when: () => kind === "json",
    run() {
      try {
        const formatted = formatJson(editor.text);
        if (formatted !== editor.text) editor.replaceAll(formatted);
        toast("已重新排版（可用 Ctrl+Z 復原）", { tone: "success" });
      } catch (e) {
        const err = preview.result?.error;
        toast(`無法格式化：${e instanceof Error ? e.message : e}`, {
          tone: "error",
          action: err ? { label: "跳到錯誤", run: () => editor.reveal(err.line, err.column) } : undefined,
        });
      }
    },
  },
  fmt("bold", "粗體", "bold", () => editor.exec(toggleWrap("**")), "Mod-b"),
  fmt("italic", "斜體", "italic", () => editor.exec(toggleWrap("*")), "Mod-i"),
  fmt("strike", "刪除線", "strikethrough", () => editor.exec(toggleWrap("~~")), "Mod-Shift-x"),
  fmt("code", "行內程式碼", "code", () => editor.exec(toggleWrap("`")), "Mod-e"),
  fmt("link", "插入連結", "link", () => editor.exec(insertLink), "Mod-k"),
  fmt("h1", "標題 1", "heading-1", () => editor.exec(toggleLineStyle("h1")), "Mod-Alt-1"),
  fmt("h2", "標題 2", "heading-2", () => editor.exec(toggleLineStyle("h2")), "Mod-Alt-2"),
  fmt("h3", "標題 3", "heading-3", () => editor.exec(toggleLineStyle("h3")), "Mod-Alt-3"),
  fmt("quote", "引言", "quote", () => editor.exec(toggleLineStyle("quote"))),
  fmt("bullet", "項目清單", "list", () => editor.exec(toggleLineStyle("bullet")), "Mod-Shift-8"),
  fmt("ordered", "編號清單", "list-ordered", () => editor.exec(toggleLineStyle("ordered")), "Mod-Shift-7"),
  fmt("task", "待辦清單", "list-checks", () => editor.exec(toggleLineStyle("task")), "Mod-Shift-9"),
  fmt("code-block", "程式碼區塊", "square-code", () => editor.exec(insertBlock("```\n程式碼\n```", "程式碼"))),
  fmt("table", "插入表格", "table", () => editor.exec(insertBlock(TABLE_TEMPLATE, "欄位 1"))),
  fmt("hr", "分隔線", "minus", () => editor.exec(insertBlock("---"))),
  fmt("table-format", "表格：對齊目前的表格", "table", () => runTableEdit("format")),
  fmt("table-insert-row", "表格：在下方插入一列", "table", () => runTableEdit("insert-row")),
  fmt("table-insert-column", "表格：在右側插入一欄", "table", () => runTableEdit("insert-column")),
  fmt("table-delete-row", "表格：刪除目前這一列", "table", () => runTableEdit("delete-row")),
  fmt("table-delete-column", "表格：刪除目前這一欄", "table", () => runTableEdit("delete-column")),
  {
    id: "format-tables",
    title: "對齊文件中所有表格",
    group: "編輯",
    icon: "wand-sparkles",
    keys: "Shift-Alt-f",
    when: () => kind === "markdown",
    run() {
      const formatted = formatAllTables(editor.text);
      if (formatted === editor.text) {
        toast("所有表格都已經對齊。");
        return;
      }
      editor.replaceAll(formatted);
      toast("已對齊所有表格（可用 Ctrl+Z 復原）", { tone: "success" });
    },
  },
  {
    id: "settings",
    title: "設定",
    group: "說明",
    icon: "settings",
    keys: "Mod-,",
    run: () => settingsDialog.open(),
  },
  ...(["editor", "split", "preview"] as const).map(
    (mode): Command => ({
      id: `view-${mode}`,
      title: { editor: "只顯示編輯區", split: "編輯與預覽並排", preview: "只顯示預覽" }[mode],
      group: "檢視",
      icon: { editor: "pencil", split: "columns-2", preview: "eye" }[mode],
      when: () => mode !== "split" || !narrowQuery.matches,
      run: () => setView(mode),
    }),
  ),
  {
    id: "toggle-outline",
    title: "顯示／隱藏大綱",
    group: "檢視",
    icon: "panel-left",
    keys: "Mod-Shift-o",
    run: () => setOutline(!outlineShown),
  },
  ...(["system", "light", "dark"] as const).map(
    (pref): Command => ({
      id: `theme-${pref}`,
      title: { system: "主題：跟隨系統", light: "主題：淺色", dark: "主題：深色" }[pref],
      group: "檢視",
      icon: { system: "monitor", light: "sun", dark: "moon" }[pref],
      run: () => setTheme(pref),
    }),
  ),
  ...(Object.keys(KINDS) as DocKind[]).map(
    (k): Command => ({
      id: `kind-${k}`,
      title: `文件類型改為 ${KINDS[k].label}`,
      group: "檢視",
      when: () => kind !== k,
      run: () => setKind(k),
    }),
  ),
);

const palette = new Palette(commands);

// 全域快速鍵：在捕獲階段處理，確保焦點在任何地方都一致。
window.addEventListener(
  "keydown",
  (e) => {
    if (e.isComposing || document.querySelector("dialog[open]")) return;
    const cmd = commands.match(e);
    if (!cmd) return;
    const target = e.target as HTMLElement;
    const inField = target.matches("input, select, textarea") && !target.closest(".cm-editor");
    if (inField && cmd.group === "格式") return;
    e.preventDefault();
    e.stopPropagation();
    commands.run(cmd.id).catch(reportError);
  },
  { capture: true },
);

function reportError(e: unknown): void {
  console.error(e);
  toast(`操作失敗：${e instanceof Error ? e.message : e}`, { tone: "error" });
}

// ---- 工具列 -------------------------------------------------------------

function withKeys(title: string, keys?: string): string {
  return keys ? `${title}（${formatKeys(keys)}）` : title;
}

document.querySelectorAll<HTMLButtonElement>("[data-command]").forEach((btn) => {
  const cmd = commands.get(btn.dataset.command!)!;
  btn.title = withKeys(cmd.title, cmd.keys);
  if (btn.classList.contains("icon-only")) btn.setAttribute("aria-label", cmd.title);
  btn.addEventListener("click", () => commands.run(cmd.id).catch(reportError));
});
$("#palette-kbd").textContent = formatKeys("Mod-Shift-p");

setupMenu($<HTMLButtonElement>("#file-menu"), commands, [
  "new",
  "open",
  "-",
  "save",
  "save-as",
  "-",
  "export-html",
  "copy-html",
]);

const themeButton = $<HTMLButtonElement>("#theme-menu");
setupMenu(
  themeButton,
  commands,
  (["system", "light", "dark"] as const).map((pref) => ({
    label: { system: "跟隨系統", light: "淺色", dark: "深色" }[pref],
    icon: { system: "monitor", light: "sun", dark: "moon" }[pref],
    checked: () => themePref === pref,
    run: () => setTheme(pref),
  })),
);

/** 格式工具列依文件類型切換：Markdown 顯示格式按鈕、JSON 顯示格式化。 */
function buildFormatBar(): void {
  const groups: string[][] =
    kind === "markdown"
      ? [["h1", "h2", "h3"], ["bold", "italic", "strike", "code", "link"], ["bullet", "ordered", "task", "quote"], ["code-block", "table", "hr"]]
      : kind === "json"
        ? [["format-json"]]
        : [];
  formatBar.hidden = groups.length === 0;
  formatBar.replaceChildren(
    ...groups.flatMap((ids, gi) => {
      const buttons = ids.map((id) => {
        const cmd = commands.get(id)!;
        const b = document.createElement("button");
        b.type = "button";
        b.className = kind === "json" ? "btn" : "btn icon-only";
        b.title = withKeys(cmd.title, cmd.keys);
        b.setAttribute("aria-label", cmd.title);
        b.append(icon(cmd.icon!));
        if (kind === "json") b.append(Object.assign(document.createElement("span"), { textContent: cmd.title }));
        // 用 mousedown 阻止預設行為，按下按鈕時編輯器才不會失去選取範圍。
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", () => commands.run(id).catch(reportError));
        return b;
      });
      if (gi === 0) return buttons;
      const sep = document.createElement("span");
      sep.className = "format-sep";
      sep.setAttribute("aria-hidden", "true");
      return [sep, ...buttons];
    }),
  );
}

// 工具列的方向鍵導覽（WAI-ARIA toolbar 模式）。
formatBar.addEventListener("keydown", (e) => {
  const items = [...formatBar.querySelectorAll<HTMLElement>("button")];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === "ArrowRight") items[(i + 1) % items.length]?.focus();
  else if (e.key === "ArrowLeft") items[(i - 1 + items.length) % items.length]?.focus();
  else return;
  e.preventDefault();
});

fileNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") fileNameInput.blur();
  if (e.key === "Escape") {
    fileNameInput.value = fileName;
    fileNameInput.blur();
  }
});
fileNameInput.addEventListener("change", () => {
  const name = fileNameInput.value.trim();
  if (!name) {
    fileNameInput.value = fileName;
    return;
  }
  setFileName(name);
  const k = kindFromFileName(name);
  // 只在使用者明確打了已知副檔名時切換類型。
  if (/\.(md|markdown|txt|json)$/i.test(name) && k !== kind) setKind(k, { rename: false });
});

kindSelect.addEventListener("change", () => setKind(kindSelect.value as DocKind));

// ---- 版面 ---------------------------------------------------------------

function applyLayout(): void {
  const narrow = narrowQuery.matches;
  // 手機寬度放不下並排，分割模式改為只顯示編輯區（可用分頁切換到預覽）。
  const effective: ViewMode = narrow && view === "split" ? "editor" : view;
  workspace.dataset.view = effective;
  workspace.classList.toggle("outline-hidden", !outlineShown);
  workspace.classList.toggle("narrow", narrow);
  const cols = [
    outlineShown && !narrow ? "var(--outline-width)" : "0px",
    effective === "preview" ? "0px" : effective === "split" ? `minmax(0, ${splitRatio}fr)` : "minmax(0, 1fr)",
    effective === "split" ? "var(--splitter-width)" : "0px",
    effective === "editor" ? "0px" : effective === "split" ? `minmax(0, ${1 - splitRatio}fr)` : "minmax(0, 1fr)",
  ];
  workspace.style.gridTemplateColumns = cols.join(" ");
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.view === effective));
  });
  $("[data-command='toggle-outline']").setAttribute("aria-pressed", String(outlineShown));
  blocks = null;
  if (effective !== "preview") editor.view.requestMeasure();
}

function setView(mode: ViewMode): void {
  view = mode;
  storage.save("view", mode);
  applyLayout();
  syncPreview();
  updateActiveHeading();
  if (mode === "editor") editor.view.focus();
}

function setOutline(shown: boolean): void {
  outlineShown = shown;
  storage.save("outline", shown ? "shown" : "hidden");
  applyLayout();
}

function setTheme(pref: ThemePref): void {
  themePref = pref;
  storage.save("theme", pref);
  if (pref === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  const iconName = { system: "monitor", light: "sun", dark: "moon" }[pref];
  themeButton.querySelector(".theme-icon")!.replaceChildren(icon(iconName));
  themeButton.title = `主題：${{ system: "跟隨系統", light: "淺色", dark: "深色" }[pref]}`;
  // 流程圖的配色跟著主題，需要重畫。
  if (settings.value.mermaid) scheduleRender();
}

// 跟隨系統時，系統切換深淺色也要重畫流程圖。
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (themePref === "system" && settings.value.mermaid) scheduleRender();
});

// ---- 設定 ---------------------------------------------------------------

const PREVIEW_WIDTH: Record<Settings["previewWidth"], string> = { narrow: "680px", medium: "820px", wide: "1080px" };

function applySettings(s: Readonly<Settings>, changed?: (keyof Settings)[]): void {
  const root = document.documentElement.style;
  root.setProperty("--editor-font-size", `${s.editorFontSize}px`);
  root.setProperty("--preview-width", PREVIEW_WIDTH[s.previewWidth]);
  if (!changed) return;
  if (changed.includes("lineNumbers") || changed.includes("autoPairBrackets")) {
    editor.configure({ lineNumbers: s.lineNumbers, autoPairBrackets: s.autoPairBrackets });
  }
  if (changed.includes("editorFontSize")) editor.view.requestMeasure();
  if (changed.includes("math") || changed.includes("mermaid")) {
    preview.clear();
    renderNow();
  }
}

settings.subscribe(applySettings);
const settingsDialog = new SettingsDialog(settings, { get: () => themePref, set: setTheme });

document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((btn) => {
  const mode = btn.dataset.view as ViewMode;
  btn.title = commands.get(`view-${mode}`)!.title;
  btn.addEventListener("click", () => setView(mode));
});

setupSplitter($("#splitter"), workspace, splitRatio, (r) => {
  splitRatio = r;
  storage.save("split", String(r));
  applyLayout();
});

narrowQuery.addEventListener("change", () => {
  // 切換到手機寬度時，大綱抽屜先收起來，避免蓋住內容。
  if (narrowQuery.matches) outlineShown = false;
  applyLayout();
});

// 手機版：大綱以抽屜方式蓋在內容上，點外面關閉。
workspace.addEventListener("click", (e) => {
  if (narrowQuery.matches && outlineShown && !(e.target as HTMLElement).closest(".outline")) setOutline(false);
});

// ---- 拖曳開檔 -----------------------------------------------------------

const overlay = $(".drop-overlay");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  overlay.hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    overlay.hidden = true;
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    toast("檔案超過 20 MB，可能不是文字檔。", { tone: "error" });
    return;
  }
  openDocument(file.name, await file.text(), null);
  toast(`已開啟「${file.name}」`);
});

// ---- 初始狀態 -----------------------------------------------------------

const savedView = storage.load("view");
view = savedView === "editor" || savedView === "preview" ? savedView : "split";
// 第一次使用（或清除過資料）時，以目前內容（範例文件）為基準，不顯示未存檔。
if (!baseline) setBaseline(editor.text, false);
kindSelect.value = kind;
fileNameInput.value = fileName;
setTheme(themePref);
applySettings(settings.value);
if (settingsRecovered) toast("設定檔有無法讀取的內容，相關選項已恢復成預設值。", { tone: "error", duration: 8000 });
buildFormatBar();
// 手機上大綱是蓋在內容上的抽屜，一開始先收起來。
if (narrowQuery.matches) outlineShown = false;
applyLayout();
renderNow();
updateCursor(editor.view);

// 桌面版：開啟從命令列帶入的檔案（例如把 .md 拖到 exe 上）。
openInitialFile()
  .then((file) => file && openOpenedFile(file))
  .catch(reportError);
