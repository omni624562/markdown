import "../../crates/md-core/src/document.css";
import "./styles.css";

import { undo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import init, {
  type Heading,
  type RenderResult,
  formatAllTables,
  formatJson,
  formatTable,
  kindFromFileName,
  render as renderMarkdown,
  spacingPositions,
} from "../pkg/md_wasm.js";
import { AiController } from "./ai.ts";
import { GitPanel } from "./git-ui.ts";
import { type Command, Commands, formatKeys, fuzzyScore } from "./commands.ts";
import { Editor, cursorInfo } from "./editor.ts";
import {
  type DavConnection,
  type EditorSnapshot,
  type Entry,
  type FileItem,
  type Folder,
  desktop,
  displayPath,
  isRemote,
} from "./desktop.ts";
import type { EditorState } from "@codemirror/state";
import {
  type FileHandle,
  type OpenedFile,
  desktopHandle,
  download,
  fromDesktop,
  openFile,
  replaceExtension,
  saveFile,
  stem,
} from "./files.ts";
import { TABLE_TEMPLATE, insertBlock, insertLink, toggleLineStyle, toggleWrap } from "./format.ts";
import { type DocKind, KINDS } from "./kinds.ts";
import { basename, dirname, isInside, localImagePath, markdownUrl, rebase, resolvePath } from "./paths.ts";
import { highlightPlugin } from "./plugins/highlight.ts";
import { localImagesPlugin } from "./plugins/local-images.ts";
import { mathPlugin } from "./plugins/math.ts";
import { mermaidPlugin } from "./plugins/mermaid.ts";
import { Preview } from "./preview.ts";
import sample from "./sample.md?raw";
import { type Block, collectBlocks, offsetForLine } from "./scroll-sync.ts";
import {
  DEFAULTS as DEFAULT_SETTINGS,
  FONT_SIZE_RANGE,
  type QuickAction,
  type Settings,
  SettingsStore,
} from "./settings.ts";
import { pasteAsMarkdown } from "./html-paste.ts";
import { moveSection, sectionRange, swapSection } from "./sections.ts";
import { type HeadingRef, linkCompletion } from "./link-complete.ts";
import { type DocMeta, dropDraft, loadDraft, loadSession, newId, saveDraft, saveSession } from "./session.ts";
import * as storage from "./storage.ts";
import { editTable } from "./table.ts";
import { choose } from "./ui/choice.ts";
import { FileTree, type TreeAction } from "./ui/filetree.ts";
import { hydrateIcons, icon } from "./ui/icons.ts";
import { setupMenu } from "./ui/menu.ts";
import { Palette } from "./ui/palette.ts";
import { Picker } from "./ui/picker.ts";
import { Review } from "./ui/review.ts";
import { SearchPanel } from "./ui/search-panel.ts";
import { SettingsDialog } from "./ui/settings-dialog.ts";
import { TabBar } from "./ui/tabbar.ts";
import { TerminalPanel } from "./ui/terminal-panel.ts";
import { WebDavDialog } from "./ui/webdav-dialog.ts";
import { Updater, versionLabel } from "./updater.ts";
import { sizeLabel, versionTitle } from "./history-label.ts";
import type { FileVersion } from "./desktop.ts";
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

/** FNV-1a，只用來比較內容是否相同。 */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/** 一個分頁。目前分頁的欄位另外放在下方的全域變數，切換分頁時互相同步。 */
interface Doc extends DocMeta {
  handle: FileHandle | null;
  /** 不在前景時保存的編輯器狀態（含復原紀錄）。 */
  state: EditorState | null;
  scrollTop: number;
  dirty: boolean;
  /** 檔案已從磁碟刪除。 */
  missing?: boolean;
  /** 在背景被外部修改時，修改前的內容；切換到這個分頁時逐段標示差異（A4）。 */
  externalOriginal?: string;
}

function makeDoc(meta: Partial<DocMeta> & { name: string; kind: DocKind }): Doc {
  return {
    id: newId(),
    path: null,
    // 新的空白文件不算有未存檔的變更。
    baseline: hash(""),
    fileBacked: false,
    handle: null,
    state: null,
    scrollTop: 0,
    dirty: false,
    ...meta,
  };
}

const restored = loadSession();
let docs: Doc[] = (restored?.docs ?? []).map((m) => ({
  ...makeDoc(m),
  ...m,
  // 只有桌面版會記下路徑；先建立控制代碼，否則第一次保存分頁狀態時路徑會被清掉。
  handle: m.path && desktop ? desktopHandle(m.path, m.name) : null,
  dirty: hash(loadDraft(m.id) ?? "") !== m.baseline,
}));
if (!docs.length) {
  // 第一次使用：開啟範例文件，並以它為基準（不顯示未存檔）。
  const first = makeDoc({ name: "未命名.md", kind: "markdown", baseline: hash(sample) });
  saveDraft(first.id, sample);
  docs = [first];
}
let active: Doc = docs.find((d) => d.id === restored?.activeId) ?? docs[0];

let kind: DocKind = active.kind;
let fileName = active.name;
let fileHandle: FileHandle | null = active.handle;
/** 最後一次存檔／開檔／新增時內容的雜湊；目前內容與它不同就代表有未存檔的變更。 */
let baseline = active.baseline;
/** 目前內容是否對應到一個實際存過或開啟過的檔案。 */
let fileBacked = active.fileBacked;
let draftSaved = false;
let view: ViewMode = "split";
let outlineShown = storage.load("outline") !== "hidden";
let splitRatio = Number(storage.load("split")) || 0.5;
let themePref: ThemePref = (storage.load("theme") as ThemePref | null) ?? "system";
let blocks: Block[] | null = null;
let editorTopLine = 1;

// ---- 編輯器與預覽 -------------------------------------------------------

const preview = new Preview(previewEl, [
  highlightPlugin(),
  mathPlugin(() => settings.value.math),
  mermaidPlugin(() => settings.value.mermaid),
  ...(desktop
    ? [localImagesPlugin(() => (fileHandle?.path ? dirname(fileHandle.path) : null), desktop.fileUrl, desktop.davImage)]
    : []),
]);

/** 表格排版：關閉自動對齊時只移動游標，不重排。 */
const tableFormatter = (block: string) => (settings.value.tableAutoFormat ? formatTable(block) : undefined);

const review = new Review($("#review-bar"));
/** AI 協作與終端機（桌面版才有，在下面的「AI 協作」段落建立）。 */
let ai: AiController | null = null;
let terminal: TerminalPanel | null = null;
let updater: Updater | null = null;

/** 按下 Ctrl+Shift+V 後的短時間內，貼上一律用純文字。 */
let plainPasteUntil = 0;

const editor = new Editor($("#editor"), loadDraft(active.id) ?? "", kind, {
  onChange(doc) {
    scheduleRender();
    scheduleAutosave(doc);
    ai?.scheduleSync();
  },
  onSelection(v) {
    updateCursor(v);
    ai?.scheduleSync();
  },
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
  focusMode: settings.value.focusMode,
  typewriterMode: settings.value.typewriterMode,
  extra: [
    review.extension,
    linkCompletion({
      enabled: () => kind === "markdown",
      docPath: () => fileHandle?.path ?? null,
      files: async () => {
        if (!desktop || !workspaceRoot) return [];
        fileListCache ??= await desktop.listFiles(workspaceRoot.path).catch(() => []);
        return fileListCache.map((f) => f.path);
      },
      headings: () => preview.result?.headings ?? [],
      fileHeadings: headingsOfFile,
    }),
    EditorView.domEventHandlers({
      keydown(e) {
        // Ctrl+Shift+V：接下來的貼上一律貼純文字（交給編輯器原本的處理）。
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyV") {
          plainPasteUntil = Date.now() + 1000;
        }
        return false;
      },
      paste(e, v) {
        const data = e.clipboardData;
        // 從 Word、Excel 複製的內容也帶有圖片版本；有文字時一律當成貼上文字。
        const files = imageFiles(data?.files);
        if (files.length && !data?.getData("text/plain")) {
          e.preventDefault();
          void insertImages(files).catch(reportError);
          return true;
        }
        const plainOnly = Date.now() < plainPasteUntil;
        plainPasteUntil = 0;
        // 從 VS Code 等編輯器複製的程式碼帶有上色用的 HTML，照原樣貼上純文字。
        if (plainOnly || !data || kind !== "markdown" || !settings.value.smartPaste) return false;
        if (data.types.includes("vscode-editor-data")) return false;
        const md = pasteAsMarkdown(data.getData("text/html"), data.getData("text/plain"));
        if (md === null) return false;
        e.preventDefault();
        v.dispatch(v.state.replaceSelection(md), { scrollIntoView: true, userEvent: "input.paste" });
        return true;
      },
      contextmenu(e, v) {
        // 有選取文字且開啟 AI 時，右鍵選單提供快捷動作。
        const { from, to } = v.state.selection.main;
        if (!ai?.enabled || from === to) return false;
        e.preventDefault();
        showAiMenu(e.clientX, e.clientY);
        return true;
      },
      drop(e, v) {
        if (!e.dataTransfer?.files.length) return false;
        // 檔案交給視窗的 drop 處理（文字檔開新分頁、圖片插入），不讓編輯器把檔案內容當成文字插入。
        // 圖片要插入在放開的位置，先把游標移過去。
        const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos !== null && imageFiles(e.dataTransfer.files).length) v.dispatch({ selection: { anchor: pos } });
        return true;
      },
    }),
  ],
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
  outlineHeadings = headings;
  const movable = kind === "markdown";
  outlineList.replaceChildren(
    ...headings.map((h, i) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `#${encodeURIComponent(h.id)}`;
      a.dataset.id = h.id;
      a.dataset.line = String(h.line);
      a.dataset.index = String(i);
      a.textContent = h.text || "（空白標題）";
      a.style.setProperty("--level", String(h.level));
      a.addEventListener("click", (e) => {
        e.preventDefault();
        if (view !== "preview") editor.reveal(h.line);
        if (view !== "editor") document.getElementById(h.id)?.scrollIntoView({ block: "start" });
        if (narrowQuery.matches) setOutline(false);
      });
      if (movable) {
        a.draggable = true;
        a.title = "拖曳可以搬移整個章節；也可以按 Alt+↑／↓";
      }
      li.append(a);
      return li;
    }),
  );
}

// ---- 連結：自動完成另一份文件的標題、點預覽中的連結（E9） ------------------------

const headingCache = new Map<string, { at: number; headings: HeadingRef[] }>();

/** 另一份文件的標題。已開啟的分頁用目前（可能還沒存檔）的內容，其他檔案從磁碟讀取（快取 10 秒）。 */
async function headingsOfFile(path: string): Promise<HeadingRef[]> {
  if (!/\.(md|markdown)$/i.test(path)) return [];
  const open = tabForPath(path);
  let text: string | null = open ? (open === active ? editor.text : loadDraft(open.id)) : null;
  if (text === null) {
    const cached = headingCache.get(path);
    if (cached && Date.now() - cached.at < 10_000) return cached.headings;
    if (!desktop) return [];
    text = await desktop.peekText(path);
  }
  const headings = renderMarkdown(text, { kind: "markdown" }).headings;
  if (!open) headingCache.set(path, { at: Date.now(), headings });
  return headings;
}

/** 捲到目前文件中的錨點（標題或註腳）。 */
function scrollToAnchor(id: string): void {
  const heading = preview.result?.headings.find((h) => h.id === id);
  if (heading && view !== "preview") editor.reveal(heading.line);
  if (view !== "editor") document.getElementById(id)?.scrollIntoView({ block: "start" });
}

function decodeHref(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** 點預覽中的連結：錨點在文件內捲動、外部網址用瀏覽器開啟、相對路徑的文件開成分頁。 */
async function followLink(href: string): Promise<void> {
  if (href.startsWith("#")) {
    scrollToAnchor(decodeHref(href.slice(1)));
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    if (desktop) await desktop.openExternal(href);
    else window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  // 其他協定（file: 等）一律不處理。
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return;
  const hashAt = href.indexOf("#");
  const rel = decodeHref(hashAt >= 0 ? href.slice(0, hashAt) : href);
  const anchor = hashAt >= 0 ? decodeHref(href.slice(hashAt + 1)) : "";
  const base = fileHandle?.path;
  if (!desktop || !base) {
    toast(desktop ? "存檔之後才能開啟相對路徑的連結。" : "網頁版無法開啟相對路徑的檔案，請改用桌面版。");
    return;
  }
  const target = resolvePath(dirname(base), rel);
  if (!/\.(md|markdown|txt|json)$/i.test(target)) {
    toast("只能在編輯器中開啟 Markdown、純文字與 JSON 檔。");
    return;
  }
  await openPath(target);
  if (anchor) {
    renderNow();
    scrollToAnchor(anchor);
  }
}

previewEl.addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[href]");
  if (!link || e.defaultPrevented) return;
  // 不讓整個編輯器視窗被導到別的網頁。
  e.preventDefault();
  void followLink(link.getAttribute("href") ?? "").catch(reportError);
});

// ---- 列印／匯出 PDF（E11） ------------------------------------------------------

/**
 * 用和「匯出 HTML」相同的內容（公式、流程圖都已轉好）建立一個看不見的 iframe 來列印，
 * 在列印對話框中選「另存為 PDF」就能存成 PDF。一律用淺色主題列印。
 */
async function printDocument(): Promise<void> {
  if (preview.result?.error) {
    toast("文件有格式錯誤，修正後才能列印。", { tone: "error" });
    return;
  }
  const html = await preview.exportDocument(editor.text, kind, stem(fileName));
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.documentElement.dataset.theme = "light";
  await resolvePrintImages(doc);
  document.querySelector("iframe.print-frame")?.remove();
  const frame = document.createElement("iframe");
  frame.className = "print-frame";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  frame.srcdoc = `<!doctype html>\n${doc.documentElement.outerHTML}`;
  document.body.append(frame);
  await loaded;
  const win = frame.contentWindow!;
  const images = [...frame.contentDocument!.images].filter((img) => !img.complete);
  await Promise.all(
    images.map(
      (img) =>
        new Promise((resolve) => {
          img.addEventListener("load", resolve);
          img.addEventListener("error", resolve);
        }),
    ),
  );
  await frame.contentDocument!.fonts?.ready;
  win.addEventListener("afterprint", () => setTimeout(() => frame.remove(), 0), { once: true });
  win.focus();
  win.print();
}

/** 文件中以相對路徑引用的圖片，換成列印用的 iframe 能載入的網址。 */
async function resolvePrintImages(doc: Document): Promise<void> {
  const docPath = fileHandle?.path;
  if (!desktop || !docPath) return;
  const dir = dirname(docPath);
  await Promise.all(
    [...doc.querySelectorAll<HTMLImageElement>("img[src]")].map(async (img) => {
      const path = localImagePath(img.getAttribute("src")!, dir);
      if (!path) return;
      try {
        img.setAttribute("src", isRemote(path) ? await desktop!.davImage(path) : desktop!.fileUrl(path));
      } catch {
        img.alt = `${img.alt || "圖片"}（無法載入）`;
      }
    }),
  );
}

// ---- 大綱拖曳重排章節（E10） ----------------------------------------------------

let outlineHeadings: Heading[] = [];
let draggingSection: number | null = null;

/** 搬移章節（一次可復原的編輯），再把大綱焦點放回被搬移的標題。 */
function applySectionMove(text: string | null, movedIndex: number, focusLink: boolean): void {
  if (text === null) return;
  if (review.active) review.finish();
  editor.replaceAll(text, { userEvent: "move.section", isolate: true });
  renderNow();
  const link = outlineList.querySelectorAll<HTMLAnchorElement>("a")[movedIndex];
  if (!link) return;
  if (view !== "preview") editor.reveal(Number(link.dataset.line));
  if (focusLink) link.focus();
}

function clearDropMarks(): void {
  for (const el of outlineList.querySelectorAll(".drop-before, .drop-after, .dragging")) {
    el.classList.remove("drop-before", "drop-after", "dragging");
  }
}

/** 放開的位置：滑鼠在標題上半部是「搬到這個標題前面」，下半部是「搬到下一個標題前面」。 */
function dropTarget(e: DragEvent): { li: HTMLElement; before: number; after: boolean } | null {
  const link = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[data-index]");
  if (!link) return null;
  const li = link.parentElement!;
  const rect = link.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  return { li, before: Number(link.dataset.index) + (after ? 1 : 0), after };
}

outlineList.addEventListener("dragstart", (e) => {
  const link = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[data-index]");
  if (!link || kind !== "markdown") return;
  draggingSection = Number(link.dataset.index);
  link.parentElement!.classList.add("dragging");
  e.dataTransfer!.effectAllowed = "move";
  e.dataTransfer!.setData("text/plain", link.textContent ?? "");
});
outlineList.addEventListener("dragover", (e) => {
  if (draggingSection === null) return;
  const t = dropTarget(e);
  if (!t) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  for (const el of outlineList.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
  t.li.classList.add(t.after ? "drop-after" : "drop-before");
});
outlineList.addEventListener("dragleave", (e) => {
  if (!outlineList.contains(e.relatedTarget as Node)) {
    for (const el of outlineList.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
  }
});
outlineList.addEventListener("drop", (e) => {
  const from = draggingSection;
  const t = dropTarget(e);
  clearDropMarks();
  draggingSection = null;
  if (from === null || !t) return;
  e.preventDefault();
  const out = moveSection(editor.text, outlineHeadings, from, t.before);
  if (out === null) return;
  // 搬移後，被搬移的標題在大綱中的新位置。
  const count = sectionRange(outlineHeadings, from, editor.view.state.doc.lines);
  const size = outlineHeadings.filter((h) => h.line >= count.first && h.line < count.end).length;
  applySectionMove(out, t.before > from ? t.before - size : t.before, false);
});
outlineList.addEventListener("dragend", () => {
  clearDropMarks();
  draggingSection = null;
});
outlineList.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  const link = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[data-index]");
  if (!link || kind !== "markdown") return;
  e.preventDefault();
  const moved = swapSection(editor.text, outlineHeadings, Number(link.dataset.index), e.key === "ArrowUp" ? -1 : 1);
  if (moved) applySectionMove(moved.text, moved.index, true);
});

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
  if (active.dirty !== dirty) {
    active.dirty = dirty;
    renderTabs();
  }
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
let pendingDraft: { id: string; text: string } | null = null;

function scheduleAutosave(doc: string): void {
  clearTimeout(saveTimer);
  draftSaved = false;
  // 記下是哪個分頁的內容：計時器觸發前可能已經切換到別的分頁。
  pendingDraft = { id: active.id, text: doc };
  saveTimer = window.setTimeout(flushDraft, 400);
}

/** 立刻寫入尚未儲存的草稿（切換、關閉分頁前呼叫）。 */
function flushDraft(): void {
  clearTimeout(saveTimer);
  if (!pendingDraft) return;
  const { id, text } = pendingDraft;
  pendingDraft = null;
  if (!docs.some((d) => d.id === id)) return; // 分頁已經關閉
  draftSaved = saveDraft(id, text);
  if (!draftSaved) toast("瀏覽器封鎖了儲存空間，草稿無法自動保存，請記得手動存檔。", { tone: "error" });
  renderSaveState();
}

// ---- 文件操作 -----------------------------------------------------------

function setFileName(name: string): void {
  fileName = name;
  fileNameInput.value = name;
  persistSession();
  renderSaveState();
  renderTabs();
}

function setKind(next: DocKind, { rename = true } = {}): void {
  if (next === kind) return;
  kind = next;
  kindSelect.value = next;
  persistSession();
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
  persistSession();
}

// ---- 分頁 ---------------------------------------------------------------

const tabBar = new TabBar($("#tab-bar"), {
  select: (id) => {
    const doc = docs.find((d) => d.id === id);
    if (doc) activate(doc);
  },
  close: (id) => void closeTab(id).catch(reportError),
  create: () => void commands.run("new"),
});

// ---- 側邊欄：檔案、大綱、搜尋 ---------------------------------------------

type SidePanel = "files" | "outline" | "search";
const SIDE_PANELS: SidePanel[] = ["files", "outline", "search"];
const sideTabs = [...document.querySelectorAll<HTMLButtonElement>(".side-tabs [role=tab]")];
let sidePanel: SidePanel = SIDE_PANELS.find((p) => p === storage.load("side-panel")) ?? "outline";
/** 目前開啟的資料夾（工作區）。 */
let workspaceRoot: Folder | null = null;
/** Ctrl+P 用的工作區檔案清單；資料夾內容變動時清掉重抓。 */
let fileListCache: FileItem[] | null = null;
let treeActive: string | null = null;

const DOWNLOAD_URL = "https://github.com/omni624562/markdown/releases/download/latest/md-editor.exe";

const fileTree = desktop
  ? new FileTree($("#file-tree"), {
      list: (dir) => desktop!.listDir(dir),
      open: (path) => void openPath(path).catch(reportError),
      action: (action, entry) => void treeAction(action, entry).catch(reportError),
    })
  : null;

const gitPanel =
  desktop && fileTree
    ? new GitPanel($("#git-bar"), desktop, settings, fileTree, () => workspaceRoot?.path ?? null)
    : null;

const searchPanel = desktop
  ? new SearchPanel($("#panel-search"), {
      search: (query, caseSensitive, regex) =>
        workspaceRoot
          ? desktop!.search(query, caseSensitive, regex, workspaceRoot.path)
          : Promise.reject(new Error("還沒有開啟資料夾")),
      open: (path, line, column) => void openPath(path, line, column).catch(reportError),
    })
  : null;

function showPanel(panel: SidePanel, reveal = true): void {
  sidePanel = panel;
  storage.save("side-panel", panel);
  for (const tab of sideTabs) {
    const on = tab.dataset.panel === panel;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#panel-${tab.dataset.panel}`).hidden = !on;
  }
  if (reveal && !outlineShown) setOutline(true);
  if (panel === "outline") updateActiveHeading();
}

for (const tab of sideTabs) {
  tab.addEventListener("click", () => showPanel(tab.dataset.panel as SidePanel));
}
$(".side-tabs").addEventListener("keydown", (e) => {
  const i = sideTabs.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0 || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
  e.preventDefault();
  const next = sideTabs[(i + (e.key === "ArrowRight" ? 1 : -1) + sideTabs.length) % sideTabs.length];
  next.focus();
  showPanel(next.dataset.panel as SidePanel);
});

/** 沒有開啟資料夾時，檔案面板顯示說明、開啟按鈕與最近開啟的資料夾。 */
async function renderFilesEmpty(): Promise<void> {
  const box = $("#files-empty");
  $("#files-head").hidden = !workspaceRoot;
  box.hidden = !!workspaceRoot;
  if (workspaceRoot) return;
  const p = document.createElement("p");
  if (!desktop) {
    p.textContent = "開啟資料夾、管理檔案與搜尋整個資料夾需要桌面版（Windows，免安裝）。";
    const a = Object.assign(document.createElement("a"), {
      className: "btn",
      href: DOWNLOAD_URL,
      textContent: "下載桌面版",
    });
    box.replaceChildren(p, a);
    return;
  }
  p.textContent = "開啟一個資料夾，就能在這裡瀏覽、新增、重新命名檔案，也能搜尋整個資料夾的內容。";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "btn";
  open.append(icon("folder-open"), "開啟資料夾");
  open.addEventListener("click", () => void commands.run("open-folder").catch(reportError));
  const remote = document.createElement("button");
  remote.type = "button";
  remote.className = "btn";
  remote.append(icon("cloud"), "連線到 WebDAV");
  remote.addEventListener("click", () => void commands.run("connect-webdav").catch(reportError));
  const actions = document.createElement("div");
  actions.className = "side-actions";
  actions.append(open, remote);
  box.replaceChildren(p, actions);
  const [{ folders }, conns] = await Promise.all([desktop.recent(), desktop.davConnections().catch(() => [])]);
  if ((!folders.length && !conns.length) || workspaceRoot) return;
  const h = document.createElement("h3");
  h.textContent = "最近開啟";
  const list = document.createElement("ul");
  list.className = "recent-list";
  const add = (iconName: string, label: string, title: string, run: () => void, forget?: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = title;
    b.append(icon(iconName), Object.assign(document.createElement("span"), { textContent: label }));
    b.addEventListener("click", run);
    const li = document.createElement("li");
    li.append(b);
    if (forget) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "recent-forget";
      x.title = "從清單移除（也會刪除記住的密碼）";
      x.setAttribute("aria-label", `移除「${label}」`);
      x.append(icon("x"));
      x.addEventListener("click", forget);
      li.append(x);
    }
    list.append(li);
  };
  for (const path of folders) add("folder", basename(path) || path, path, () => void openRecentFolder(path));
  for (const c of conns) {
    add("cloud", c.name, `${c.url}（${c.username}）`, () => void openRemote(c), () =>
      void desktop!.davForget(c.id).then(renderFilesEmpty).catch(reportError),
    );
  }
  box.append(h, list);
}

const davDialog = desktop ? new WebDavDialog(desktop) : null;

/** 原生端在遠端檔案的連線沒有連上時回傳的錯誤開頭。 */
const NOT_CONNECTED = ["還沒有連線到 WebDAV 伺服器", "這個檔案屬於另一個 WebDAV 連線"];

/** 遠端檔案所屬的連線目前沒有連上：提示重新連線（不自動跳出對話框打斷）。 */
async function suggestReconnect(path: string, message: (name: string) => string, label = "重新連線"): Promise<boolean> {
  const id = path.slice("webdav://".length).split("/")[0];
  const c = (await desktop?.davConnections().catch(() => []))?.find((x) => x.id === id);
  if (!c) return false;
  toast(message(c.name), {
    duration: 15000,
    action: { label, run: () => void openRemote(c).catch(reportError) },
  });
  return true;
}

/** 開啟已儲存的 WebDAV 連線；沒有記住密碼時先詢問。 */
async function openRemote(c: Pick<DavConnection, "id" | "url" | "username">): Promise<void> {
  if (!desktop || !davDialog) return;
  let folder: Folder | null;
  try {
    folder = await desktop.reopenFolder(`webdav://${c.id}`);
  } catch (e) {
    if (String(e instanceof Error ? e.message : e) !== "NEED_PASSWORD") throw e;
    folder = await davDialog.open({ passwordOnly: true, url: c.url, username: c.username, id: c.id });
  }
  if (!folder) return;
  await setWorkspace(folder);
  showPanel("files");
  await reloadRemoteDocs(folder.path);
}

async function setWorkspace(folder: Folder | null): Promise<void> {
  workspaceRoot = folder;
  fileListCache = null;
  if (folder) storage.save("workspace", folder.path);
  else storage.remove("workspace");
  const name = $("#folder-name");
  name.textContent = folder?.name ?? "";
  name.title = folder ? displayPath(folder.path) : "";
  await fileTree?.setRoot(folder?.path ?? null, folder?.name);
  treeActive = fileHandle?.path ?? null;
  await fileTree?.setActive(treeActive);
  await renderFilesEmpty();
  void gitPanel?.refresh();
}

async function openRecentFolder(path: string): Promise<void> {
  try {
    await setWorkspace(await desktop!.reopenFolder(path));
    showPanel("files");
  } catch (e) {
    reportError(e);
    await renderFilesEmpty(); // 找不到的資料夾已從清單移除
  }
}

/** 開啟（或切換到）指定路徑的檔案，可再跳到指定的行與欄。 */
async function openPath(path: string, line?: number, column?: number): Promise<void> {
  const existing = tabForPath(path);
  if (existing) activate(existing);
  else if (desktop) openOpenedFile(fromDesktop(await desktop.reopenFile(path)));
  if (line) {
    if (view === "preview") setView("split");
    editor.reveal(line, column);
  }
  if (narrowQuery.matches) setOutline(false);
}

/** 檔案樹右鍵選單與快速鍵的動作。 */
async function treeAction(action: TreeAction, entry: Entry): Promise<void> {
  const d = desktop;
  if (!d || !fileTree) return;
  switch (action) {
    case "new-file":
    case "new-folder": {
      const isDir = action === "new-folder";
      let name = await fileTree.promptName(entry.path, isDir ? "新資料夾" : "未命名.md", isDir ? "folder" : "file");
      if (!name) return;
      if (!isDir && !name.includes(".")) name += ".md";
      const path = await d.createEntry(entry.path, name, isDir);
      fileListCache = null;
      await fileTree.refresh([entry.path]);
      if (!isDir) await openPath(path);
      break;
    }
    case "rename": {
      const parent = dirname(entry.path);
      const name = await fileTree.promptName(parent, entry.name, "rename", entry.path);
      if (!name || name === entry.name) return;
      const to = await d.renameEntry(entry.path, name);
      // 已開啟的分頁（含改名資料夾底下的檔案）改用新路徑。
      stash();
      for (const doc of docs) {
        const moved = doc.path && rebase(doc.path, entry.path, to);
        if (!moved) continue;
        doc.path = moved;
        if (doc.path === to) doc.name = basename(to);
        doc.handle = desktopHandle(moved, basename(moved));
      }
      ({ name: fileName, handle: fileHandle } = active);
      fileNameInput.value = fileName;
      fileListCache = null;
      persistSession();
      renderSaveState();
      renderTabs();
      await fileTree.refresh([parent]);
      break;
    }
    case "trash": {
      stash();
      const affected = docs.filter((doc) => doc.path && isInside(doc.path, entry.path));
      const what = entry.isDir ? `資料夾「${entry.name}」和裡面所有的檔案` : `「${entry.name}」`;
      const note = affected.some((doc) => doc.dirty) ? "已開啟的分頁會保留內容，但有尚未存檔的變更。" : "";
      // WebDAV 沒有資源回收筒：講清楚是永久刪除。
      const remote = isRemote(entry.path);
      const choice = remote
        ? await choose("永久刪除？", `要刪除${what}嗎？遠端（WebDAV）沒有資源回收筒，刪除後無法復原。${note}`, [
            { id: "trash", label: "永久刪除", danger: true },
            { id: "cancel", label: "取消", primary: true },
          ])
        : await choose("移到資源回收筒？", `要把${what}移到資源回收筒嗎？之後可以從資源回收筒還原。${note}`, [
            { id: "trash", label: "移到資源回收筒", danger: true },
            { id: "cancel", label: "取消" },
          ]);
      if (choice !== "trash") return;
      await d.trashEntry(entry.path);
      for (const doc of affected) doc.missing = true;
      fileListCache = null;
      renderTabs();
      await fileTree.refresh([dirname(entry.path)]);
      toast(remote ? `已刪除「${entry.name}」` : `已把「${entry.name}」移到資源回收筒`);
      break;
    }
    case "reveal":
      await d.revealEntry(entry.path);
      break;
    case "copy-path":
      await navigator.clipboard.writeText(entry.path);
      toast("已複製路徑");
      break;
  }
}

function rootEntry(): Entry | null {
  return workspaceRoot && { path: workspaceRoot.path, name: workspaceRoot.name, isDir: true };
}
$("#tree-new-file").addEventListener("click", () => {
  const root = rootEntry();
  if (root) void treeAction("new-file", root).catch(reportError);
});
$("#tree-new-folder").addEventListener("click", () => {
  const root = rootEntry();
  if (root) void treeAction("new-folder", root).catch(reportError);
});
$("#tree-refresh").addEventListener("click", () => {
  fileListCache = null;
  void fileTree?.refresh().catch(reportError);
});
if (!desktop) {
  const p = document.createElement("p");
  p.className = "side-empty";
  p.textContent = "搜尋整個資料夾的內容需要桌面版。要搜尋目前的文件，請按 ";
  p.append(Object.assign(document.createElement("kbd"), { textContent: formatKeys("Mod-f") }), "。");
  $("#panel-search").append(p);
}

// ---- 快速開啟（Ctrl+P） --------------------------------------------------

interface QuickItem {
  title: string;
  detail: string;
  doc?: Doc;
  path?: string;
}

const quickOpen = new Picker<QuickItem>({
  label: "快速開啟",
  placeholder: desktop ? "輸入檔名，例如「週報」" : "輸入檔名切換分頁",
  empty: "找不到符合的檔案",
  async query(q) {
    stash();
    // 已開啟的分頁優先，目前分頁放最後（按 Enter 不會停在原地）。
    const items: QuickItem[] = [...docs.filter((d) => d !== active), active].map((d) => ({
      title: d.name,
      detail: d === active ? "目前分頁" : "已開啟",
      doc: d,
    }));
    const seen = new Set(docs.map((d) => d.path).filter(Boolean));
    if (desktop) {
      if (workspaceRoot) {
        fileListCache ??= await desktop.listFiles(workspaceRoot.path).catch(() => []);
        for (const f of fileListCache) {
          if (seen.has(f.path)) continue;
          seen.add(f.path);
          const dir = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
          items.push({ title: basename(f.path), detail: dir || workspaceRoot.name, path: f.path });
        }
      }
      const { files } = await desktop.recent().catch(() => ({ files: [] as string[] }));
      for (const path of files) {
        if (seen.has(path)) continue;
        seen.add(path);
        items.push({ title: basename(path), detail: `最近開啟 · ${displayPath(dirname(path))}`, path });
      }
    }
    if (!q.trim()) return items.slice(0, 200);
    return items
      .map((it) => ({ it, score: Math.max(fuzzyScore(q, it.title) * 2, fuzzyScore(q, `${it.detail}/${it.title}`)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 200)
      .map((x) => x.it);
  },
  render: (it) => ({ title: it.title, detail: it.detail, icon: it.doc ? "file-text" : "file" }),
  pick: (it) => (it.doc ? activate(it.doc) : void openPath(it.path!).catch(reportError)),
});

/** 把全域變數（目前分頁）寫回分頁物件。 */
function stash(): void {
  Object.assign(active, {
    kind,
    name: fileName,
    handle: fileHandle,
    path: fileHandle?.path ?? null,
    baseline,
    fileBacked,
    state: editor.state,
    scrollTop: editor.view.scrollDOM.scrollTop,
    dirty: baseline !== hash(editor.text),
  });
}

function persistSession(): void {
  stash();
  saveSession({
    activeId: active.id,
    docs: docs.map(({ id, name, kind, path, baseline, fileBacked }) => ({ id, name, kind, path, baseline, fileBacked })),
  });
}

function renderTabs(): void {
  tabBar.render(
    docs.map((d) => ({
      id: d.id,
      name: d === active ? fileName : d.name,
      title: ((p) => (p ? displayPath(p) : null))(d === active ? fileHandle?.path : d.path) ?? (d === active ? fileName : d.name),
      dirty: d.dirty,
      missing: d.missing,
    })),
    active.id,
  );
  const path = fileHandle?.path ?? null;
  if (path !== treeActive) {
    treeActive = path;
    void fileTree?.setActive(path);
  }
}

/** 切換到另一個分頁。 */
function activate(doc: Doc): void {
  if (doc === active) return;
  flushDraft();
  if (review.active) review.finish();
  if (docs.includes(active)) stash();
  active = doc;
  ({ kind, name: fileName, handle: fileHandle, baseline, fileBacked } = doc);
  kindSelect.value = kind;
  fileNameInput.value = fileName;
  if (doc.state) editor.restore(doc.state, kind, doc.scrollTop);
  else editor.load(loadDraft(doc.id) ?? "", kind);
  editorTopLine = 1;
  preview.clear();
  previewScroller.scrollTop = 0;
  buildFormatBar();
  persistSession();
  renderNow();
  renderTabs();
  renderOffline();
  if (doc.externalOriginal !== undefined) {
    const original = doc.externalOriginal;
    doc.externalOriginal = undefined;
    showExternalChanges(original, editor.text);
  }
  ai?.scheduleSync();
}

/** 新增一個分頁並切換過去（不會寫入內容，呼叫端負責）。 */
function addTab(doc: Doc): void {
  const i = docs.indexOf(active);
  docs.splice(i + 1, 0, doc);
  activate(doc);
}

async function closeTab(id: string): Promise<void> {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  if (doc === active) stash();
  if (doc.dirty) {
    const choice = await choose("要儲存變更嗎？", `「${doc.name}」有尚未存檔的變更。`, [
      { id: "save", label: "儲存", primary: true },
      { id: "discard", label: "不儲存", danger: true },
      { id: "cancel", label: "取消" },
    ]);
    if (choice === "save") {
      activate(doc);
      await save(false);
      if (active.dirty || baseline !== hash(editor.text)) return; // 取消存檔或存檔失敗
    } else if (choice !== "discard") {
      return;
    }
  }
  if (pendingDraft?.id === doc.id) pendingDraft = null;
  const i = docs.indexOf(doc);
  docs.splice(i, 1);
  dropDraft(doc.id);
  if (!docs.length) {
    const blank = makeDoc({ name: `未命名${KINDS[kind].ext}`, kind });
    docs.push(blank);
  }
  if (doc === active) {
    const next = docs[Math.min(i, docs.length - 1)];
    active = doc; // 讓 activate 知道要換掉的是這個分頁
    activate(next);
  } else {
    persistSession();
    renderTabs();
  }
}

function cycleTab(step: number): void {
  const i = docs.indexOf(active);
  activate(docs[(i + step + docs.length) % docs.length]);
}

/** 找出已經開啟同一個檔案的分頁。 */
function tabForPath(path: string): Doc | undefined {
  return docs.find((d) => (d === active ? fileHandle?.path : d.path) === path);
}

function openDocument(
  name: string,
  text: string,
  handle: FileHandle | null,
  { kind: docKind, fromFile = true }: { kind?: DocKind; fromFile?: boolean } = {},
): void {
  const path = handle?.path;
  const existing = path ? tabForPath(path) : undefined;
  if (existing) {
    activate(existing);
    return;
  }
  // 目前分頁是空白、未存成檔案的新文件時直接沿用，否則開新分頁。
  if (fileBacked || editor.text !== "") addTab(makeDoc({ name, kind: docKind ?? kindFromFileName(name) }));
  if (review.active) review.finish();
  fileHandle = handle;
  kind = docKind ?? kindFromFileName(name);
  kindSelect.value = kind;
  fileName = name;
  fileNameInput.value = name;
  editor.load(text, kind);
  editorTopLine = 1;
  previewScroller.scrollTop = 0;
  saveDraft(active.id, text);
  active.missing = false;
  setBaseline(text, fromFile);
  preview.clear();
  buildFormatBar();
  renderNow();
  renderTabs();
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
  let out: Awaited<ReturnType<typeof saveFile>>;
  try {
    out = await saveFile(text, fileName, kind, fileHandle, { saveAs, force });
  } catch (e) {
    if (isOffline(e) && fileHandle?.path) {
      showOffline(fileHandle.path);
      return;
    }
    const path = fileHandle?.path;
    const message = e instanceof Error ? e.message : String(e);
    if (isRemote(path) && NOT_CONNECTED.some((m) => message.startsWith(m))) {
      if (await suggestReconnect(path, (name) => `還沒有連線到「${name}」，重新連線後再存檔。`)) return;
    }
    throw e;
  }
  if (!out) return;
  if (out.status === "conflict") {
    await resolveConflict(out.name, out.diskText);
    return;
  }
  fileHandle = out.handle;
  active.missing = false;
  if (offline && offline.path === fileHandle?.path) clearOffline();
  gitPanel?.refreshSoon(300);
  setBaseline(text, true);
  setFileName(out.name);
  toast(out.handle ? `已儲存到「${out.name}」` : `已下載「${out.name}」`, { tone: "success" });
}

// ---- 網路磁碟斷線（R1） --------------------------------------------------------

/** 原生端回報網路錯誤時，訊息以這段文字開頭。 */
const OFFLINE = "網路磁碟無法連線";
const offlineBar = $("#offline-bar");
let offline: { path: string; timer: number; back: boolean } | null = null;

function isOffline(e: unknown): boolean {
  return (e instanceof Error ? e.message : String(e)).startsWith(OFFLINE);
}

/** 存檔時網路磁碟無法連線：保留內容，每 10 秒檢查一次，恢復後提醒存檔。 */
function showOffline(path: string): void {
  if (offline?.path !== path) {
    clearOffline();
    offline = { path, back: false, timer: window.setInterval(() => void probeOffline(), 10_000) };
  } else {
    offline.back = false;
  }
  renderOffline();
}

async function probeOffline(): Promise<void> {
  if (!offline || offline.back || !desktop) return;
  const reachable = await desktop.probePath(offline.path).catch(() => false);
  if (!reachable || !offline) return;
  offline.back = true;
  clearInterval(offline.timer);
  renderOffline();
  if (fileHandle?.path !== offline.path) {
    toast(`${isRemote(offline.path) ? "WebDAV 伺服器" : "網路磁碟"}已恢復連線，記得回到那份文件存檔。`);
  }
}

function clearOffline(): void {
  if (offline) clearInterval(offline.timer);
  offline = null;
  renderOffline();
}

function renderOffline(): void {
  const show = !!offline && fileHandle?.path === offline.path;
  offlineBar.hidden = !show;
  if (!show || !offline) return;
  offlineBar.classList.toggle("back", offline.back);
  const where = isRemote(offline.path) ? "WebDAV 伺服器" : "網路磁碟";
  const msg = document.createElement("p");
  msg.append(icon(offline.back ? "refresh-cw" : "circle-alert"));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  if (offline.back) {
    msg.append(`${where}已恢復連線。`);
    button.textContent = "立即存檔";
    button.addEventListener("click", () => void save(false).catch(reportError));
  } else {
    msg.append(
      Object.assign(document.createElement("strong"), { textContent: `${where}無法連線` }),
      Object.assign(document.createElement("span"), {
        textContent: "這次沒有存到檔案。內容會保留在編輯器裡（草稿也已自動保存），連線恢復後會提醒你。",
      }),
    );
    button.textContent = "重試存檔";
    button.addEventListener("click", () => void save(false).catch(reportError));
  }
  offlineBar.replaceChildren(msg, button);
}

/** 提示文字用：遠端檔案存在「伺服器」，本機檔案存在「磁碟」。 */
function storeName(path = fileHandle?.path): string {
  return isRemote(path) ? "伺服器" : "磁碟";
}

/** 提示文字用：誰會在背後改檔案。 */
function otherWriter(path = fileHandle?.path): string {
  return isRemote(path) ? "其他電腦或程式" : "其他程式";
}

/** 檔案在開啟後被別的程式改過：讓使用者比較差異、覆蓋或另存。 */
async function resolveConflict(name: string, diskText: string): Promise<void> {
  const remote = isRemote(fileHandle?.path);
  const choice = await choose(
    `檔案已被${otherWriter()}修改`,
    remote
      ? `「${name}」在你開啟之後被其他電腦或程式改過。要怎麼處理？`
      : `「${name}」在你開啟之後被其他程式（例如同步軟體或另一個編輯器）改過。要怎麼處理？`,
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
      title: `與${storeName()}上的版本比較`,
      hint: "逐段選擇要採用哪個版本，全部處理完會自動存檔。",
      acceptLabel: `採用${storeName()}版本`,
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
    keys: "Mod-Alt-n",
    run() {
      const doc = makeDoc({ name: `未命名${KINDS[kind].ext}`, kind });
      saveDraft(doc.id, "");
      addTab(doc);
      editor.view.focus();
    },
  },
  { id: "tab-next", title: "下一個分頁", group: "檢視", keys: "Ctrl-Tab", when: () => docs.length > 1, run: () => cycleTab(1) },
  {
    id: "tab-prev",
    title: "上一個分頁",
    group: "檢視",
    keys: "Ctrl-Shift-Tab",
    when: () => docs.length > 1,
    run: () => cycleTab(-1),
  },
  { id: "tab-close", title: "關閉分頁", group: "檔案", icon: "x", keys: "Mod-w", run: () => closeTab(active.id) },
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
  {
    id: "open-folder",
    title: "開啟資料夾…",
    group: "檔案",
    icon: "folder-open",
    when: () => !!desktop,
    async run() {
      const folder = await desktop?.openFolder();
      if (!folder) return;
      await setWorkspace(folder);
      showPanel("files");
    },
  },
  {
    id: "connect-webdav",
    title: "連線到 WebDAV 遠端資料夾…",
    group: "檔案",
    icon: "cloud",
    when: () => !!desktop,
    async run() {
      const folder = await davDialog?.open();
      if (!folder) return;
      await setWorkspace(folder);
      showPanel("files");
    },
  },
  {
    id: "quick-open",
    title: "快速開啟檔案…",
    group: "檔案",
    icon: "search",
    keys: "Mod-p",
    run: () => quickOpen.open(),
  },
  {
    id: "search-in-folder",
    title: "在資料夾中搜尋",
    group: "編輯",
    icon: "search",
    keys: "Mod-Shift-f",
    when: () => !!desktop,
    run() {
      showPanel("search");
      // 選取範圍只有一行時，直接拿來當搜尋關鍵字。
      const { from, to } = editor.view.state.selection.main;
      const selected = editor.view.state.sliceDoc(from, to);
      searchPanel?.focus(selected && !selected.includes("\n") ? selected : undefined);
    },
  },
  { id: "show-files", title: "顯示檔案", group: "檢視", icon: "folder", keys: "Mod-Shift-e", run: () => showPanel("files") },
  { id: "show-outline", title: "顯示大綱", group: "檢視", icon: "list-tree", run: () => showPanel("outline") },
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
    id: "export-pdf",
    title: "列印／匯出 PDF…",
    group: "檔案",
    icon: "printer",
    run: () => printDocument(),
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
    id: "tidy-spacing",
    title: "整理文件：在中文與英文、數字之間加空格",
    group: "編輯",
    icon: "wand-sparkles",
    when: () => kind !== "json" && view !== "preview",
    run() {
      const text = editor.text;
      const positions = spacingPositions(text, kind);
      if (!positions.length) {
        toast("沒有需要加空格的地方。");
        return;
      }
      // 原本對齊的表格補完空格後重新對齊；整個過程是一次可復原的編輯。
      const realign = kind === "markdown" && formatAllTables(text) === text;
      let spaced = "";
      let last = 0;
      for (const p of positions) {
        spaced += `${text.slice(last, p)} `;
        last = p;
      }
      spaced += text.slice(last);
      const result = realign ? formatAllTables(spaced) : spaced;
      if (result === spaced) {
        editor.view.dispatch({
          changes: [...positions].map((from) => ({ from, insert: " " })),
          userEvent: "input.format",
        });
      } else {
        editor.replaceAll(result);
      }
      toast(`已補上 ${positions.length} 個空格（可用 Ctrl+Z 復原）`, { tone: "success" });
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
    id: "toggle-focus-mode",
    title: "專注模式（淡化其他段落）",
    group: "檢視",
    icon: "focus",
    when: () => view !== "preview",
    run: () => toggleSetting("focusMode", "專注模式"),
  },
  {
    id: "toggle-typewriter-mode",
    title: "打字機模式（游標保持在畫面中央）",
    group: "檢視",
    icon: "text-cursor",
    when: () => view !== "preview",
    run: () => toggleSetting("typewriterMode", "打字機模式"),
  },
  {
    id: "font-bigger",
    title: "放大編輯區文字",
    group: "檢視",
    icon: "a-arrow-up",
    keys: "Mod-Equal",
    run: () => changeFontSize(1),
  },
  {
    id: "font-smaller",
    title: "縮小編輯區文字",
    group: "檢視",
    icon: "a-arrow-down",
    keys: "Mod-Minus",
    run: () => changeFontSize(-1),
  },
  {
    id: "font-reset",
    title: "編輯區文字恢復預設大小",
    group: "檢視",
    icon: "text-cursor",
    keys: "Mod-0",
    run: () => settings.update({ editorFontSize: DEFAULT_SETTINGS.editorFontSize }),
  },
  {
    id: "toggle-outline",
    title: "顯示／隱藏側邊欄",
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
const TERMINAL_KEYS = new Set(["palette", "toggle-terminal"]);

// ---- AI 協作與終端機（桌面版） ------------------------------------------------

if (desktop) {
  terminal = new TerminalPanel($("#terminal-panel"), desktop, () => editor.view.requestMeasure());
  ai = new AiController(
    desktop,
    settings,
    {
      editor,
      review,
      snapshot: editorSnapshot,
      async showDocument(path) {
        if (path && path !== fileHandle?.path) await openPath(path);
      },
    },
    $("#ai-bar"),
  );
  void refreshAiTools();
  $("[data-command='toggle-terminal']").hidden = false;
  updater = new Updater(desktop, settings, $("#status-update"), () => {
    flushDraft();
    persistSession();
  });
  settings.subscribe((_, changed) => {
    if (changed.includes("aiEnabled")) void refreshAiTools();
  });
}

/** 終端機只在開啟 AI 時顯示已安裝的 Claude Code／Codex 按鈕。 */
async function refreshAiTools(): Promise<void> {
  if (!desktop || !terminal) return;
  const none = { claude: null, codex: null };
  terminal.setAvailable(settings.value.aiEnabled ? await desktop.aiTools().catch(() => none) : none);
}

function editorSnapshot(): EditorSnapshot {
  stash();
  const { from, to } = editor.view.state.selection.main;
  const doc = editor.view.state.doc;
  return {
    active: {
      path: fileHandle?.path ?? null,
      name: fileName,
      text: editor.text,
      dirty: active.dirty,
      selection:
        from === to
          ? null
          : { text: doc.sliceString(from, to), fromLine: doc.lineAt(from).number, toLine: doc.lineAt(to).number },
    },
    open: docs.map((d) => ({ path: d.path, name: d.name, dirty: d.dirty })),
  };
}

const aiPicker = new Picker<QuickAction & { custom?: boolean }>({
  label: "AI 快捷動作",
  placeholder: "選擇動作，或直接輸入要 AI 怎麼處理選取的文字",
  empty: "沒有符合的動作；按 Enter 會把輸入的文字當成指示",
  query(q) {
    const actions = settings.value.quickActions
      .map((a) => ({ a, score: fuzzyScore(q, a.name) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .map((x) => x.a);
    const text = q.trim();
    return text && !actions.some((a) => a.name === text)
      ? [...actions, { name: `自訂：${text}`, prompt: text, custom: true }]
      : actions;
  },
  render: (a) => ({ title: a.name, detail: a.custom ? "自訂指示" : undefined, icon: "sparkles" }),
  pick: (a) => void ai?.runAction(a).catch(reportError),
});

const aiMenu = document.createElement("div");
aiMenu.className = "menu";
aiMenu.popover = "auto";
aiMenu.role = "menu";
document.body.append(aiMenu);
aiMenu.addEventListener("keydown", (e) => {
  const items = [...aiMenu.querySelectorAll<HTMLElement>("button")];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
  else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
  else return;
  e.preventDefault();
});

/** 選取文字時的右鍵選單：剪下、複製，以及 AI 快捷動作。 */
function showAiMenu(x: number, y: number): void {
  const item = (label: string, iconName: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "menuitem";
    b.append(icon(iconName), Object.assign(document.createElement("span"), { textContent: label }));
    b.addEventListener("click", () => {
      aiMenu.hidePopover();
      run();
    });
    return b;
  };
  const selected = () => {
    const { from, to } = editor.view.state.selection.main;
    return { from, to, text: editor.view.state.sliceDoc(from, to) };
  };
  const sep = () => Object.assign(document.createElement("div"), { className: "menu-sep" });
  aiMenu.replaceChildren(
    item("剪下", "copy", () => {
      const { from, to, text } = selected();
      void navigator.clipboard.writeText(text);
      editor.view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
      editor.view.focus();
    }),
    item("複製", "copy", () => void navigator.clipboard.writeText(selected().text)),
    sep(),
    ...settings.value.quickActions.map((a) => item(a.name, "sparkles", () => void ai?.runAction(a).catch(reportError))),
    item("自訂指示…", "wand-sparkles", () => aiPicker.open()),
  );
  const show = () => {
    aiMenu.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
    aiMenu.style.top = `${Math.min(y, window.innerHeight - aiMenu.childElementCount * 34 - 16)}px`;
    aiMenu.style.right = "auto";
    aiMenu.showPopover();
    aiMenu.querySelector<HTMLElement>("button")?.focus();
  };
  // Linux 按下右鍵就觸發 contextmenu，等放開後再顯示，以免被當成點在選單外而立刻關閉。
  setTimeout(show);
}

// ---- 最近開啟（W8） ------------------------------------------------------------

const RECENT_LIMITS = { files: 10, folders: 5 } as const;

const recentPicker = new Picker<{ path: string; folder: boolean }>({
  label: "最近開啟",
  placeholder: "輸入檔名或資料夾名稱",
  empty: "還沒有最近開啟的檔案或資料夾。",
  async query(q) {
    if (!desktop) return [];
    const { files, folders } = await desktop.recent();
    const items = [
      ...files.slice(0, RECENT_LIMITS.files).map((path) => ({ path, folder: false })),
      ...folders.slice(0, RECENT_LIMITS.folders).map((path) => ({ path, folder: true })),
    ];
    const needle = q.trim().toLowerCase();
    return needle ? items.filter((i) => i.path.toLowerCase().includes(needle)) : items;
  },
  render: (i) => ({
    title: basename(i.path) || i.path,
    detail: `${i.folder ? "資料夾 · " : ""}${displayPath(dirname(i.path))}`,
    icon: i.folder ? "folder" : "file-text",
  }),
  pick: (i) => void (i.folder ? openRecentFolder(i.path) : openPath(i.path)).catch(reportError),
});

// ---- 本機版本記錄（E12） ------------------------------------------------------

const historyPicker = new Picker<FileVersion & { path: string }>({
  label: "版本記錄",
  placeholder: "選擇一個版本，和目前的內容比較",
  empty: "這個檔案還沒有版本記錄。存檔時會自動保存。",
  async query(q) {
    const path = fileHandle?.path;
    if (!desktop || !path) return [];
    const versions = await desktop.historyList(path);
    return versions
      .map((v) => ({ ...v, path }))
      .filter((v) => !q.trim() || versionTitle(v.id).includes(q.trim()));
  },
  render: (v) => ({
    title: versionTitle(v.id),
    detail: `${v.kind === "disk" ? `存檔前${storeName(v.path)}上的內容 · ` : ""}${sizeLabel(v.size)}`,
    icon: "history",
  }),
  pick: (v) => void compareWithVersion(v).catch(reportError),
});

async function compareWithVersion(v: FileVersion & { path: string }): Promise<void> {
  if (!desktop || fileHandle?.path !== v.path) return;
  const text = await desktop.historyRead(v.path, v.id);
  if (review.active) review.finish();
  const started = review.start(text, {
    title: `與 ${versionTitle(v.id)} 的版本比較`,
    hint: "「採用舊版」會把那一段換回舊版的內容，可以用 Ctrl+Z 復原；處理完記得存檔",
    acceptLabel: "採用舊版",
    rejectLabel: "保留目前",
  });
  if (!started) toast("這個版本和目前的內容相同。");
}

/** 外部修改後，以修改前的版本為基準逐段標示（A4）。沒有差異時回傳 false。 */
function showExternalChanges(original: string, current: string): boolean {
  return review.start(current, {
    original,
    source: "external",
    title: `「${fileName}」被外部程式修改了`,
    hint: "逐段檢查改了哪裡；選「還原」後記得存檔",
    acceptLabel: "保留",
    rejectLabel: "還原",
  });
}

commands.register(
  {
    id: "toggle-terminal",
    title: "顯示／隱藏終端機",
    group: "檢視",
    icon: "square-terminal",
    keys: "Mod-`",
    when: () => !!terminal,
    run: () => terminal?.toggle(),
  },
  {
    id: "ai-actions",
    title: "AI：處理選取的文字…",
    group: "編輯",
    icon: "sparkles",
    keys: "Mod-j",
    when: () => !!ai?.enabled && view !== "preview",
    run() {
      const { from, to } = editor.view.state.selection.main;
      if (from === to) toast("請先選取要處理的文字。");
      else aiPicker.open();
    },
  },
  ...(
    [
      ["git-commit", "Git：提交變更…", "git-commit-horizontal", () => gitPanel?.openCommit()],
      ["git-pull", "Git：拉取", "arrow-down-to-line", () => gitPanel?.pull()],
      ["git-push", "Git：推送", "arrow-up-from-line", () => gitPanel?.push()],
    ] as const
  ).map(
    ([id, title, iconName, run]): Command => ({
      id,
      title,
      group: "檔案",
      icon: iconName,
      when: () => !!gitPanel?.status?.repo,
      run: () => void run(),
    }),
  ),
  {
    id: "open-recent",
    title: "最近開啟…",
    group: "檔案",
    icon: "clock",
    when: () => !!desktop,
    run: () => recentPicker.open(),
  },
  {
    id: "history",
    title: "版本記錄…",
    group: "檔案",
    icon: "history",
    when: () => !!desktop && !!fileHandle?.path,
    run: () => historyPicker.open(),
  },
  {
    id: "check-update",
    title: "檢查更新",
    group: "說明",
    icon: "refresh-cw",
    when: () => !!updater,
    run: () => updater?.check(),
  },
  {
    id: "ai-cancel",
    title: "AI：取消處理中的動作",
    group: "編輯",
    icon: "circle-stop",
    when: () => !!ai?.running,
    run: () => ai?.cancel(),
  },
  ...(["claude", "codex"] as const).map(
    (tool): Command => ({
      id: `start-${tool}`,
      title: `AI：在終端機啟動 ${tool === "claude" ? "Claude Code" : "Codex"}`,
      group: "檢視",
      icon: "sparkles",
      when: () => !!terminal && !!ai?.enabled,
      run: () => terminal?.start(tool),
    }),
  ),
);

// 全域快速鍵：在捕獲階段處理，確保焦點在任何地方都一致。
window.addEventListener(
  "keydown",
  (e) => {
    if (e.isComposing || document.querySelector("dialog[open]")) return;
    const cmd = commands.match(e);
    if (!cmd) return;
    const target = e.target as HTMLElement;
    // 終端機裡的按鍵大多要交給終端機（例如 Ctrl+W、Ctrl+P），只保留少數全域快速鍵。
    if (target.closest(".terminal-panel") && !TERMINAL_KEYS.has(cmd.id)) return;
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
  "open-folder",
  "connect-webdav",
  "quick-open",
  "open-recent",
  "-",
  "save",
  "save-as",
  "history",
  "-",
  "export-html",
  "export-pdf",
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
  terminal?.applyTheme();
}

// 跟隨系統時，系統切換深淺色也要重畫流程圖。
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (themePref === "system") terminal?.applyTheme();
  if (themePref === "system" && settings.value.mermaid) scheduleRender();
});

// ---- 設定 ---------------------------------------------------------------

const PREVIEW_WIDTH: Record<Settings["previewWidth"], string> = { narrow: "680px", medium: "820px", wide: "1080px" };

function toggleSetting(key: "focusMode" | "typewriterMode", label: string): void {
  const on = !settings.value[key];
  settings.update({ [key]: on });
  toast(`${label}已${on ? "開啟" : "關閉"}`);
  editor.view.focus();
}

function changeFontSize(delta: number): void {
  const size = Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, settings.value.editorFontSize + delta));
  if (size === settings.value.editorFontSize) {
    toast(delta > 0 ? `已經是最大的字級（${size}px）` : `已經是最小的字級（${size}px）`);
    return;
  }
  settings.update({ editorFontSize: size });
}

function applySettings(s: Readonly<Settings>, changed?: (keyof Settings)[]): void {
  const root = document.documentElement.style;
  root.setProperty("--editor-font-size", `${s.editorFontSize}px`);
  root.setProperty("--preview-width", PREVIEW_WIDTH[s.previewWidth]);
  if (!changed) return;
  const editorKeys: (keyof Settings)[] = ["lineNumbers", "autoPairBrackets", "focusMode", "typewriterMode"];
  if (changed.some((k) => editorKeys.includes(k))) {
    editor.configure({
      lineNumbers: s.lineNumbers,
      autoPairBrackets: s.autoPairBrackets,
      focusMode: s.focusMode,
      typewriterMode: s.typewriterMode,
    });
  }
  if (changed.includes("editorFontSize")) editor.view.requestMeasure();
  if (changed.includes("math") || changed.includes("mermaid")) {
    preview.clear();
    renderNow();
  }
}

settings.subscribe(applySettings);
const settingsDialog = new SettingsDialog(
  settings,
  { get: () => themePref, set: setTheme },
  desktop && ai ? { available: () => desktop!.aiTools(), registration: () => ai!.registration() } : null,
  updater
    ? { version: async () => versionLabel(await updater!.version()), check: () => void updater!.check() }
    : null,
);

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

// ---- 貼上、拖曳圖片 -------------------------------------------------------

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};
/** 網頁版內嵌圖片（data: 網址）的大小上限，太大會讓文件難以編輯。 */
const EMBED_LIMIT = 2 * 1024 * 1024;

function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((f) => f.type in IMAGE_EXT);
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 圖片的替代文字：用檔名，但截圖工具產生的「image.png」之類的名稱沒有意義就留白。 */
function altText(name: string): string {
  const s = stem(name);
  return /^(image|img|clipboard|screenshot|untitled)[-_ ]?\d*$/i.test(s) ? "" : s.replace(/[[\]]/g, "");
}

function insertAtCursor(text: string): void {
  const { from, to } = editor.view.state.selection.main;
  editor.view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  editor.view.focus();
}

/**
 * 插入圖片。桌面版把圖片存到文件旁邊的 assets 資料夾並插入相對路徑；
 * 網頁版無法寫入檔案，詢問後改用內嵌的 data: 網址。
 */
async function insertImages(files: File[]): Promise<void> {
  if (kind !== "markdown") {
    toast("只有 Markdown 文件可以插入圖片。");
    return;
  }
  if (!desktop) {
    if (files.reduce((n, f) => n + f.size, 0) > EMBED_LIMIT) {
      toast("圖片超過 2 MB，網頁版無法內嵌。桌面版會把圖片另存成檔案，沒有這個限制。", { tone: "error", duration: 8000 });
      return;
    }
    toast("網頁版無法把圖片另存成檔案。要直接內嵌在文件裡嗎？（文件會變大）", {
      duration: 10000,
      action: {
        label: "內嵌圖片",
        run: () =>
          void Promise.all(files.map(readDataUrl))
            .then((urls) => insertAtCursor(urls.map((url, i) => `![${altText(files[i].name)}](${url})`).join("\n")))
            .catch(reportError),
      },
    });
    return;
  }
  const docPath = fileHandle?.path;
  if (!docPath) {
    toast("請先存檔：圖片會存到文件所在資料夾的 assets 資料夾裡。", {
      duration: 8000,
      action: {
        label: "儲存",
        run: () =>
          void save(false)
            .then(() => (fileHandle?.path ? insertImages(files) : undefined))
            .catch(reportError),
      },
    });
    return;
  }
  const doc = active;
  const links: string[] = [];
  for (const file of files) {
    const data = (await readDataUrl(file)).split(",")[1];
    const rel = await desktop.saveImage(docPath, data, IMAGE_EXT[file.type]);
    links.push(`![${altText(file.name)}](${markdownUrl(rel)})`);
  }
  if (active !== doc) return; // 存圖片時使用者切換了分頁
  insertAtCursor(links.join("\n"));
  toast(files.length > 1 ? `已把 ${files.length} 張圖片存到 assets 資料夾` : "已把圖片存到 assets 資料夾", {
    tone: "success",
  });
}

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
  const files = [...(e.dataTransfer?.files ?? [])];
  const images = imageFiles(e.dataTransfer?.files);
  if (images.length && images.length === files.length) {
    await insertImages(images).catch(reportError);
    return;
  }
  const file = files.find((f) => !images.includes(f));
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
kindSelect.value = kind;
fileNameInput.value = fileName;
setTheme(themePref);
applySettings(settings.value);
if (settingsRecovered) toast("設定檔有無法讀取的內容，相關選項已恢復成預設值。", { tone: "error", duration: 8000 });
buildFormatBar();
showPanel(sidePanel, false);
void renderFilesEmpty();
// 手機上大綱是蓋在內容上的抽屜，一開始先收起來。
if (narrowQuery.matches) outlineShown = false;
applyLayout();
renderNow();
renderTabs();
persistSession();
updateCursor(editor.view);

if (desktop) void startDesktop(desktop).catch(reportError);

/**
 * 桌面版啟動：開始監看檔案變動、還原工作區、重新讀取分頁對應的檔案，
 * 最後處理命令列帶入的檔案或資料夾。
 */
async function startDesktop(d: NonNullable<typeof desktop>): Promise<void> {
  await Promise.all([
    d.onFileChanged(({ path }) => void onExternalChange(path).catch(reportError)),
    d.onFileRemoved(({ path }) => {
      const doc = tabForPath(path);
      if (!doc || doc.missing) return;
      doc.missing = true;
      renderTabs();
      toast(`「${doc.name}」已從磁碟刪除或移走。內容仍保留在分頁中，存檔會重新建立檔案。`, { duration: 8000 });
    }),
    d.onTreeChanged(({ dirs }) => {
      fileListCache = null;
      void fileTree?.refresh(dirs).then(() => gitPanel?.refreshSoon());
      searchPanel?.rerun();
    }),
    d.onOpenTarget((t) => {
      if (t.kind === "file") openOpenedFile(fromDesktop(t));
      else void setWorkspace(t).then(() => showPanel("files")).catch(reportError);
    }),
    d.onOpenTargetFailed((message) => reportError(new Error(message))),
  ]);

  const target = await d.startupTarget();
  if (target?.kind === "folder") {
    await setWorkspace(target);
    showPanel("files");
  } else {
    const last = storage.load("workspace");
    let needPassword = false;
    const folder = last
      ? await d.reopenFolder(last).catch((e) => {
          // 遠端連線沒有記住密碼：提示使用者輸入，不自動跳出對話框打斷。
          if (isRemote(last) && String(e instanceof Error ? e.message : e) === "NEED_PASSWORD") {
            needPassword = true;
            void suggestReconnect(last, (name) => `要重新連線到「${name}」，需要輸入密碼。`, "輸入密碼");
          }
          return null;
        })
      : null;
    await setWorkspace(folder);
    // 還沒輸入密碼不代表不用這個資料夾了：下次啟動仍然提示。
    if (needPassword && last) storage.save("workspace", last);
  }

  for (const doc of docs) {
    const path = docPath(doc);
    if (!path) continue;
    try {
      await reloadDoc(doc, path);
    } catch {
      // 遠端檔案讀不到多半是還沒重新連線，不代表檔案不見了；連線後會再讀一次。
      if (!isRemote(path)) doc.missing = true;
    }
  }
  persistSession();
  renderTabs();
  // 有了檔案路徑，預覽中的相對路徑圖片才能顯示。
  preview.clear();
  renderNow();

  if (target?.kind === "file") openOpenedFile(fromDesktop(target));
}

function docPath(doc: Doc): string | null {
  return doc === active ? (fileHandle?.path ?? doc.path) : doc.path;
}

/**
 * 重新讀取分頁的檔案（啟動時、重新連線到 WebDAV 後）：沒有未存檔的變更就直接採用最新內容，
 * 有的話提示比較差異。
 */
async function reloadDoc(doc: Doc, path: string): Promise<void> {
  const file = fromDesktop(await desktop!.reopenFile(path));
  const draft = doc === active ? editor.text : (loadDraft(doc.id) ?? "");
  const clean = hash(draft) === doc.baseline;
  if (doc === active) fileHandle = file.handle;
  doc.handle = file.handle;
  doc.missing = false;
  if (clean && file.text !== draft) {
    saveDraft(doc.id, file.text);
    doc.baseline = hash(file.text);
    doc.state = null;
    if (doc === active) {
      editor.load(file.text, kind);
      baseline = doc.baseline;
      renderNow();
    }
  } else if (!clean && hash(file.text) !== doc.baseline) {
    toast(`「${doc.name}」在上次關閉後被${otherWriter(path)}修改過，你也有未存檔的變更。`, {
      duration: 12000,
      action: { label: "比較差異", run: () => void compareDoc(doc).catch(reportError) },
    });
  }
}

/** 重新連線到 WebDAV 後，重新讀取屬於這個連線的分頁（圖片也重新載入）。 */
async function reloadRemoteDocs(root: string): Promise<void> {
  for (const doc of docs) {
    const path = docPath(doc);
    if (!path?.startsWith(`${root}/`)) continue;
    await reloadDoc(doc, path).catch(() => {});
  }
  persistSession();
  renderTabs();
  preview.clear();
  renderNow();
}

/** 每個分頁上次提示「被其他程式修改」的時間。 */
const changeNoticeAt = new Map<string, number>();

/** 已開啟的檔案被其他程式（同步軟體、其他編輯器、AI 工具）改過。 */
async function onExternalChange(path: string): Promise<void> {
  const doc = tabForPath(path);
  if (!doc || !desktop) return;
  if (doc === active) stash();
  const markChanges = settings.value.aiEnabled && settings.value.markExternalChanges;
  // 正在逐段檢視上一次的外部修改時，接著用同一個基準標示（AI 常會連續改好幾次）。
  const continuing = markChanges && doc === active && review.current?.source === "external";
  if (doc.dirty && !continuing) {
    // 同步軟體常會連續寫入好幾次，提示一次就好。
    const now = Date.now();
    if (now - (changeNoticeAt.get(doc.id) ?? 0) < 15_000) return;
    changeNoticeAt.set(doc.id, now);
    toast(`「${doc.name}」被${otherWriter(path)}修改了，你也有未存檔的變更。`, {
      duration: 12000,
      action: { label: "比較差異", run: () => void compareDoc(doc).catch(reportError) },
    });
    return;
  }
  // 沒有未存檔的變更：直接重新載入。重新讀取也會更新原生端記錄的內容，之後存檔才不會誤判為衝突。
  const file = await desktop.reopenFile(path);
  if (markChanges && doc !== active) doc.externalOriginal ??= loadDraft(doc.id) ?? "";
  saveDraft(doc.id, file.text);
  doc.baseline = hash(file.text);
  doc.missing = false;
  if (doc === active) {
    if (pendingDraft?.id === doc.id) pendingDraft = null;
    baseline = doc.baseline;
    if (markChanges) {
      const original = continuing ? review.current!.original : editor.text;
      if (!showExternalChanges(original, file.text)) {
        // 改回原本的內容了：結束標示，直接顯示目前的版本。
        if (review.active) review.finish();
        if (editor.text !== file.text) editor.replaceAll(file.text);
      }
    } else if (file.text !== editor.text) {
      editor.replaceAll(file.text);
      toast(`「${doc.name}」已被${otherWriter(path)}更新，已重新載入。`, {
        action: { label: "復原", run: () => void undo(editor.view) },
      });
    }
  } else {
    doc.state = null;
    doc.dirty = false;
    if (markChanges && doc.externalOriginal === file.text) doc.externalOriginal = undefined;
    toast(`「${doc.name}」已被${otherWriter(path)}更新${markChanges ? "，切換過去可以看到改了哪裡" : "，已重新載入"}。`);
  }
  persistSession();
  renderTabs();
}

/** 切換到分頁，重新讀取磁碟上的版本並逐段比較。 */
async function compareDoc(doc: Doc): Promise<void> {
  changeNoticeAt.delete(doc.id);
  activate(doc);
  const path = fileHandle?.path;
  if (!path || !desktop) return;
  compareWithDisk((await desktop.reopenFile(path)).text);
}

/**
 * 把目前內容和磁碟上的版本逐段比較。呼叫前應已重新讀取檔案，
 * 這樣比較完存檔時會直接覆寫，不會再跳出衝突提示。
 */
function compareWithDisk(diskText: string): void {
  setBaseline(diskText, true);
  renderSaveState();
  const started = review.start(diskText, {
    title: `與${storeName()}上的版本比較`,
    hint: "逐段選擇要採用哪個版本，處理完記得存檔。",
    acceptLabel: `採用${storeName()}版本`,
    rejectLabel: "保留我的版本",
  });
  if (!started) toast(`目前內容和${storeName()}上的版本相同。`);
}

// 關閉視窗或重新整理前，把還沒寫入的草稿存起來。
window.addEventListener("pagehide", flushDraft);
