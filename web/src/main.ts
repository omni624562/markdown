import "../../crates/md-core/src/document.css";
import "./styles.css";

import { undo } from "@codemirror/commands";
import { foldAll, unfoldAll } from "@codemirror/language";
import { openSearchPanel } from "@codemirror/search";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import init, {
  type Heading,
  type RenderResult,
  formatAllTables,
  formatJson,
  formatTable,
  imageUrls,
  kindFromFileName,
  parseDoc,
  renameLinks,
  render as renderMarkdown,
  spacingPositions,
} from "../pkg/md_wasm.js";
import { AiController } from "./ai.ts";
import { GitPanel } from "./git-ui.ts";
import { GitHub } from "./github-ui.ts";
import { Ado } from "./ado-ui.ts";
import { workItemLink } from "./ado-text.ts";
import { type Command, Commands, formatKeys, fuzzyScore } from "./commands.ts";
import { Editor, cursorInfo } from "./editor.ts";
import {
  type DavConnection,
  type EditorSnapshot,
  type Entry,
  type FileCommit,
  type FileItem,
  type Folder,
  desktop,
  displayPath,
  isRemote,
  remoteId,
  remoteRoot,
} from "./desktop.ts";
import type { EditorState, Text } from "@codemirror/state";
import {
  type FileHandle,
  type OpenedFile,
  desktopHandle,
  download,
  bytesToBase64,
  downloadBytes,
  fromDesktop,
  openFile,
  readTextFile,
  replaceExtension,
  saveFile,
  stem,
} from "./files.ts";
import { fontStack } from "./fonts.ts";
import { TABLE_TEMPLATE, clearInlineFormat, insertBlock, insertLink, toggleLineStyle, toggleWrap } from "./format.ts";
import { indentLess, indentMore, selectAll } from "@codemirror/commands";
import { autoSymbols } from "./auto-symbols.ts";
import { refreshLivePreview } from "./live-preview.ts";
import { proofread, recheckTerms, scanDocument } from "./proofread.ts";
import { sureFixes } from "./terms.ts";
import { SymbolPicker } from "./ui/symbol-picker.ts";
import { type DocKind, KINDS, isTextFileName } from "./kinds.ts";
import { basename, dirname, isInside, localImagePath, markdownUrl, rebase, resolvePath } from "./paths.ts";
import { highlightPlugin } from "./plugins/highlight.ts";
import { localImagesPlugin } from "./plugins/local-images.ts";
import { mathPlugin, renderTex } from "./plugins/math.ts";
import { imageSize, livePreview } from "./live-preview.ts";
import { codeToolsPlugin } from "./plugins/code-tools.ts";
import { tablesPlugin } from "./plugins/tables.ts";
import { mermaidPlugin, mermaidTheme, renderMermaid } from "./plugins/mermaid.ts";
import { blockRemoteImages, blockRemoteImagesInHtml } from "./remote-images.ts";
import { Preview, type PreviewPlugin } from "./preview.ts";
import sampleEn from "./sample.en.md?raw";
import sampleZh from "./sample.md?raw";
import { type BlockRef, collectBlocks, offsetForLineLazy } from "./scroll-sync.ts";
import {
  ACTIVITY_LIMIT,
  DEFAULTS as DEFAULT_SETTINGS,
  FONT_SIZE_RANGE,
  TERM_IGNORE_LIMIT,
  type QuickAction,
  type Settings,
  SettingsStore,
} from "./settings.ts";
import { pasteAsMarkdown } from "./html-paste.ts";
import { hiddenByCollapse, moveSection, sectionRange, subtreeEnd, swapSection } from "./sections.ts";
import { type HeadingRef, encodeLinkPath, linkCompletion } from "./link-complete.ts";
import {
  type DocMeta,
  dropDraft,
  dropOrphanDrafts,
  loadDraft,
  loadProjectView,
  loadSession,
  newId,
  peekSession,
  saveDraft,
  saveProjectView,
  saveSession,
  type Session,
} from "./session.ts";
import * as storage from "./storage.ts";
import { editTable } from "./table.ts";
import { choose } from "./ui/choice.ts";
import { FileTree, type TreeAction } from "./ui/filetree.ts";
import { hydrateIcons, icon } from "./ui/icons.ts";
import { type MenuEntry, setupMenu } from "./ui/menu.ts";
import { Palette, sortByGroup } from "./ui/palette.ts";
import { Picker } from "./ui/picker.ts";
import { currentLang, t, translateDom } from "./i18n.ts";
import { ProjectUi } from "./ui/project-ui.ts";
import { projectInitials, projectSections, samePath } from "./projects.ts";
import { Review } from "./ui/review.ts";
import { SearchPanel } from "./ui/search-panel.ts";
import { TasksPanel } from "./ui/tasks-panel.ts";
import { IssuesPanel, type IssueSummary, shortDate } from "./ui/issues-panel.ts";
import { IssueView, type IssueSource } from "./ui/issue-view.ts";
import { WikiPanel } from "./ui/wiki-panel.ts";
import { flattenPages, imageRepoPath, pageName, resolvePageLink, wikiMarkdown, wikiPageLink, wikiPageUrl } from "./wiki-text.ts";
import { githubIssueMarkdown, issueFileName, workItemIdOf, workItemMarkdown } from "./issue-doc.ts";
import { TagsPanel } from "./ui/tags-panel.ts";
import { Slideshow, slideAtLine, splitSlides } from "./ui/slideshow.ts";
import { compressImage, formatBytes } from "./image-compress.ts";
import { openLightbox } from "./ui/lightbox.ts";
import { type Convert, conversionChanges, loadConverter, looksSimplified } from "./s2t.ts";
import { dateCompletion, dateFormats } from "./date-complete.ts";
import { type SlashItem, slashCompletion } from "./slash-complete.ts";
import { setupWindowControls } from "./ui/window-controls.ts";
import { askPdfOptions } from "./ui/pdf-dialog.ts";
import { PAPERS, PRINT_ROOT_CSS, type PdfOptions, coverHtml, pageCss, pageLayout, shadowCss } from "./pdf-print.ts";
import { docLinksPlugin, wikiTarget } from "./plugins/doc-links.ts";
import { type FileRef, backlinks, linkTarget, resolveWiki } from "./links.ts";
import { type IndexedDoc, type OpenDoc, WorkspaceIndex } from "./workspace-index.ts";
import { isoDate, plainTaskText, setTaskDone, setTaskLine } from "./doc-index.ts";
import { REPO_URL, SettingsDialog } from "./ui/settings-dialog.ts";
import { TabBar } from "./ui/tabbar.ts";
import { TerminalPanel } from "./ui/terminal-panel.ts";
import { WebDavDialog } from "./ui/webdav-dialog.ts";
import { SshDialog, confirmHostKey } from "./ui/ssh-dialog.ts";
import { Updater, versionDetail, versionLabel, versionTooltip } from "./updater.ts";
import { sizeLabel, versionTitle } from "./history-label.ts";
import type { AdoWiki, AdoWorkItem, AdoWorkItemFilter, FileVersion, GitStatus, LinkUpdate } from "./desktop.ts";
import type { GitHistory } from "./ui/history-view.ts";
import { clampSidebarWidth, setupSidebarResize } from "./ui/sidebar-resize.ts";
import { setupSplitter } from "./ui/splitter.ts";
import { insertHandle, selectionToolbar } from "./inline-tools.ts";
import { fileReference } from "./ai-text.ts";
import { CLAUDE_WORKFLOW } from "./ci-workflow.ts";
import { fileUrl as localFileUrl, richHtml } from "./rich-copy.ts";
import { TOC_START, tocBlock, updateToc } from "./toc.ts";
import { BUILTIN_TEMPLATES, TEMPLATE_LIMITS, type Template, fillTemplate, templateFileName } from "./templates.ts";
import { askText } from "./ui/choice.ts";
import { setErrorAction, toast } from "./ui/toast.ts";
import { fieldMenu, selectionMenu, textField } from "./ui/input-menu.ts";
import { authProblem } from "./auth-errors.ts";
import { type SvgImageOptions, standaloneSvg, svgDataUrl, svgToPng } from "./svg-image.ts";

type ViewMode = "editor" | "live" | "split" | "preview";
type ThemePref = "system" | "light" | "dark";

/** 範例文件（英文介面用英文版）。 */
const sample = currentLang() === "en" ? sampleEn : sampleZh;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const workspace = $(".workspace");
const previewEl = $("#preview");
const previewScroller = $("#preview-scroller");
const outlineList = $<HTMLOListElement>("#outline-list");
const outlineEmpty = $("#outline-empty");
const parseErrorEl = $("#parse-error");
const emptyStateEl = $("#empty-state");
const formatBar = $("#format-bar");
const kindSelect = $<HTMLSelectElement>("#doc-kind");
const fileInput = $<HTMLInputElement>("#file-input");
const status = {
  cursor: $("#status-cursor"),
  stats: $("#status-stats"),
  save: $("#status-save"),
};

// 介面語言：靜態的 HTML 先翻譯，也告訴後端用哪個語言回訊息。
document.documentElement.lang = currentLang() === "en" ? "en" : "zh-Hant-TW";
translateDom(document.body);
void desktop?.setLanguage(currentLang()).catch(() => {});
hydrateIcons();
// 同時載入核心（WebAssembly）與設定。
const [, { store: settings, recovered: settingsRecovered }] = await Promise.all([init(), SettingsStore.load()]);

// ---- 狀態 ---------------------------------------------------------------

const narrowQuery = matchMedia("(max-width: 720px)");
/** 資料夾有變動時搜尋面板沒有顯示：下次打開時重新搜尋。 */
let searchStale = false;

/** FNV-1a，只用來比較內容是否相同。 */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/** 編輯器目前內容的雜湊。同一份內容只算一次（重畫、存檔狀態、切換分頁都會問）。 */
let hashedDoc: Text | null = null;
let hashedValue = "";
function editorHash(): string {
  const doc = editor.view.state.doc;
  if (doc !== hashedDoc) {
    hashedDoc = doc;
    hashedValue = hash(doc.toString());
  }
  return hashedValue;
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
  /**
   * 沒有草稿（儲存空間滿了被清掉，或沒存成功），內容還沒從檔案讀進來。
   * 這時編輯器是空的，不能存檔，否則會把檔案蓋成空白。
   */
  unloaded?: boolean;
  /** 在背景被外部修改時，修改前的內容；切換到這個分頁時逐段標示差異（A4）。 */
  externalOriginal?: string;
  /**
   * 檔案的編碼無法辨識（不是 UTF-8 也不是 Big5），畫面上的內容可能是亂碼。
   * 不自動存檔；手動存檔前先確認，免得把原檔換成亂碼。
   */
  lossy?: boolean;
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

/** 從保存的分頁資料建立分頁。 */
function docsFrom(session: Session | null): Doc[] {
  return (session?.docs ?? []).map((m) => ({
    ...makeDoc(m),
    ...m,
    // 只有桌面版會記下路徑；先建立控制代碼，否則第一次保存分頁狀態時路徑會被清掉。
    handle: m.path && desktop ? desktopHandle(m.path, m.name) : null,
    ...draftState(m),
  }));
}

/** 分頁的草稿狀態：桌面版存成檔案的分頁沒有草稿時，等一下從檔案讀取，不算有未存檔的變更。 */
function draftState(m: DocMeta): { dirty: boolean; unloaded: boolean } {
  const draft = loadDraft(m.id);
  if (draft === null && m.path && desktop) return { dirty: false, unloaded: true };
  return { dirty: hash(draft ?? "") !== m.baseline, unloaded: false };
}

/**
 * 目前的分頁屬於哪個專案（資料夾路徑）；null 是沒有開啟資料夾時的分頁。
 * 和「上次開啟的資料夾」分開記：資料夾暫時打不開（例如網路磁碟還沒接上）時，分頁仍然留在原本的專案。
 */
let tabScope: string | null = desktop ? (storage.load("tab-scope") ?? storage.load("workspace")) : null;
/** 啟動時已經重新讀過分頁的檔案（之後切換專案時，換進來的分頁也要重新讀）。 */
let docsLoaded = false;
const restored = loadSession(tabScope);
let docs: Doc[] = docsFrom(restored);
if (!docs.length) {
  // 第一次使用：開啟範例文件，並以它為基準（不顯示未存檔）。
  const first = makeDoc({ name: t("未命名.md"), kind: "markdown", baseline: hash(sample) });
  saveDraft(first.id, sample);
  docs = [first];
}
let active: Doc = docs.find((d) => d.id === restored?.activeId) ?? docs[0];

let kind: DocKind = active.kind;
/**
 * 開著 Wiki、工作項目時，大綱改列它的標題（`body` 是內容的元素，用來捲動）；
 * 編輯中文件的標題記在 `docHeadings`，關掉後換回來。
 */
let outlineView: { key: string; headings: Heading[]; body: HTMLElement | null } | null = null;
let docHeadings: Heading[] = [];
let fileName = active.name;
let fileHandle: FileHandle | null = active.handle;
/** 最後一次存檔／開檔／新增時內容的雜湊；目前內容與它不同就代表有未存檔的變更。 */
let baseline = active.baseline;
/** 目前內容是否對應到一個實際存過或開啟過的檔案。 */
let fileBacked = active.fileBacked;
let draftSaved = false;
let view: ViewMode = "split";
// 簡約版面（MarkText 式）成為預設：舊版的使用者也換一次，之後就照自己的選擇。
if (storage.load("layout") !== "minimal") {
  storage.save("layout", "minimal");
  storage.save("outline", "hidden");
  if (storage.load("view") !== "preview") storage.save("view", "live");
}
let outlineShown = storage.load("outline") !== "hidden";
/** 大綱放在右邊時，右邊那一欄是否顯示（可以整個收起來）。 */
let rightOutlineShown = storage.load("outline-right") !== "hidden";
/** 資料夾內容可能變了，下次用到索引時重新讀取。 */
let indexStale = true;
/** 編輯器目前是否套用了即時預覽（Markdown 且檢視為「即時預覽」）。 */
let liveApplied = false;
let splitRatio = Number(storage.load("split")) || 0.5;
let themePref: ThemePref = (storage.load("theme") as ThemePref | null) ?? "system";
let blocks: BlockRef[] | null = null;
let editorTopLine = 1;

// ---- 編輯器與預覽 -------------------------------------------------------

/**
 * WebDAV 遠端圖片（下載後的 data: 網址）。預覽與即時預覽共用，捲出畫面再捲回來不會重新下載。
 * 失敗的不快取，下次再試。
 */
const davImages = new Map<string, Promise<string>>();
/** 已下載圖片的大小（字元數）；總量超過上限就從最久沒用到的開始丟。 */
const davImageSizes = new Map<string, number>();
let davImageBytes = 0;
const DAV_IMAGE_LIMIT = 64 * 1024 * 1024;
function dropDavImage(path: string): void {
  davImages.delete(path);
  davImageBytes -= davImageSizes.get(path) ?? 0;
  davImageSizes.delete(path);
}
function davImageCached(path: string): Promise<string> {
  let p = davImages.get(path);
  if (p) {
    // 移到最後面，代表最近用過。
    davImages.delete(path);
    davImages.set(path, p);
    return p;
  }
  if (davImages.size >= 200) dropDavImage(davImages.keys().next().value!);
  p = desktop!.davImage(path);
  davImages.set(path, p);
  p.then(
    (url) => {
      if (davImages.get(path) !== p) return;
      davImageSizes.set(path, url.length);
      davImageBytes += url.length;
      for (const old of davImages.keys()) {
        if (davImageBytes <= DAV_IMAGE_LIMIT || old === path) break;
        dropDavImage(old);
      }
    },
    () => {
      if (davImages.get(path) === p) dropDavImage(path);
    },
  );
  return p;
}

const preview = new Preview(previewEl, [
  highlightPlugin(),
  mathPlugin(() => settings.value.math),
  mermaidPlugin(() => settings.value.mermaid, { open: (svg) => openDiagram(svg), copy: (svg) => void copyDiagram(svg) }),
  tablesPlugin(),
  codeToolsPlugin({
    copy: copyCode,
    skip: (lang) => (lang === "mermaid" && settings.value.mermaid) || (lang === "math" && settings.value.math),
  }),
  docLinksPlugin({ wikiExists: (target) => wikiExists(target) }),
  ...(desktop
    ? [localImagesPlugin(() => (fileHandle?.path ? dirname(fileHandle.path) : null), desktop.fileUrl, (p) => davImageCached(p))]
    : []),
  {
    name: "remote-images",
    apply() {},
    prepare(content) {
      if (blockRemote()) blockRemoteImages(content);
    },
  },
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
    scheduleDiskSave();
    ai?.scheduleSync();
    refreshIndexPanels(800, { backlinks: false });
  },
  onSelection(v) {
    updateCursor(v);
    ai?.scheduleSync();
  },
  onScroll(line) {
    editorTopLine = line;
    syncPreview();
    // 大綱的目前位置不必每個捲動事件都算，一個畫面算一次就好。
    if (!headingFrame) {
      headingFrame = requestAnimationFrame(() => {
        headingFrame = 0;
        updateActiveHeading();
      });
    }
  },
  getError: () => preview.result?.error ?? null,
}, {
  lineNumbers: settings.value.lineNumbers,
  autoPairBrackets: settings.value.autoPairBrackets,
  formatTable: tableFormatter,
  focusMode: settings.value.focusMode,
  typewriterMode: settings.value.typewriterMode,
  live: livePreview({
    imageUrl(src) {
      if (/^https?:/i.test(src)) return blockRemote() ? null : src;
      if (/^data:image\//i.test(src)) return src;
      const docPath = fileHandle?.path;
      if (!desktop || !docPath) return null;
      const path = localImagePath(src, dirname(docPath));
      if (!path) return null;
      return isRemote(path) ? davImageCached(path) : desktop.fileUrl(path);
    },
    renderTable: (markdown) => {
      const html = renderMarkdown(markdown, { kind: "markdown" }).html;
      return blockRemote() ? blockRemoteImagesInHtml(html) : html;
    },
    formatTable: (markdown) => tableFormatter(markdown),
    renderMath: renderTex,
    mathEnabled: () => settings.value.math,
    renderMermaid,
    mermaidEnabled: () => settings.value.mermaid,
    mermaidTheme,
    openDiagram: (svg, editSource) => openDiagram(svg, editSource),
    copyDiagram: (svg) => void copyDiagram(svg),
    openLink: (href) => void followLink(href).catch(reportError),
    enabled: () => !review.active,
    openWiki: (target) => void openWiki(target).catch(reportError),
    wikiExists: (target) => wikiExists(target),
    openTag: (tag) => openTag(tag),
    openImage: (url, alt, editSource) => openLightbox(url, alt, editSource),
  }),
  markdownTools: [
    selectionToolbar({
      enabled: () => view !== "preview" && !settings.value.fixedToolbar && !review.active,
      render: formatBubble,
    }),
    insertHandle({
      enabled: () => liveApplied && !review.active && !narrowQuery.matches,
      open: (anchor) => openInsertMenu(anchor.getBoundingClientRect()),
    }),
  ],
  extra: [
    review.extension,
    EditorView.updateListener.of((u) => onSimplifiedPaste(u)),
    autoSymbols(() => kind !== "json" && settings.value.autoSymbols),
    proofread({
      enabled: () => kind !== "json" && settings.value.termCheck,
      ignored: () => new Set(settings.value.termIgnore),
      ignore: (word) => {
        settings.update({ termIgnore: [...settings.value.termIgnore, word].slice(-TERM_IGNORE_LIMIT) });
        toast(t("不再提示「{word}」。之後可以在指令面板執行「清除不再提示的詞」恢復。", { word }));
      },
    }),
    linkCompletion(
      {
        enabled: () => kind === "markdown",
        docPath: () => fileHandle?.path ?? null,
        files: async () => {
          if (!desktop || !workspaceRoot) return [];
          fileListCache ??= await desktop.listFiles(workspaceRoot.path).catch(() => []);
          return fileListCache.map((f) => f.path);
        },
        headings: () => preview.result?.headings ?? [],
        fileHeadings: headingsOfFile,
        wikiPath: async (target) => {
          if (!desktop || !workspaceRoot) return null;
          fileListCache ??= await desktop.listFiles(workspaceRoot.path).catch(() => []);
          return resolveWiki(target, markdownFiles(fileListCache), fileHandle?.path ? dirname(fileHandle.path) : null);
        },
      },
      [
        (ctx) => (kind === "json" ? null : dateCompletion(ctx)),
        (ctx) => (kind === "markdown" ? slashSource(ctx) : null),
      ],
    ),
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
        // 右鍵選單：剪下、複製、貼上、格式、插入符號、縮排，以及 AI。
        // 點在選取範圍外時，先把游標移到點的位置（和一般編輯器一樣）。
        const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
        const { from, to } = v.state.selection.main;
        if (pos !== null && (pos < from || pos > to)) v.dispatch({ selection: { anchor: pos } });
        e.preventDefault();
        // Linux 按下右鍵就觸發 contextmenu，等放開後再顯示，以免被當成點在選單外而立刻關閉。
        const at = new DOMRect(e.clientX, e.clientY, 0, 0);
        setTimeout(() => contextMenu.open(at));
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
  status.cursor.textContent = t("第 {line} 行，第 {column} 欄", { line, column }) + (selected ? t("（已選取 {n} 字）", { n: selected }) : "");
  // 即時預覽像在看文件，只有選取文字時才顯示（選取字數）。
  status.cursor.hidden = liveApplied && !selected;
}

/** 超過這個長度的文件，預覽、大綱與字數改成隔一小段時間才更新，打字不會被拖慢。 */
const LARGE_DOC = 150_000;
/** 上一次更新預覽、大綱與字數花的時間（毫秒）。 */
let lastRenderMs = 0;
let renderQueued = false;
let renderTimer: number | undefined;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => {
    renderQueued = false;
    renderNow();
  };
  // 更新一次要花不少時間（大文件、慢的電腦）：打字期間每隔一段時間才更新一次，
  // 間隔依上次花的時間調整，停手後一樣會很快更新到最新。
  if (lastRenderMs > 25 || editor.view.state.doc.length > LARGE_DOC) {
    clearTimeout(renderTimer);
    renderTimer = window.setTimeout(run, Math.min(400, Math.max(120, lastRenderMs * 2)));
  } else {
    requestAnimationFrame(run);
  }
}

/**
 * 更新預覽、大綱與統計。預覽沒有顯示時（例如即時預覽、原始碼檢視）只算大綱與統計，
 * 切換到預覽時才補畫；`full` 強制產生預覽畫面（簡報、複製 HTML 等要用到）。
 */
function renderNow(full = false): void {
  const started = performance.now();
  const text = editor.text;
  const result = preview.update(text, kind, !full && !previewVisible());
  blocks = null;
  renderError(result);
  renderEmptyState(text);
  docHeadings = result.headings;
  if (!outlineView) renderOutline(result.headings);
  renderStats(result);
  renderSaveState();
  editor.relint();
  syncPreview();
  updateActiveHeading();
  lastRenderMs = performance.now() - started;
}

function renderError({ error }: RenderResult): void {
  previewEl.classList.toggle("stale", !!error);
  parseErrorEl.hidden = !error;
  if (!error) return;
  const msg = document.createElement("p");
  msg.append(icon("circle-alert"));
  const strong = document.createElement("strong");
  strong.textContent = t("{kind} 格式錯誤（第 {line} 行，第 {column} 欄）", { kind: KINDS[kind].label, line: error.line, column: error.column });
  const detail = document.createElement("span");
  detail.textContent = error.message;
  msg.append(strong, detail);
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "btn";
  jump.textContent = t("跳到錯誤位置");
  jump.addEventListener("click", () => editor.reveal(error.line, error.column));
  parseErrorEl.replaceChildren(msg, jump);
}

/** 空白文件提示目前畫的內容（一樣就不重畫，最近開啟的檔案也不重讀）。 */
let emptyStateKey = "";

/**
 * 空白文件的提示：開啟檔案、從範本新增、載入範例、最近開啟的檔案。
 * 有預覽時放在預覽區；即時預覽、原始碼只有編輯區，改放在編輯區中間（不擋打字，打字就消失）。
 */
function renderEmptyState(text: string): void {
  const empty = text.trim() === "";
  emptyStateEl.hidden = !empty;
  if (!empty) {
    emptyStateKey = "";
    return;
  }
  const inEditor = workspace.dataset.view === "editor";
  const host = inEditor ? $(".editor-pane") : previewScroller;
  if (emptyStateEl.parentElement !== host) host.append(emptyStateEl);
  emptyStateEl.classList.toggle("in-editor", inEditor);
  const key = `${kind}|${view}|${inEditor}|${currentLang()}`;
  if (key === emptyStateKey) return;
  emptyStateKey = key;
  // 只有預覽時旁邊沒有編輯區，提示改成切換到可以打字的檢視。
  const previewOnly = view === "preview";
  const hints: Record<DocKind, string> = {
    markdown: previewOnly
      ? t("按「開始寫作」切換到即時預覽，直接在畫面上打字。")
      : view === "live"
        ? t("直接在這裡開始寫，排版會即時顯示。")
        : inEditor
          ? t("在這裡輸入 Markdown，切到預覽可以看排版結果。")
          : t("在左邊開始寫，這裡會即時顯示排版結果。"),
    text: previewOnly ? t("按「開始寫作」切換到可以輸入的檢視。") : inEditor ? t("在這裡輸入文字。") : t("在左邊輸入文字，這裡會顯示閱讀版面。"),
    json: previewOnly
      ? t("按「開始寫作」切換到可以輸入的檢視。")
      : inEditor
        ? t("在這裡貼上 JSON，切到預覽可以看樹狀檢視。")
        : t("貼上 JSON，這裡會顯示可摺疊的樹狀檢視，並即時檢查語法。"),
  };
  const card = document.createElement("div");
  card.className = "empty-card";
  card.innerHTML = `<h2></h2><p></p><div class="empty-actions"></div><p class="empty-tip"></p>`;
  card.querySelector("h2")!.textContent = t("空白文件");
  card.querySelector(".empty-tip")!.textContent = t("也可以直接把 Markdown、文字檔或程式碼檔拖曳進來");
  card.querySelector("p")!.textContent = hints[kind];
  const actions = card.querySelector(".empty-actions")!;
  const mk = (label: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = label;
    b.addEventListener("click", run);
    actions.append(b);
  };
  if (previewOnly) mk(t("開始寫作"), () => setView(kind === "markdown" ? "live" : "editor"));
  mk(t("開啟檔案"), () => void commands.run("open"));
  if (kind === "markdown") mk(t("從範本新增"), () => void commands.run("new-from-template"));
  if (kind === "markdown") mk(t("載入範例文件"), () => editor.replaceAll(sample));
  actions.querySelector("button")?.classList.add("btn-primary");
  emptyStateEl.replaceChildren(card);
  if (desktop) void renderRecentFiles(card, key);
}

/** 空白文件提示下方的「最近開啟的檔案」（最多 5 個，點了直接開啟）。 */
async function renderRecentFiles(card: HTMLElement, key: string): Promise<void> {
  const { files } = await desktop!.recent().catch(() => ({ files: [] as string[] }));
  if (key !== emptyStateKey || !files.length) return;
  const box = document.createElement("div");
  box.className = "empty-recent";
  const h = document.createElement("h3");
  h.textContent = t("最近開啟的檔案");
  const list = document.createElement("ul");
  for (const path of files.slice(0, 5)) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.title = displayPath(path);
    const name = document.createElement("span");
    name.className = "empty-recent-name";
    name.textContent = basename(path) || path;
    const dir = document.createElement("span");
    dir.className = "empty-recent-dir";
    dir.textContent = displayPath(dirname(path));
    b.append(icon("file-text"), name, dir);
    b.addEventListener("click", () => void openPath(path).catch(reportError));
    li.append(b);
    list.append(li);
  }
  box.append(h, list);
  card.querySelector(".empty-tip")!.before(box);
}

let outlineKey = "";
/** 大綱收合的標題（每個分頁各自記住，以「層級 標題文字」辨認，編輯後仍維持）。 */
const outlineCollapsed = new Map<string, Set<string>>();
const collapseKey = (h: Heading) => `${h.level} ${h.text}`;
function collapsedSet(): Set<string> {
  const scope = outlineView ? `view:${outlineView.key}` : active.id;
  let set = outlineCollapsed.get(scope);
  if (!set) outlineCollapsed.set(scope, (set = new Set()));
  return set;
}

/** 「全部收合／全部展開」按鈕（放在大綱的標題列）。 */
const outlineCollapseAll = document.createElement("button");
outlineCollapseAll.type = "button";
outlineCollapseAll.className = "btn icon-only";
outlineCollapseAll.addEventListener("click", () => {
  const set = collapsedSet();
  const levels = outlineHeadings.map((h) => h.level);
  if (set.size) set.clear();
  else outlineHeadings.forEach((h, i) => subtreeEnd(levels, i) > i + 1 && set.add(collapseKey(h)));
  applyOutlineCollapse();
});
{
  const actions = document.createElement("div");
  actions.className = "side-actions";
  actions.append(outlineCollapseAll);
  $("#panel-outline .side-head").append(actions);
}

/** 依收合狀態隱藏子標題，更新三角形與「全部收合／展開」按鈕。 */
function applyOutlineCollapse(): void {
  const set = collapsedSet();
  const levels = outlineHeadings.map((h) => h.level);
  const isCollapsed = (i: number) => set.has(collapseKey(outlineHeadings[i]));
  const hidden = hiddenByCollapse(levels, isCollapsed);
  outlineList.querySelectorAll<HTMLLIElement>(":scope > li").forEach((li, i) => {
    li.hidden = hidden[i];
    const toggle = li.querySelector<HTMLButtonElement>(".outline-toggle");
    if (!toggle) return;
    const collapsed = isCollapsed(i);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.title = collapsed ? t("展開") : t("收合");
    toggle.setAttribute("aria-label", toggle.title);
  });
  const any = [...set].some((k) => outlineHeadings.some((h) => collapseKey(h) === k));
  if (!any) set.clear();
  const canCollapse = outlineHeadings.some((_, i) => subtreeEnd(levels, i) > i + 1);
  outlineCollapseAll.hidden = !canCollapse;
  const label = any ? t("全部展開") : t("全部收合");
  outlineCollapseAll.title = label;
  outlineCollapseAll.setAttribute("aria-label", label);
  outlineCollapseAll.replaceChildren(icon(any ? "chevrons-up-down" : "chevrons-down-up"));
  updateActiveHeading();
}

/** 收合或展開第 `index` 個標題；`collapse` 省略時切換。 */
function toggleOutline(index: number, collapse?: boolean): boolean {
  const h = outlineHeadings[index];
  const levels = outlineHeadings.map((o) => o.level);
  if (!h || subtreeEnd(levels, index) <= index + 1) return false;
  const set = collapsedSet();
  const key = collapseKey(h);
  const next = collapse ?? !set.has(key);
  if (next === set.has(key)) return false;
  if (next) set.add(key);
  else set.delete(key);
  applyOutlineCollapse();
  return true;
}

function renderOutline(headings: Heading[]): void {
  outlineEmpty.hidden = headings.length > 0;
  outlineEmpty.textContent = outlineView
    ? t("這一頁沒有標題。")
    : kind === "markdown"
      ? t("文件中還沒有標題。用 # 開頭的行會出現在這裡。")
      : t("只有 Markdown 文件的標題會顯示在大綱中。");
  outlineHeadings = headings;
  // Wiki、工作項目是唯讀的，不能拖曳搬移章節。
  const movable = !outlineView && kind === "markdown";
  const scope = outlineView ? `view:${outlineView.key}` : active.id;
  // 標題沒有變（大多數按鍵都是這樣）就不重建，大文件可能有上千個標題。
  const key = `${scope}\n${movable}\n${headings.map((h) => `${h.level} ${h.line} ${h.id} ${h.text}`).join("\n")}`;
  if (key === outlineKey && outlineList.childElementCount === headings.length) return;
  outlineKey = key;
  // 重新產生大綱時保留鍵盤焦點（例如用 Alt+↑／↓ 連續搬移章節）。
  const focused = document.activeElement as HTMLElement | null;
  const focusedIndex = focused && outlineList.contains(focused) ? Number(focused.dataset.index) : -1;
  const levels = headings.map((h) => h.level);
  const top = Math.min(...levels);
  outlineList.replaceChildren(
    ...headings.map((h, i) => {
      const li = document.createElement("li");
      li.style.setProperty("--depth", String(h.level - top));
      const a = document.createElement("a");
      a.href = `#${encodeURIComponent(h.id)}`;
      a.dataset.id = h.id;
      a.dataset.line = String(h.line);
      a.dataset.index = String(i);
      a.textContent = h.text || t("（空白標題）");
      a.style.setProperty("--level", String(h.level));
      // 連結預設可以拖曳：不能搬移章節時關掉，免得拖出網址。
      a.draggable = movable;
      if (movable) a.title = t("拖曳可以搬移整個章節；也可以按 Alt+↑／↓");
      // 有子標題的才有收合的三角形（不在 Tab 順序裡，鍵盤用 ←／→）。
      if (subtreeEnd(levels, i) > i + 1) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "outline-toggle";
        toggle.tabIndex = -1;
        toggle.dataset.index = String(i);
        toggle.append(icon("chevron-down"));
        li.append(toggle);
      }
      li.append(a);
      return li;
    }),
  );
  applyOutlineCollapse();
  if (focusedIndex >= 0) outlineList.querySelectorAll<HTMLElement>("a")[focusedIndex]?.focus({ preventScroll: true });
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
  const headings = renderMarkdown(text, { kind: "markdown", skipHtml: true }).headings;
  if (!open) {
    if (headingCache.size >= 200) headingCache.delete(headingCache.keys().next().value!);
    headingCache.set(path, { at: Date.now(), headings });
  }
  return headings;
}

/** 捲到目前文件中的錨點（標題或註腳）。 */
function scrollToAnchor(id: string): void {
  const heading = preview.result?.headings.find((h) => h.id === id);
  if (heading && view !== "preview") editor.reveal(heading.line);
  if (previewVisible()) document.getElementById(id)?.scrollIntoView({ block: "start" });
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
    toast(desktop ? t("存檔之後才能開啟相對路徑的連結。") : t("網頁版無法開啟相對路徑的檔案，請改用桌面版。"));
    return;
  }
  const target = resolvePath(dirname(base), rel);
  if (!/\.(md|markdown|txt|json)$/i.test(target)) {
    toast(t("只能在編輯器中開啟 Markdown、純文字與 JSON 檔。"));
    return;
  }
  await openPath(target);
  if (anchor) {
    renderNow();
    scrollToAnchor(anchor);
  }
}

/** 使用者按過「載入遠端圖片」的分頁（只限這次開啟期間）。 */
const remoteAllowed = new Set<string>();

/** 目前的文件要不要封鎖遠端圖片。 */
function blockRemote(): boolean {
  return settings.value.blockRemoteImages && !remoteAllowed.has(active.id);
}

/** 載入這份文件的遠端圖片（不改設定，其他文件仍然封鎖）。 */
function allowRemoteImages(): void {
  remoteAllowed.add(active.id);
  preview.clear();
  renderNow();
  refreshLivePreview(editor.view);
}

previewEl.addEventListener("click", (e) => {
  const image = e.target as HTMLElement;
  if (image instanceof HTMLImageElement && image.classList.contains("remote-blocked")) {
    allowRemoteImages();
    return;
  }
  if (image instanceof HTMLImageElement && !image.closest("a[href]")) {
    openLightbox(image.currentSrc || image.src, image.alt);
    return;
  }
  const tag = (e.target as HTMLElement).closest?.<HTMLElement>(".tag[data-tag]");
  if (tag) {
    openTag(tag.dataset.tag!);
    return;
  }
  // 流程圖裡的連結是 SVG 的 <a xlink:href>，`a[href]` 選不到，所以任何 <a> 都要攔下來。
  const link = (e.target as Element).closest?.("a");
  if (!link || e.defaultPrevented) return;
  // 不讓整個編輯器視窗被導到別的網頁。
  e.preventDefault();
  if (link.hasAttribute("data-wikilink")) {
    void openWiki(wikiTarget(link as HTMLAnchorElement)).catch(reportError);
    return;
  }
  const href = link.getAttribute("href") ?? link.getAttributeNS("http://www.w3.org/1999/xlink", "href");
  if (href) void followLink(href).catch(reportError);
});

// ---- 文件互連：[[文件]] -----------------------------------------------------------

const markdownLists = new WeakMap<readonly FileItem[], FileRef[]>();

/** 資料夾中的 Markdown 文件（同一份清單只過濾一次，`resolveWiki` 的索引也能沿用）。 */
function markdownFiles(list: readonly FileItem[]): FileRef[] {
  let md = markdownLists.get(list);
  if (!md) {
    md = list.filter((f) => /\.(md|markdown)$/i.test(f.path));
    markdownLists.set(list, md);
  }
  return md;
}

let fileListLoading: Promise<void> | null = null;

/** `[[文件]]` 找不找得到對應的檔案；檔案清單還沒讀到時先回傳 null，讀到後重畫。 */
function wikiExists(target: string): boolean | null {
  if (!desktop || !workspaceRoot) return null;
  if (!fileListCache) {
    const root = workspaceRoot.path;
    fileListLoading ??= desktop
      .listFiles(root)
      .then((list) => {
        if (workspaceRoot?.path === root) fileListCache ??= list;
      })
      .catch(() => {})
      .finally(() => {
        fileListLoading = null;
        if (!fileListCache) return;
        refreshLivePreview(editor.view);
        preview.clear();
        renderNow();
      });
    return null;
  }
  return resolveWiki(target, markdownFiles(fileListCache), fileHandle?.path ? dirname(fileHandle.path) : null) !== null;
}

/** 開啟 `[[文件#標題]]`；資料夾中還沒有這份文件時詢問要不要建立。 */
async function openWiki(full: string): Promise<void> {
  const hashAt = full.indexOf("#");
  const target = (hashAt >= 0 ? full.slice(0, hashAt) : full).trim();
  const anchor = hashAt >= 0 ? full.slice(hashAt + 1).trim() : "";
  if (!target) {
    if (anchor) scrollToHeading(anchor);
    return;
  }
  if (!desktop || !workspaceRoot) {
    toast(desktop ? t("開啟資料夾後，才能用 [[文件]] 連到資料夾中的其他文件。") : t("網頁版無法開啟其他檔案，請改用桌面版。"));
    return;
  }
  const root = workspaceRoot.path;
  fileListCache ??= await desktop.listFiles(root).catch(() => []);
  const here = fileHandle?.path ? dirname(fileHandle.path) : null;
  const path = resolveWiki(target, markdownFiles(fileListCache), here);
  if (path) {
    await openPath(path);
    if (anchor) {
      renderNow();
      scrollToHeading(anchor);
    }
    return;
  }
  const name = basename(target.replace(/\\/g, "/")).replace(/\.(md|markdown)$/i, "");
  const parent = here && isInside(here, root) ? here : root;
  const choice = await choose(
    t("建立「{name}.md」？", { name }),
    t("資料夾中還沒有「{target}」這份文件。要在「{folder}」資料夾建立嗎？", { target, folder: basename(parent) || parent }),
    [
    { id: "create", label: t("建立"), primary: true },
    { id: "cancel", label: t("取消") },
  ]);
  if (choice !== "create") return;
  const created = await desktop.createEntry(parent, `${name}.md`, false);
  fileListCache = null;
  indexStale = true;
  await fileTree?.refresh([parent]);
  await openPath(created);
  if (!editor.text) editor.replaceAll(`# ${name}\n\n`);
  refreshLivePreview(editor.view);
}

/** 捲到標題：`[[文件#標題]]` 的標題可能是文字（例如「一、背景」）或錨點 id。 */
function scrollToHeading(anchor: string): void {
  const headings = preview.result?.headings ?? [];
  const h = headings.find((x) => x.id === anchor) ?? headings.find((x) => x.text.trim() === anchor);
  scrollToAnchor(h?.id ?? anchor);
}

/** 檔案或資料夾改名後，更新其他文件中指向它（或它底下檔案）的連結。 */
async function updateLinksAfterRename(from: string, to: string, docsBefore: IndexedDoc[], files: FileRef[]): Promise<void> {
  const moved = (p: string) => rebase(p, from, to);
  // 先用索引裡的連結挑出可能要改的文件，只讀這幾份的內容。
  const linking = docsBefore.filter(
    (doc) =>
      doc.path &&
      doc.info.links.some((l) => {
        const p = linkTarget(l, doc.path, files);
        return p !== null && moved(p) !== null;
      }),
  );
  if (!linking.length) return;
  // 已開啟的分頁用編輯器裡的內容；沒開啟的檔案由後端讀取、改寫，只傳回有改到的。
  const changes: LinkUpdate[] = [];
  for (const doc of linking) {
    if (doc.text === null) continue;
    const next = renameLinks(doc.text, doc.path!, files, from, to);
    if (next !== undefined) changes.push({ path: moved(doc.path!) ?? doc.path!, before: doc.text, text: next });
  }
  const closed = linking.filter((doc) => doc.text === null).map((doc) => doc.path!);
  if (closed.length) changes.push(...(await desktop!.linkUpdates(closed, files, from, to)));
  if (!changes.length) return;
  const choice = await choose(
    t("更新連結？"),
    t("有 {n} 份文件連到「{from}」，要一起把連結改成「{to}」嗎？更新前的內容會記在版本記錄中。", {
      n: changes.length,
      from: basename(from),
      to: basename(to),
    }),
    [
      { id: "update", label: t("更新連結"), primary: true },
      { id: "skip", label: t("不用") },
    ],
  );
  if (choice !== "update") return;
  let done = 0;
  const failed: string[] = [];
  for (const c of changes) {
    try {
      await replaceDocText(c.path, c.before, c.text);
      done++;
    } catch (e) {
      failed.push(t("{name}（{error}）", { name: basename(c.path), error: e instanceof Error ? e.message : String(e) }));
    }
  }
  indexStale = true;
  refreshIndexPanels();
  if (failed.length) toast(t("已更新 {n} 份文件的連結；無法更新：{failed}", { n: done, failed: failed.join(t("、")) }), { tone: "error", duration: 10000 });
  else toast(t("已更新 {n} 份文件的連結。", { n: done }), { tone: "success" });
}

/**
 * 把一份文件的內容換成 `text`（`expected` 是改之前的內容）：
 * 目前的分頁直接改編輯器（可以復原）；背景分頁沒有未存檔的變更時一起寫入檔案；沒開啟的檔案直接改寫。
 */
async function replaceDocText(path: string, expected: string, text: string): Promise<void> {
  const tab = tabForPath(path);
  if (tab === active) {
    editor.replaceAll(text, { isolate: true });
    return;
  }
  if (tab) {
    const clean = !tab.dirty;
    if (clean) await desktop!.updateDoc(path, expected, text);
    tab.state = tab.state ? tab.state.update({ changes: { from: 0, to: tab.state.doc.length, insert: text } }).state : null;
    saveDraft(tab.id, text);
    if (clean) tab.baseline = hash(text);
    persistSession();
    renderTabs();
    return;
  }
  await desktop!.updateDoc(path, expected, text);
}

// ---- 列印／匯出 PDF（E11） ------------------------------------------------------

/**
 * 用和「匯出 HTML」相同的內容（公式、流程圖都已轉好）放進主視窗看不見的列印區（Shadow DOM）來列印，
 * 在列印對話框中選「另存為 PDF」就能存成 PDF。一律用淺色主題列印。
 */
const PDF_DEFAULTS: Omit<PdfOptions, "header"> = { pageNumbers: true, cover: false, subtitle: "", paper: "A4" };

/** 上次匯出 PDF 的選項（頁首文字每份文件不同，不記）。 */
function savedPdfOptions(): Omit<PdfOptions, "header"> {
  try {
    const raw = JSON.parse(storage.load("pdf-options") ?? "{}") as Partial<PdfOptions>;
    return {
      pageNumbers: typeof raw.pageNumbers === "boolean" ? raw.pageNumbers : PDF_DEFAULTS.pageNumbers,
      cover: typeof raw.cover === "boolean" ? raw.cover : PDF_DEFAULTS.cover,
      subtitle: typeof raw.subtitle === "string" ? raw.subtitle.slice(0, 200) : "",
      paper: raw.paper && raw.paper in PAPERS ? raw.paper : PDF_DEFAULTS.paper,
    };
  } catch {
    return { ...PDF_DEFAULTS };
  }
}

/** 文件標題：第一個一級標題，沒有的話用檔名。 */
function documentTitle(): string {
  return preview.result?.headings.find((h) => h.level === 1)?.text.trim() || stem(fileName);
}

/**
 * 匯出 PDF：桌面版選好位置後直接存成 PDF（不經過列印對話框），網頁版開啟列印對話框。
 * `printer` 為 true 時（桌面版的「列印…」）一律開列印對話框。
 */
async function exportPdf(printer = false): Promise<void> {
  if (preview.result?.error) {
    toast(t("文件有格式錯誤，修正後才能列印。"), { tone: "error" });
    return;
  }
  const title = documentTitle();
  const direct = !!desktop && !printer;
  const opts = await askPdfOptions({ header: title, ...savedPdfOptions() }, direct);
  if (!opts) return;
  const { header: _header, ...remember } = opts;
  storage.save("pdf-options", JSON.stringify(remember));
  if (direct) {
    const path = await desktop!.pickPdfPath(`${stem(fileName)}.pdf`);
    if (!path) return;
    const cleanup = await preparePrint(opts, title);
    try {
      await desktop!.printToPdf(path, pageLayout(opts));
      toast(t("已匯出「{name}」", { name: basename(path) }), { tone: "success" });
      return;
    } catch (e) {
      // 不支援直接匯出或匯出失敗：改用列印對話框（選「另存為 PDF」）。
      toast(t("無法直接匯出 PDF（{error}），改用列印對話框，請選「另存為 PDF」。", { error: e instanceof Error ? e.message : String(e) }), {
        tone: "error",
        duration: 10000,
      });
    } finally {
      cleanup();
    }
  }
  const cleanup = await preparePrint(opts, title);
  window.addEventListener("afterprint", () => setTimeout(cleanup, 0), { once: true });
  window.print();
}

/**
 * 把要列印的內容（和「匯出 HTML」相同，公式與流程圖都已轉好）放進主視窗的列印區：
 * Shadow DOM 隔開介面的樣式，畫面上看不到，只在列印時顯示。回傳清除列印區的函式。
 */
async function preparePrint(opts: PdfOptions, title: string): Promise<() => void> {
  const html = await preview.exportDocument(editor.text, kind, title);
  const doc = new DOMParser().parseFromString(html, "text/html");
  await resolvePrintImages(doc);
  if (blockRemote()) blockRemoteImages(doc);
  document.getElementById("print-root")?.remove();
  document.getElementById("print-page")?.remove();
  const host = document.createElement("div");
  host.id = "print-root";
  const shadow = host.attachShadow({ mode: "open" });
  const css = [...doc.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
  // 設定的內文字型與行距（CSS 變數會從主視窗繼承進 Shadow DOM）。
  const docStyle = "article.markdown-body { font-family: var(--font-doc); line-height: var(--doc-line-height, 1.8); }";
  shadow.innerHTML = `<style>${shadowCss(css)}\n${PRINT_ROOT_CSS}\n${docStyle}</style>${opts.cover ? coverHtml(opts, title, isoDate(new Date())) : ""}`;
  const article = doc.querySelector("article.markdown-body");
  if (article) shadow.append(document.importNode(article, true));
  const page = document.createElement("style");
  page.id = "print-page";
  page.textContent = `@media print { ${pageCss(opts)} }`;
  document.head.append(page);
  document.body.append(host);
  document.documentElement.classList.add("printing");
  const images = [...shadow.querySelectorAll("img")].filter((img) => !img.complete);
  await Promise.all(
    images.map(
      (img) =>
        new Promise((resolve) => {
          img.addEventListener("load", resolve);
          img.addEventListener("error", resolve);
        }),
    ),
  );
  await document.fonts?.ready;
  return () => {
    host.remove();
    page.remove();
    document.documentElement.classList.remove("printing");
  };
}

/** 文件中以相對路徑引用的圖片，換成列印區能載入的網址。 */
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
        img.alt = t("{alt}（無法載入）", { alt: img.alt || t("圖片") });
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
  const index = Number(link.dataset.index);
  // 收合的標題底下的子標題看不到，放在它下面就是放在整個章節後面。
  const collapsed = li.querySelector(".outline-toggle[aria-expanded='false']");
  const next = collapsed ? subtreeEnd(outlineHeadings.map((h) => h.level), index) : index + 1;
  return { li, before: after ? next : index, after };
}

// 點大綱的標題：跳到那一段。整個清單共用一個處理（大文件可能有上千個標題）。
outlineList.addEventListener("click", (e) => {
  const toggle = (e.target as Element).closest<HTMLButtonElement>(".outline-toggle");
  if (toggle) {
    toggleOutline(Number(toggle.dataset.index));
    return;
  }
  const a = (e.target as Element).closest<HTMLAnchorElement>("a[data-index]");
  const h = a && outlineHeadings[Number(a.dataset.index)];
  if (!h) return;
  e.preventDefault();
  if (outlineView) {
    viewHeading(h.id)?.scrollIntoView({ block: "start" });
    if (narrowQuery.matches) setOutline(false);
    return;
  }
  if (view !== "preview") editor.reveal(h.line);
  if (previewVisible()) document.getElementById(h.id)?.scrollIntoView({ block: "start" });
  if (narrowQuery.matches) setOutline(false);
});
outlineList.addEventListener("dragstart", (e) => {
  const link = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[data-index]");
  if (!link || kind !== "markdown" || outlineView) return;
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
  // ←／→：收合、展開（已收合或沒有子標題時，← 跳到上一層標題）。
  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    const link = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[data-index]");
    if (!link) return;
    e.preventDefault();
    const index = Number(link.dataset.index);
    if (toggleOutline(index, e.key === "ArrowLeft") || e.key === "ArrowRight") return;
    const level = outlineHeadings[index].level;
    for (let i = index - 1; i >= 0; i--) {
      if (outlineHeadings[i].level < level) {
        outlineList.querySelectorAll<HTMLElement>("a")[i]?.focus();
        break;
      }
    }
    return;
  }
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  const link = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[data-index]");
  if (!link || kind !== "markdown" || outlineView) return;
  e.preventDefault();
  const moved = swapSection(editor.text, outlineHeadings, Number(link.dataset.index), e.key === "ArrowUp" ? -1 : 1);
  if (moved) applySectionMove(moved.text, moved.index, true);
});

/** Wiki、工作項目內容裡的標題（和本機預覽的標題 id 可能一樣，所以只在內容裡找）。 */
function viewHeading(id: string): HTMLElement | null {
  return outlineView?.body?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? null;
}

/** 大綱標示目前閱讀到的段落。 */
function updateActiveHeading(): void {
  const links = [...outlineList.querySelectorAll<HTMLAnchorElement>("a")];
  if (!links.length) return;
  let active: HTMLAnchorElement | undefined;
  if (outlineView) {
    const top = (outlineView.body?.parentElement?.getBoundingClientRect().top ?? 0) + 48;
    for (const a of links) {
      const el = viewHeading(a.dataset.id!);
      if (el && el.getBoundingClientRect().top <= top) active = a;
    }
  } else if (view === "preview") {
    const top = previewScroller.getBoundingClientRect().top + 48;
    for (const a of links) {
      const el = document.getElementById(a.dataset.id!);
      if (el && el.getBoundingClientRect().top <= top) active = a;
    }
  } else {
    for (const a of links) if (Number(a.dataset.line) <= editorTopLine + 1) active = a;
  }
  active ??= links[0];
  // 目前的段落在收合的標題底下時，標示那個收合的標題。
  for (let i = links.indexOf(active); i > 0 && active.parentElement!.hidden; i--) active = links[i - 1];
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
  if (kind === "json") {
    status.stats.textContent = t("{lines} 行 · {chars} 字元", {
      lines: editor.view.state.doc.lines.toLocaleString(),
      chars: editor.text.length.toLocaleString(),
    });
    status.stats.title = "";
    return;
  }
  status.stats.textContent = t("{n} 字", { n: stats.words.toLocaleString() });
  status.stats.title =
    t("{words} 字 · {chars} 字元", { words: stats.words.toLocaleString(), chars: stats.chars.toLocaleString() }) +
    (stats.readingMinutes ? t(" · 約 {n} 分鐘讀完", { n: stats.readingMinutes }) : "");
}

function renderSaveState(): void {
  const dirty = baseline !== editorHash();
  if (active.dirty !== dirty) {
    active.dirty = dirty;
    renderTabs();
  }
  // 只有一份還沒存過的空白文件時，不需要「未命名.md」分頁與標題；開始打字才出現。
  const blank = docs.length === 1 && !fileBacked && !fileHandle && editor.view.state.doc.length === 0;
  $("#tab-bar").classList.toggle("blank", blank);
  editor.setFileName(fileName);
  const title = blank ? "oMarker" : `${dirty ? "● " : ""}${fileName} - oMarker`;
  if (document.title !== title) {
    document.title = title;
    desktop?.setTitle(title).catch(console.error);
  }
  status.save.dataset.state = dirty ? "dirty" : "saved";
  if (!dirty) status.save.textContent = fileBacked ? t("已儲存") : "";
  else status.save.textContent = (fileBacked ? t("尚未存檔") : t("尚未存成檔案")) + (draftSaved ? t(" · 草稿已自動保存") : "");
  // 已儲存時不佔位置；只有需要注意時才顯示。
  status.save.hidden = !dirty;
  status.save.title = dirty ? t("按一下存檔（Ctrl+S）") : "";
  (status.save as HTMLButtonElement).disabled = !dirty;
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
    blocks ??= collectBlocks(previewEl);
    const base = previewScroller.getBoundingClientRect().top - previewScroller.scrollTop;
    const measure = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top - base, bottom: rect.bottom - base };
    };
    previewScroller.scrollTop = blocks.length
      ? offsetForLineLazy(blocks, editorTopLine, measure)
      : // JSON 樹狀檢視沒有行號對應，改用捲動比例。
        (scroller.scrollTop / max) * (previewScroller.scrollHeight - previewScroller.clientHeight);
  }
}

new ResizeObserver(() => {
  blocks = null;
}).observe(previewEl);
let headingFrame = 0;
previewScroller.addEventListener(
  "scroll",
  () => {
    if (view !== "preview" || headingFrame) return;
    headingFrame = requestAnimationFrame(() => {
      headingFrame = 0;
      updateActiveHeading();
    });
  },
  { passive: true },
);

// ---- 自動儲存草稿 -------------------------------------------------------

let saveTimer: number | undefined;
let pendingDraft: { id: string; doc: Text } | null = null;

function scheduleAutosave(doc: Text): void {
  clearTimeout(saveTimer);
  draftSaved = false;
  // 記下是哪個分頁的內容：計時器觸發前可能已經切換到別的分頁。
  pendingDraft = { id: active.id, doc };
  saveTimer = window.setTimeout(flushDraft, 400);
}

// ---- 自動存檔（桌面版、已經存過的檔案） ---------------------------------------

const DISK_SAVE_DELAY = 1500;
let diskSaveTimer = 0;
let saving = false;
/** 自動存檔遇到衝突或錯誤的檔案：使用者手動存檔（Ctrl+S）之前不再自動存。 */
let diskSaveBlocked: string | null = null;

function scheduleDiskSave(): void {
  clearTimeout(diskSaveTimer);
  if (!settings.value.autoSave || !desktop || !fileHandle?.path) return;
  diskSaveTimer = window.setTimeout(() => void autoSaveNow(), DISK_SAVE_DELAY);
}

/**
 * 自動存檔：安靜地存，遇到衝突或錯誤就停下來交給使用者，不打斷打字。
 * 開始時就記下是哪個分頁、哪些內容，存檔期間切換分頁也會存到正確的檔案。
 */
async function autoSaveNow(): Promise<void> {
  clearTimeout(diskSaveTimer);
  diskSaveTimer = 0;
  const doc = active;
  const handle = fileHandle;
  const path = handle?.path;
  if (path && !editor.view.composing) refreshToc();
  const text = editor.text;
  if (!path || !settings.value.autoSave || saving || diskSaveBlocked === path) return;
  if (hash(text) === baseline || doc.missing || doc.unloaded || doc.lossy || review.active || offline?.path === path) return;
  // 注音、倉頡選字中先不存，等組字結束。
  if (editor.view.composing) {
    scheduleDiskSave();
    return;
  }
  saving = true;
  try {
    const out = await saveFile(text, fileName, kind, handle, { saveAs: false, force: false });
    if (!out) return;
    if (out.status === "conflict") {
      diskSaveBlocked = path;
      toast(t("「{name}」被{who}改過，已暫停自動存檔。按 Ctrl+S 比較差異後再存。", { name: out.name, who: otherWriter(path) }), {
        tone: "error",
        duration: 12000,
      });
      return;
    }
    gitPanel?.refreshSoon(300);
    if (doc === active) {
      fileHandle = out.handle;
      setBaseline(text, true);
      renderSaveState();
      renderTabs(); // setBaseline 已經更新了 active.dirty，renderSaveState 不會重畫分頁
      // 存檔期間又打了字：再排一次。
      if (editor.text !== text) scheduleDiskSave();
    } else {
      doc.handle = out.handle;
      doc.baseline = hash(text);
      doc.fileBacked = true;
      doc.dirty = hash(doc.state?.doc.toString() ?? loadDraft(doc.id) ?? "") !== doc.baseline;
      persistSession();
      renderTabs();
    }
  } catch (e) {
    if (isOffline(e)) showOffline(path);
    else {
      diskSaveBlocked = path;
      toast(t("自動存檔失敗，已暫停：{error}", { error: e instanceof Error ? e.message : String(e) }), { tone: "error", duration: 12000 });
    }
  } finally {
    saving = false;
  }
}

/** 立刻寫入尚未儲存的草稿（切換、關閉分頁前呼叫）。 */
function flushDraft(): void {
  clearTimeout(saveTimer);
  if (!pendingDraft) return;
  const { id, doc } = pendingDraft;
  pendingDraft = null;
  if (!docs.some((d) => d.id === id)) return; // 分頁已經關閉
  const text = doc.toString();
  draftSaved = saveDraft(id, text);
  // 儲存空間滿了：先清掉其他「已存檔、沒改過」分頁的草稿（之後從檔案讀回），再試一次。
  if (!draftSaved && freeDraftSpace(id)) draftSaved = saveDraft(id, text);
  if (!draftSaved && !draftWarned) {
    draftWarned = true;
    toast(t("瀏覽器封鎖了儲存空間，草稿無法自動保存，請記得手動存檔。"), { tone: "error" });
  }
  renderSaveState();
}

/** 草稿存不進去的提示只顯示一次（每次停手都跳出來太吵）。 */
let draftWarned = false;

/**
 * 清掉不需要草稿的分頁（桌面版、已存成檔案、沒有未存檔的變更）的草稿，騰出儲存空間。
 * 這些分頁之後切換過去時從檔案讀回內容。有清掉任何草稿就回傳 true。
 */
function freeDraftSpace(keepId: string): boolean {
  if (!desktop) return false;
  let freed = false;
  for (const doc of docs) {
    if (doc.id === keepId || doc === active || doc.dirty || doc.unloaded || !doc.path) continue;
    if (loadDraft(doc.id) === null) continue;
    dropDraft(doc.id);
    // 已經有編輯器狀態的分頁內容還在記憶體裡，不必重新讀檔。
    if (!doc.state) doc.unloaded = true;
    freed = true;
  }
  return freed;
}

// ---- 文件操作 -----------------------------------------------------------

function setFileName(name: string): void {
  fileName = name;
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
  canRename: (id) => {
    const doc = docs.find((d) => d.id === id);
    if (!doc) return false;
    if ((doc === active ? fileHandle : doc.handle) === null) return true;
    toast(t("已經存成檔案的文件，請在「檔案」面板中重新命名（選取後按 F2）。"));
    return false;
  },
  rename: (id, name) => renameDoc(id, name),
  menu: (id, at) => {
    menuTabId = id;
    tabMenu.open(at);
  },
  unpin: (id) => {
    const doc = docs.find((d) => d.id === id);
    if (doc) setPinned(doc, false);
  },
});

// ---- 分頁選單：關閉其他、關閉右側、固定分頁…… ---------------------------------

/** 按右鍵的分頁；從指令面板執行時是目前的分頁。 */
let menuTabId: string | null = null;
const menuTab = (): Doc => docs.find((d) => d.id === menuTabId) ?? active;
const tabPath = (doc: Doc): string | null => (doc === active ? fileHandle?.path : doc.path) ?? null;

/** 固定或取消固定分頁：固定的分頁排在最左邊（依固定的先後）。 */
function setPinned(doc: Doc, pinned: boolean): void {
  doc.pinned = pinned || undefined;
  docs.splice(docs.indexOf(doc), 1);
  const lastPinned = docs.reduce((n, d, i) => (d.pinned ? i + 1 : n), 0);
  docs.splice(lastPinned, 0, doc);
  persistSession();
  renderTabs();
}

/** 依序關閉分頁；使用者在「要儲存變更嗎？」按取消時就停下來。 */
async function closeTabs(list: Doc[]): Promise<void> {
  for (const doc of list) {
    if (!docs.includes(doc)) continue;
    await closeTab(doc.id);
    if (docs.includes(doc)) return;
  }
}

/** 還沒存成檔案的文件改名（存檔時當成預設檔名）。輸入已知的副檔名時順便切換文件類型。 */
function renameDoc(id: string, name: string): void {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  if (doc !== active) {
    doc.name = name;
    persistSession();
    renderTabs();
    return;
  }
  setFileName(name);
  const k = kindFromFileName(name);
  if (isTextFileName(name) && k !== kind) setKind(k, { rename: false });
}

// ---- 側邊欄：檔案、大綱、搜尋 ---------------------------------------------

type SidePanel = "files" | "outline" | "search" | "tasks" | "tags" | "issues" | "ado" | "git";
const SIDE_PANELS: SidePanel[] = ["files", "outline", "search", "tasks", "tags", "issues", "ado", "git"];
const sideTabs = [...document.querySelectorAll<HTMLButtonElement>(".activity-tabs [role=tab]")];
/** 舊版的「工作項目」「Wiki」是兩個面板，現在合成「Azure DevOps」一個面板（裡面再切換）。 */
const LEGACY_ADO_PANELS = ["workitems", "wiki"];
const savedSidePanel = storage.load("side-panel");
let sidePanel: SidePanel =
  SIDE_PANELS.find((p) => p === (LEGACY_ADO_PANELS.includes(savedSidePanel ?? "") ? "ado" : savedSidePanel)) ?? "outline";
/** Azure DevOps 面板目前顯示工作項目還是 Wiki。 */
type AdoTab = "workitems" | "wiki";
let adoTab: AdoTab = (storage.load("ado-panel-tab") ?? savedSidePanel) === "wiki" ? "wiki" : "workitems";
/** 目前開啟的資料夾（工作區）。 */
let workspaceRoot: Folder | null = null;
/** Ctrl+P 用的工作區檔案清單；資料夾內容變動時清掉重抓。 */
let fileListCache: FileItem[] | null = null;
let treeActive: string | null = null;

const DOWNLOAD_URL = "https://github.com/omni624562/markdown/releases/download/latest/omarker.exe";

const fileTree = desktop
  ? new FileTree($("#file-tree"), {
      list: (dir) => desktop!.listDir(dir),
      open: (path) => void openPath(path).catch(reportError),
      action: (action, entry) => void treeAction(action, entry).catch(reportError),
      remote: () => !!workspaceRoot && isRemote(workspaceRoot.path),
      dropFiles: (dir, files) => void uploadFiles(dir, files).catch(reportError),
      expandedChanged: () => {
        if (workspaceRoot && fileTree) saveProjectView(workspaceRoot.path, { expanded: fileTree.expanded });
      },
    })
  : null;

/** 專案（開過的資料夾）：切換器、專案總覽、專案設定。 */
const projectUi = desktop
  ? new ProjectUi(desktop, {
      current: () => workspaceRoot?.path ?? null,
      open: (path) => openRecentFolder(path),
      openFolder: () => void commands.run("open-folder").catch(reportError),
      close: () => void commands.run("close-folder").catch(reportError),
      remotes: () => desktop!.davConnections(),
      openRemote: (c) => void openRemote(c).catch(reportError),
      changed: () => void renderProjectName().then(renderFilesEmpty),
      unsaved: (path) =>
        (peekSession(path)?.docs ?? []).some((m) => m.baseline !== null && draftState(m).dirty),
      repoSources: () => [
        { id: "github", title: t("從 GitHub 下載儲存庫…"), icon: "github", run: () => void github?.openRepo() },
        ...(ado ? [{ id: "ado", title: t("從 Azure DevOps／TFS 下載儲存庫…"), icon: "briefcase-business", run: () => void ado?.openRepo() }] : []),
      ],
    })
  : null;

/** 側邊欄上方與狀態列的專案名稱（自訂名稱與顏色）。 */
async function renderProjectName(): Promise<void> {
  if (workspaceRoot && !isRemote(workspaceRoot.path)) await projectUi?.refresh();
  const project = workspaceRoot ? projectUi?.current : undefined;
  const label = project?.label ?? workspaceRoot?.name ?? t("檔案");
  const color = project?.color ?? null;
  const hint = t("切換專案（{keys}）", { keys: formatKeys("Mod-Alt-p") });
  $("#folder-name").textContent = label;
  const switcher = $(".project-switch");
  switcher.title = workspaceRoot ? `${displayPath(workspaceRoot.path)}\n${hint}` : hint;
  const dot = switcher.querySelector<HTMLElement>(".project-dot")!;
  dot.hidden = !workspaceRoot;
  if (color) dot.dataset.color = color;
  else delete dot.dataset.color;
  // 圖示列最上方的專案方塊：專案的顏色與縮寫；沒有開資料夾時是資料夾圖示。
  const button = $("#activity-project");
  button.hidden = !projectUi;
  const name = workspaceRoot ? label : t("開啟資料夾或切換專案");
  button.title = workspaceRoot ? `${label}\n${displayPath(workspaceRoot.path)}\n${hint}` : `${name}\n${hint}`;
  button.setAttribute("aria-label", name);
  const avatar = button.querySelector<HTMLElement>(".project-avatar")!;
  if (workspaceRoot) avatar.textContent = projectInitials(label);
  else avatar.replaceChildren(icon("folder-open"));
  avatar.classList.toggle("empty", !workspaceRoot);
  if (color) avatar.dataset.color = color;
  else delete avatar.dataset.color;
}

/** 檔案總管上方顯示目前的分支（不是 Git 儲存庫時隱藏）；按一下切換或建立分支。 */
function renderFolderBranch(status: GitStatus | null): void {
  const el = $<HTMLButtonElement>("#folder-branch");
  const name = status?.repo ? status.branch?.name : undefined;
  el.hidden = !name;
  if (!name) return;
  el.querySelector("span")!.textContent = name;
  el.disabled = status!.merging;
  el.title = t("目前的分支：{name}；按一下切換或建立分支", { name });
}
$("#folder-branch").addEventListener("click", () => void switchBranch().catch(reportError));

/** 用 GitHub 帳號同步（桌面版）：登入、從 GitHub 開啟儲存庫、上傳資料夾。 */
const github = desktop
  ? new GitHub(desktop, {
      root: () => workspaceRoot,
      openFolder: async (folder) => {
        await setWorkspace(folder);
        showPanel("files");
      },
      changed: () => {
        void gitPanel?.refresh();
        void renderIssuesTab();
        settingsDialog.refresh();
      },
    })
  : null;

/** Azure DevOps（桌面版）：用個人存取權杖連線、從 ADO 開啟儲存庫或 Wiki、查看工作項目。 */
const ado = desktop
  ? new Ado(desktop, {
      openFolder: async (folder) => {
        await setWorkspace(folder);
        showPanel("files");
      },
      changed: () => {
        renderAdoTab();
        workItemsPanel?.reset();
        wikiPanel?.reset();
        if (sidePanel === "ado") showPanel("ado", false);
        settingsDialog.refresh();
        void gitPanel?.refresh();
      },
      openSettings: () => settingsDialog.open(t("Azure DevOps／TFS")),
    })
  : null;

/** 在主要區域開啟工作項目；內容裡的相關工作項目點一下在這裡切換。 */
function showWorkItem(item: AdoWorkItem): void {
  let related = new Map<number, AdoWorkItem>();
  void showIssue({
    key: `ado:${item.id}`,
    origin: { kind: "ado", icon: "square-kanban", text: t("Azure DevOps 工作項目") },
    label: `${item.kind} ${item.id}`,
    title: item.title,
    webUrl: item.webUrl,
    fileName: issueFileName(`${item.kind} ${item.id}`, item.title),
    load: async () => {
      const d = await desktop!.adoWorkItem(item.id);
      related = new Map(d.relations.map((r) => [r.id, r]));
      return workItemMarkdown(d);
    },
    insertLink: () => insertIssueLink(item),
    link: (href) => {
      const id = workItemIdOf(href);
      const target = id === null ? undefined : related.get(id);
      if (!target) return false;
      showWorkItem(target);
      return true;
    },
  });
}

/** 插入 `[#123 標題](網址)` 到游標位置。 */
function insertIssueLink(item: Pick<IssueSummary, "id" | "title" | "webUrl">): void {
  insertAtCursor(workItemLink(item));
  toast(t("已插入「#{id}」的連結", { id: item.id }));
}

// ---- 工作項目、GitHub issue：開在主要區域的唯讀檢視 ------------------------------

/** 工作項目內文裡的圖片放在 Azure DevOps 伺服器上，要帶權杖才讀得到：改由原生端讀取。 */
const adoImagesPlugin: PreviewPlugin = {
  name: "ado-images",
  prepare(content) {
    const base = ado?.account?.url;
    if (!base) return;
    const origin = (u: string) => {
      try {
        return new URL(u).origin;
      } catch {
        return null;
      }
    };
    for (const img of content.querySelectorAll<HTMLImageElement>("img[src]")) {
      const src = img.getAttribute("src")!;
      if (origin(src) !== origin(base)) continue;
      img.dataset.adoSrc = src;
      img.removeAttribute("src");
    }
  },
  apply(_root, scope) {
    for (const img of scope.querySelectorAll<HTMLImageElement>("img[data-ado-src]")) {
      void desktop!
        .adoImage(img.dataset.adoSrc!)
        .then((url) => (img.src = url))
        .catch((e) => (img.title = e instanceof Error ? e.message : String(e)));
    }
  },
};

/** 主要區域開著的 Wiki 頁面（圖片的相對路徑以它為準）。 */
let wikiPage: { wiki: AdoWiki; path: string } | null = null;

/** Wiki 裡的圖片放在 Wiki 的 Git 儲存庫裡，要帶權杖才讀得到：改由原生端讀取；` =300x` 的大小也套用上去。 */
const wikiImagesPlugin: PreviewPlugin = {
  name: "wiki-images",
  prepare(content) {
    if (!wikiPage) return;
    for (const img of content.querySelectorAll<HTMLImageElement>("img")) {
      const size = imageSize(img.alt);
      if (size.width) {
        img.alt = size.alt;
        img.width = size.width;
        if (size.height) img.height = size.height;
      }
      const src = img.getAttribute("src");
      const path = src && imageRepoPath(src, wikiPage.path, wikiPage.wiki.mappedPath);
      if (!path) continue;
      img.dataset.wikiSrc = path;
      img.removeAttribute("src");
    }
  },
  apply(_root, scope) {
    const page = wikiPage;
    if (!page) return;
    for (const img of scope.querySelectorAll<HTMLImageElement>("img[data-wiki-src]")) {
      void desktop!
        .adoWikiImage(page.wiki, img.dataset.wikiSrc!)
        .then((url) => (img.src = url))
        .catch((e) => (img.title = e instanceof Error ? e.message : String(e)));
    }
  },
};

/** 開啟工作項目、issue、Wiki 頁面（Git 歷史開著時先關掉）。 */
function showIssue(source: IssueSource): Promise<void> {
  historyView?.close();
  return issueView.show(source);
}

/** 在主要區域開啟 Wiki 頁面；內容裡連到其他頁面的連結直接在這裡切換。 */
function showWikiPage(wiki: AdoWiki, path: string): void {
  let webUrl = wiki.webUrl ?? "";
  const title = pageName(path);
  void showIssue({
    key: `wiki:${wiki.id}:${path}`,
    origin: { kind: "wiki", icon: "book-open-text", text: "Azure DevOps Wiki" },
    label: wiki.name,
    title,
    get webUrl() {
      return webUrl;
    },
    fileName: issueFileName(wiki.name, title),
    load: async () => {
      const page = await desktop!.adoWikiPage(wiki, path);
      webUrl = page.webUrl ?? webUrl;
      wikiPage = { wiki, path };
      return wikiMarkdown(page.content);
    },
    insertLink: () => {
      insertAtCursor(wikiPageLink(title, webUrl));
      toast(t("已插入「{name}」的連結", { name: title }));
    },
    link: (href) => {
      const target = resolvePageLink(href, path, flattenPages(wikiPanel?.pages ?? []));
      if (!target) return false;
      wikiPanel?.select(target);
      showWikiPage(wiki, target);
      return true;
    },
  });
}

let issuePreview: Preview | null = null;
/** 主題或流程圖、數學式設定改變時，重畫開著的工作項目、Wiki 頁面。 */
function rerenderIssue(): void {
  issuePreview?.clear();
  issueView.rerender();
}
/** 工作項目、Wiki、Issue 和編輯區並排顯示（不蓋住正在寫的文件）；記住上次的選擇。 */
let issueSide = storage.load("issue-side") === "1";

const issueView = new IssueView($(".workspace"), {
  render(markdown, into) {
    issuePreview ??= new Preview(into, [
      highlightPlugin(),
      // Wiki 常用流程圖與數學式：和本機預覽一樣畫出來（依同樣的設定）。
      mathPlugin(() => settings.value.math),
      mermaidPlugin(() => settings.value.mermaid, { open: (svg) => openDiagram(svg), copy: (svg) => void copyDiagram(svg) }),
      tablesPlugin(),
      adoImagesPlugin,
      wikiImagesPlugin,
      {
        name: "remote-images",
        apply() {},
        prepare(content) {
          if (settings.value.blockRemoteImages) blockRemoteImages(content);
        },
      },
    ]);
    const result = issuePreview.update(markdown, "markdown");
    // 大綱改列這一頁的標題；捲動內容時標示目前讀到的段落。
    if (outlineView) {
      outlineView = { ...outlineView, headings: result.headings, body: into };
      renderOutline(result.headings);
      updateActiveHeading();
    }
    if (!into.dataset.outlineScroll) {
      into.dataset.outlineScroll = "1";
      into.parentElement?.addEventListener("scroll", () => outlineView && updateActiveHeading(), { passive: true });
    }
  },
  open: (url) => void desktop?.openExternal(url).catch(reportError),
  copyAsDocument(name, markdown) {
    issueView.close();
    const doc = makeDoc({ name, kind: "markdown", baseline: hash("") });
    saveDraft(doc.id, markdown);
    addTab(doc);
    toast(t("已複製成新的 Markdown 分頁，修改不會回寫到伺服器"));
  },
  opened(source) {
    outlineView = { key: source.key, headings: [], body: null };
    renderOutline([]);
    // Wiki 頁面讀到內容時才設定（圖片的相對路徑以它為準）。
    wikiPage = null;
    const [kind, id, ...rest] = source.key.split(":");
    workItemsPanel?.select(kind === "ado" ? Number(id) : null);
    issuesPanel?.select(kind === "github" ? Number(id) : null);
    wikiPanel?.select(kind === "wiki" && wikiPanel.wiki?.id === id ? rest.join(":") : null);
  },
  toggleSide() {
    issueSide = !issueSide;
    storage.save("issue-side", issueSide ? "1" : "");
    issueView.setSide(issueSide);
    applyLayout();
    toast(issueSide ? t("已改成和編輯區並排顯示") : t("已改回蓋住編輯區顯示"));
  },
  closed() {
    wikiPage = null;
    outlineView = null;
    renderOutline(docHeadings);
    updateActiveHeading();
    workItemsPanel?.select(null);
    issuesPanel?.select(null);
    wikiPanel?.select(null);
  },
});

// ---- 狀態列：開著 Wiki、工作項目、Git 歷史時，顯示正在看什麼，藏起只跟本機文件有關的項目 ----

const statusView = $("#status-view");
const issuePane = $(".issue-pane:not(.history-pane)");

function renderStatusView(): void {
  // 並排顯示時編輯區還在，狀態列照常顯示文件的資訊。
  const issueOpen = workspace.classList.contains("issue-open") && !workspace.classList.contains("issue-side");
  const historyOpen = workspace.classList.contains("history-open");
  const viewing = issueOpen || historyOpen;
  $(".statusbar").classList.toggle("viewing", viewing);
  statusView.hidden = !viewing;
  if (!viewing) return;
  const source = historyOpen ? "git" : (issuePane.dataset.source ?? "");
  const names: Record<string, string> = {
    wiki: "Azure DevOps Wiki",
    ado: t("Azure DevOps 工作項目"),
    github: "GitHub Issue",
    git: t("Git 歷史"),
  };
  const label = document.createElement("span");
  label.className = "status-view-label";
  label.append(
    icon(source === "git" ? "git-branch" : "lock"),
    source === "git" ? names.git : t("{name}・唯讀", { name: names[source] ?? "" }),
  );
  const back = document.createElement("button");
  back.type = "button";
  back.className = "status-btn";
  back.append(icon("arrow-left"), t("回到文件"));
  back.title = t("關閉這個畫面，回到編輯中的文件（Esc）");
  back.addEventListener("click", () => {
    issueView.close();
    historyView?.close();
  });
  statusView.replaceChildren(label, back);
}
new MutationObserver(renderStatusView).observe(workspace, { attributes: true, attributeFilter: ["class"] });
issueView.setSide(issueSide);
// 並排顯示時，檢視打開或關閉要重新排版（編輯區讓出右半邊）。
let issueWasOpen = false;
new MutationObserver(() => {
  const open = workspace.classList.contains("issue-open");
  if (open === issueWasOpen) return;
  issueWasOpen = open;
  if (issueSide) applyLayout();
}).observe(workspace, { attributes: true, attributeFilter: ["class"] });
new MutationObserver(renderStatusView).observe(issuePane, { attributes: true, attributeFilter: ["data-source"] });

/** 工作項目的篩選條件（記住上次的選擇）。 */
const DEFAULT_WORK_ITEM_FILTER: AdoWorkItemFilter = {
  role: "assigned",
  person: "@me",
  state: "open",
  kind: null,
  project: null,
  area: null,
};
const workItemFilter: AdoWorkItemFilter = (() => {
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  try {
    const v = JSON.parse(storage.load("workitem-filter") ?? "{}") as Partial<AdoWorkItemFilter>;
    const project = text(v.project);
    return {
      role: v.role === "created" ? "created" : "assigned",
      person: typeof v.person === "string" ? v.person : "@me",
      state: v.state === "closed" || v.state === "all" ? v.state : "open",
      kind: text(v.kind),
      project,
      area: project ? text(v.area) : null,
    };
  } catch {
    return { ...DEFAULT_WORK_ITEM_FILTER };
  }
})();
const isDefaultFilter = () =>
  workItemFilter.role === "assigned" &&
  workItemFilter.person === "@me" &&
  workItemFilter.state === "open" &&
  !workItemFilter.kind &&
  !workItemFilter.project &&
  !workItemFilter.area;
/** 清單上要不要顯示指派給誰（只看自己的就不必）。 */
const showAssignee = () => !(workItemFilter.role === "assigned" && workItemFilter.person === "@me");

/** 讀取篩選列的選項（第一次列出工作項目時）。 */
let loadWorkItemFilterOptions = (): void => {};

/**
 * 工作項目的篩選列：人（指派給、建立者）、狀態、類型、專案、區域。
 * 選項第一次列出工作項目時才讀取；區域只在選了專案後出現，人名是團隊成員的建議（也可以自己輸入）。
 * 平常收起來，按搜尋框右邊的「篩選」按鈕展開；按鈕上的數字是改過幾項條件。
 */
function workItemFilterBar(): { bar: HTMLElement; button: HTMLButtonElement } {
  const bar = document.createElement("div");
  bar.className = "workitems-filters";
  bar.id = "workitem-filters";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "workitems-filter-toggle";
  button.setAttribute("aria-controls", bar.id);
  const badge = document.createElement("span");
  badge.className = "workitems-filter-count";
  button.append(icon("sliders-horizontal"), badge);
  const setOpen = (open: boolean) => {
    bar.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    storage.save("workitem-filter-open", open ? "1" : "");
  };
  button.addEventListener("click", () => setOpen(bar.hidden));
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn btn-small workitems-filter-reset";
  reset.textContent = t("清除篩選");
  const updateBadge = () => {
    const n = [
      !(f.role === "assigned" && f.person === "@me"),
      f.state !== "open",
      !!f.kind,
      !!f.project,
      !!f.area,
    ].filter(Boolean).length;
    badge.textContent = n ? String(n) : "";
    badge.hidden = !n;
    reset.hidden = !n;
    button.classList.toggle("active", n > 0);
    const label = n ? t("篩選（已設定 {n} 項）", { n }) : t("篩選");
    button.title = label;
    button.setAttribute("aria-label", label);
  };
  const changed = () => {
    storage.save("workitem-filter", JSON.stringify(workItemFilter));
    updateBadge();
    void workItemsPanel?.refresh();
  };
  const select = (label: string, options: [string, string][], value: string, change: (v: string) => void) => {
    const sel = document.createElement("select");
    sel.className = "workitems-select";
    sel.setAttribute("aria-label", label);
    sel.title = label;
    for (const [v, text] of options) sel.append(new Option(text, v, false, v === value));
    sel.addEventListener("change", () => {
      change(sel.value);
      changed();
    });
    return sel;
  };
  const fill = (sel: HTMLSelectElement, values: [string, string][], current: string | null) => {
    sel.length = 1;
    for (const [v, text] of values) sel.append(new Option(text, v, false, v === current));
    if (current && !values.some(([v]) => v === current)) sel.append(new Option(current, current, true, true));
    sel.value = current ?? "";
  };
  const pairs = (values: string[]): [string, string][] => values.map((v) => [v, v]);

  // 人：指派給我、我建立的、所有人，或指定某個人（輸入名字）。
  const f = workItemFilter;
  const personValue = f.person === "@me" ? `${f.role}:@me` : f.person ? `${f.role}:` : "any";
  const name = document.createElement("input");
  name.type = "search";
  name.className = "workitems-person";
  name.value = f.person === "@me" ? "" : f.person;
  name.placeholder = t("輸入名字（部分即可）");
  name.setAttribute("aria-label", t("名字"));
  name.setAttribute("list", "workitem-people");
  name.hidden = !personValue.endsWith(":");
  const people = document.createElement("datalist");
  people.id = "workitem-people";
  let timer = 0;
  name.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (f.person === name.value.trim()) return;
      f.person = name.value.trim();
      changed();
    }, 500);
  });
  const person = select(
    t("人"),
    [
      ["assigned:@me", t("指派給我")],
      ["created:@me", t("我建立的")],
      ["any", t("所有人")],
      ["assigned:", t("指派給…")],
      ["created:", t("建立者是…")],
    ],
    personValue,
    (v) => {
      clearTimeout(timer);
      const [role, who] = v === "any" ? ["assigned", ""] : v.split(":");
      f.role = role as AdoWorkItemFilter["role"];
      name.hidden = !v.endsWith(":");
      f.person = who === "@me" ? "@me" : name.hidden ? "" : name.value.trim();
      if (!name.hidden) name.focus();
    },
  );
  const state = select(
    t("狀態"),
    [["open", t("進行中")], ["closed", t("已結束")], ["all", t("全部狀態")]],
    f.state,
    (v) => (f.state = v as AdoWorkItemFilter["state"]),
  );
  const kind = select(t("類型"), [["", t("所有類型")]], "", (v) => (f.kind = v || null));
  const area = select(t("區域"), [["", t("所有區域")]], "", (v) => (f.area = v || null));
  area.classList.add("workitems-area");
  const project = select(t("專案"), [["", t("所有專案")]], "", (v) => {
    f.project = v || null;
    f.area = null;
    loadScope();
  });
  // 還沒讀到選項前，先放上目前選的值，免得顯示成「所有類型」。
  fill(kind, f.kind ? [[f.kind, f.kind]] : [], f.kind);
  fill(project, f.project ? [[f.project, f.project]] : [], f.project);
  fill(area, [], f.area);
  area.hidden = !f.project;

  /** 區域（選了專案時）與人名建議；同一個專案只讀一次。 */
  const scopes = new Map<string, Promise<{ areas: string[]; people: string[] }>>();
  const loadScope = () => {
    const key = f.project ?? "";
    area.hidden = !key;
    fill(area, [], f.area);
    if (!desktop) return;
    let p = scopes.get(key);
    if (!p) {
      p = desktop.adoWorkItemScope(f.project);
      scopes.set(key, p);
      p.catch(() => scopes.delete(key));
    }
    void p
      .then(({ areas, people: names }) => {
        if ((f.project ?? "") !== key) return;
        // 區域路徑的第一層是專案本身，顯示時省略。
        fill(area, areas.map((a) => [a, a.slice(key.length + 1)]), f.area);
        people.replaceChildren(...names.map((n) => new Option(n)));
      })
      .catch(() => {});
  };
  let loaded = false;
  loadWorkItemFilterOptions = () => {
    if (loaded || !desktop) return;
    loaded = true;
    loadScope();
    void desktop
      .adoWorkItemFilters()
      .then(({ projects, kinds }) => {
        fill(kind, pairs(kinds), f.kind);
        fill(project, pairs(projects), f.project);
      })
      .catch(() => (loaded = false));
  };
  reset.addEventListener("click", () => {
    clearTimeout(timer);
    Object.assign(f, DEFAULT_WORK_ITEM_FILTER);
    person.value = "assigned:@me";
    name.hidden = true;
    name.value = "";
    state.value = "open";
    kind.value = "";
    project.value = "";
    loadScope();
    changed();
  });
  bar.append(person, state, name, kind, project, area, people, reset);
  updateBadge();
  setOpen(storage.load("workitem-filter-open") === "1");
  return { bar, button };
}

const workItemsPanel = desktop
  ? new IssuesPanel<AdoWorkItem & IssueSummary>($("#workitems-host"), {
      placeholder: t("搜尋標題或內容，或輸入編號"),
      link: (item) => workItemLink(item),
      ...(() => {
        const { bar, button } = workItemFilterBar();
        return { filters: bar, filterButton: button };
      })(),
      list: async (search) => {
        loadWorkItemFilterOptions();
        return (await desktop!.adoWorkItems(search, workItemFilter)).map((w) => ({
          ...w,
          meta: [`${w.kind} ${w.id}`, w.state, showAssignee() ? w.assignedTo : "", shortDate(w.changed)]
            .filter(Boolean)
            .join("・"),
        }));
      },
      view: (item) => showWorkItem(item),
      status: (n, search) =>
        n
          ? search
            ? t("找到 {n} 個工作項目", { n })
            : isDefaultFilter()
              ? t("指派給你、還沒結束的工作項目（{n}）", { n })
              : t("符合篩選條件的工作項目（{n}）", { n })
          : search
            ? t("找不到符合的工作項目")
            : isDefaultFilter()
              ? t("目前沒有指派給你、還沒結束的工作項目")
              : t("沒有符合篩選條件的工作項目"),
    })
  : null;

/** Azure DevOps 的 Wiki：選一個 Wiki，看頁面樹狀目錄，點頁面在主要區域開啟（唯讀）。 */
const wikiPanel = desktop
  ? new WikiPanel<AdoWiki>($("#wiki-host"), {
      wikis: () => desktop!.adoWikis(),
      pages: (wiki) => desktop!.adoWikiPages(wiki),
      open: (wiki, path) => showWikiPage(wiki, path),
      load: () => storage.load("ado-wiki"),
      save: (id) => storage.save("ado-wiki", id),
      prefs(id) {
        const paths = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : []);
        try {
          const v = JSON.parse(storage.load(`ado-wiki-pages:${id}`) ?? "{}") as Record<string, unknown>;
          return { recent: paths(v.recent), pinned: paths(v.pinned) };
        } catch {
          return { recent: [], pinned: [] };
        }
      },
      savePrefs: (id, prefs) => storage.save(`ado-wiki-pages:${id}`, JSON.stringify(prefs)),
      link: (wiki, path) => (wiki.webUrl ? wikiPageLink(pageName(path), wikiPageUrl(wiki.webUrl, path)) : null),
    })
  : null;

/** GitHub Issues：目前開啟的資料夾連到 GitHub、而且已經登入時才顯示。 */
const issuesPanel = desktop
  ? new IssuesPanel($("#issues-host"), {
      placeholder: t("搜尋 issue，或輸入編號"),
      link: (item) => workItemLink(item),
      list: async (search) =>
        (await desktop!.githubIssues(search)).map((i) => ({
          ...i,
          id: i.number,
          meta: [
            `#${i.number}`,
            i.state === "closed" ? t("已關閉") : "",
            i.labels.join(t("、")),
            i.comments ? t("{n} 則留言", { n: i.comments }) : "",
            shortDate(i.updated),
          ]
            .filter(Boolean)
            .join("・"),
        })),
      view: (item) =>
        void showIssue({
          key: `github:${item.id}`,
          origin: { kind: "github", icon: "circle-dot", text: "GitHub Issue" },
          label: `#${item.id}`,
          title: item.title,
          webUrl: item.webUrl,
          fileName: issueFileName(`#${item.id}`, item.title),
          load: async () => githubIssueMarkdown(await desktop!.githubIssue(item.id)),
          insertLink: () => insertIssueLink(item),
        }),
      status: (n, search) =>
        n
          ? search
            ? t("找到 {n} 個 issue", { n })
            : t("還沒關閉的 issue（{n}）", { n })
          : search
            ? t("找不到符合的 issue")
            : t("目前沒有還沒關閉的 issue"),
    })
  : null;

let issuesRepo: string | null = null;
async function renderIssuesTab(): Promise<void> {
  const repo = desktop && github?.account ? await desktop.githubWorkspaceRepo().catch(() => null) : null;
  if (repo !== issuesRepo) {
    issuesRepo = repo;
    issuesPanel?.reset();
    if (sidePanel === "issues" && repo) issuesPanel?.shown();
  }
  const tab = $("#side-tab-issues");
  tab.hidden = !repo;
  tab.title = repo ? t("Issues（{repo}）", { repo }) : "Issues";
  if (tab.hidden) panelUnavailable("issues");
  else panelAvailable("issues");
}
$("#issues-refresh").addEventListener("click", () => void issuesPanel?.refresh());

/** 連線到 Azure DevOps 後才顯示「Azure DevOps」圖示（裡面切換工作項目與 Wiki）。 */
function renderAdoTab(): void {
  const tab = $("#side-tab-ado");
  tab.hidden = !ado?.account;
  if (tab.hidden) panelUnavailable("ado");
  else panelAvailable("ado");
}

/** 切換 Azure DevOps 面板裡的工作項目／Wiki（面板開著時才讀取內容）。 */
function setAdoTab(tab: AdoTab): void {
  adoTab = tab;
  storage.save("ado-panel-tab", tab);
  $("#workitems-host").hidden = tab !== "workitems";
  $("#wiki-host").hidden = tab !== "wiki";
  for (const b of document.querySelectorAll<HTMLElement>(".ado-switch [data-ado]")) {
    b.setAttribute("aria-checked", String(b.dataset.ado === tab));
  }
  if (sidePanel === "ado") (tab === "wiki" ? wikiPanel : workItemsPanel)?.shown();
}

/** 打開 Azure DevOps 面板的工作項目或 Wiki。 */
function showAdo(tab: AdoTab): void {
  setAdoTab(tab);
  showPanel("ado");
}

for (const b of document.querySelectorAll<HTMLElement>(".ado-switch [data-ado]")) {
  b.addEventListener("click", () => setAdoTab(b.dataset.ado === "wiki" ? "wiki" : "workitems"));
}
setAdoTab(adoTab);
$("#ado-refresh").addEventListener("click", () => void (adoTab === "wiki" ? wikiPanel : workItemsPanel)?.refresh());

/**
 * 網路恢復或切回視窗時，重新讀取上次失敗的工作項目、Wiki、Issues 與開著的內容
 * （面板沒開著的，下次打開時本來就會重讀）。
 */
let lastAutoRetry = 0;
function retryRemoteLoads(force = false): void {
  const now = Date.now();
  if (!force && now - lastAutoRetry < 10_000) return;
  lastAutoRetry = now;
  if (sidePanel === "ado") (adoTab === "wiki" ? wikiPanel : workItemsPanel)?.retryFailed();
  if (sidePanel === "issues") issuesPanel?.retryFailed();
  issueView.retryFailed();
}
window.addEventListener("online", () => retryRemoteLoads(true));
window.addEventListener("focus", () => retryRemoteLoads());

// 登入過期、權杖失效的錯誤通知：直接附上重新登入的按鈕。
setErrorAction((message) => {
  const problem = authProblem(message);
  if (problem === "github" && github) return { label: t("重新登入 GitHub"), primary: true, run: () => void github.login() };
  if (problem === "ado" && ado) return { label: t("開啟連線設定"), primary: true, run: () => settingsDialog.open(t("Azure DevOps／TFS")) };
  return undefined;
});

const gitPanel =
  desktop && fileTree && github
    ? new GitPanel($("#git-host"), desktop, settings, fileTree, github, {
        root: () => workspaceRoot?.path ?? null,
        open: (path) => void openPath(path).catch(reportError),
        resolve: (path, theirs) => void resolveMergeConflict(path, theirs).catch(reportError),
        switchBranch: () => void switchBranch().catch(reportError),
        createPr: () => void createPullRequest().catch(reportError),
        history: () => void openGitHistory().catch(reportError),
        openAdo: ado ? () => void ado!.openRepo() : null,
        changed: (status) => {
          // 提交、切換分支、拉取之後，開著的 Git 歷史跟著更新。
          const b = status?.branch;
          const key = status?.repo ? `${b?.name}|${b?.ahead}|${b?.behind}|${status.changes.length}|${status.merging}` : "";
          if (key !== gitHistoryKey) {
            gitHistoryKey = key;
            historyView?.refresh();
          }
          refreshActivityCommands();
          renderFolderBranch(status);
          // Git 內建在程式裡：圖示一直顯示，還沒同步的資料夾點進去會引導上傳到 GitHub。
          const tab = $("#side-tab-git");
          tab.hidden = false;
          panelAvailable("git");
          const count = status?.repo ? status.changes.length : 0;
          const badge = $("#git-badge");
          badge.hidden = !count;
          badge.textContent = count > 99 ? "99+" : String(count);
          tab.setAttribute("aria-label", count ? t("原始碼控制（Git），{n} 個變更", { n: count }) : t("原始碼控制（Git）"));
          const label = tab.getAttribute("aria-label")!;
          tab.title = tab.dataset.keys ? t("{label}（{keys}）", { label, keys: tab.dataset.keys }) : label;
        },
      })
    : null;

// ---- Git 歷史（線圖） -----------------------------------------------------

let historyView: GitHistory | null = null;
/** 上次的 Git 狀態摘要（變了才重新載入歷史）。 */
let gitHistoryKey = "";

/** Git 歷史第一次開啟時才載入。 */
async function gitHistory(): Promise<GitHistory | null> {
  if (!desktop || !gitPanel) return null;
  if (historyView) return historyView;
  const { GitHistory } = await import("./ui/history-view.ts");
  const panel = gitPanel;
  historyView = new GitHistory($(".workspace"), desktop, {
    status: () => panel.status,
    hasUnsaved: () => docs.some((d) => d.dirty),
    async openFile(path) {
      historyView?.close();
      await openPath(path);
    },
    async compareWithCurrent(path, c) {
      await openPath(path);
      await compareWithCommit({ ...c, author: "", time: 0, path });
    },
    openUrl: (url) => void desktop!.openExternal(url).catch(reportError),
    resolveConflicts(conflicts) {
      showPanel("git");
      panel.resolveConflicts(conflicts);
    },
    async changed() {
      await panel.refresh();
      await fileTree?.refresh();
    },
    pull: () => panel.pull(),
    push: () => panel.push(),
    commit() {
      historyView?.close();
      showPanel("git");
      panel.focusMessage();
    },
    closed: () => {
      markHistoryButtons();
      editor.view.focus();
    },
  });
  return historyView;
}

/** 開啟 Git 歷史的指令：釘在圖示列上時，再按一次就關閉。 */
const HISTORY_COMMANDS = ["git-history", "git-file-history"];

/** 圖示列上的 Git 歷史按鈕在歷史開著時顯示成按下的樣子。 */
function markHistoryButtons(): void {
  const open = !!historyView?.isOpen;
  for (const id of HISTORY_COMMANDS) {
    for (const b of document.querySelectorAll<HTMLElement>(`.activity-cmd[data-command="${id}"]`)) {
      b.setAttribute("aria-pressed", String(open));
    }
  }
}

/** 開啟 Git 歷史；`path` 是檔案時只列出改過它的提交。 */
async function openGitHistory(path: string | null = null): Promise<void> {
  const view = await gitHistory();
  if (!view) return;
  issueView.close();
  await view.open({ path });
  markHistoryButtons();
}

const searchPanel = desktop
  ? new SearchPanel($("#search-host"), {
      search: (query, caseSensitive, regex) =>
        workspaceRoot
          ? desktop!.search(query, caseSensitive, regex, workspaceRoot.path)
          : Promise.reject(new Error(t("還沒有開啟資料夾"))),
      open: (path, line, column) => void openPath(path, line, column).catch(reportError),
      async replace(query, replacement, caseSensitive, regex) {
        if (!workspaceRoot) throw new Error(t("還沒有開啟資料夾"));
        stash();
        // 有未存檔變更的分頁不碰，避免蓋掉使用者還沒存的內容。
        const skip = docs.filter((d) => (d === active ? baseline !== hash(editor.text) : d.dirty)).flatMap((d) => docPath(d) ?? []);
        const r = await desktop!.replaceInFolder(query, replacement, caseSensitive, regex, skip, workspaceRoot.path);
        fileListCache = null;
        gitPanel?.refreshSoon(300);
        return r;
      },
    })
  : null;

// ---- 資料夾文件索引：待辦總覽、標籤、反向連結 ----------------------------------

// 從其他程式切回來時，資料夾中的檔案可能改過了（其他程式直接改寫檔案時不一定有變動通知）。
// 重新掃描整個資料夾在網路磁碟上很慢，一分鐘內最多一次。
let indexScannedAt = 0;
window.addEventListener("focus", () => {
  if (Date.now() - indexScannedAt < 60_000) return;
  indexStale = true;
  refreshIndexPanels(200);
});

/** 文件中的待辦、標籤與連結（截止日沒寫年份就是今年）。 */
const docInfo = (text: string) => parseDoc(text, new Date().getFullYear());

const docIndex = new WorkspaceIndex(
  (known, root) => desktop!.scanDocs(known, root),
  (paths) => desktop!.readDocs(paths),
  docInfo,
);

/** 已開啟的 Markdown 分頁（以編輯器中的內容為準）。 */
function openDocsForIndex(): OpenDoc[] {
  return docs
    .filter((d) => (d === active ? kind : d.kind) === "markdown")
    .map((d) => ({
      id: d.id,
      path: docPath(d),
      name: d === active ? fileName : d.name,
      text: d === active ? editor.text : (d.state?.doc.toString() ?? loadDraft(d.id) ?? ""),
    }));
}

/** 資料夾（本機）中的所有文件加上已開啟的分頁；網頁版與遠端資料夾只有已開啟的分頁。 */
async function indexedDocs(): Promise<IndexedDoc[]> {
  const root = desktop && workspaceRoot && !isRemote(workspaceRoot.path) ? workspaceRoot.path : null;
  if (indexStale || !root) {
    indexStale = false;
    indexScannedAt = Date.now();
    await docIndex.refresh(root).catch((e) => {
      indexStale = true;
      throw e;
    });
  }
  return docIndex.docs(openDocsForIndex());
}

function indexScope(): string {
  if (desktop && workspaceRoot && !isRemote(workspaceRoot.path)) return "folder";
  return "tabs";
}

const tasksPanel = new TasksPanel($("#tasks-host"), {
  docs: indexedDocs,
  open: (doc, line) => openIndexed(doc, line),
  async toggle(item, done) {
    const tab = tabOfIndexed(item.doc);
    if (tab) {
      if (tab !== active) activate(tab);
      const doc = editor.view.state.doc;
      if (item.line > doc.lines) throw new Error(t("這一行已經不是待辦了，請重新整理"));
      const line = doc.line(item.line);
      const next = setTaskLine(line.text, done);
      if (next === null) throw new Error(t("這一行已經不是待辦了，請重新整理"));
      editor.view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, userEvent: "input.task" });
      return;
    }
    const path = item.doc.path!;
    const text = await docIndex.text(item.doc);
    // 索引之後檔案可能被改過：那一行還是同一個待辦才勾選。
    const now = docInfo(text).tasks.find((x) => x.line === item.line);
    const next = now?.text === item.text ? setTaskDone(text, item.line, done) : null;
    if (next === null) throw new Error(t("這一行已經不是待辦了，請重新整理"));
    await desktop!.updateDoc(path, text, next);
    docIndex.remember(path, next);
  },
  emptyHint: () =>
    indexScope() === "folder"
      ? t("資料夾中沒有待辦事項。在文件中寫「- [ ] 要做的事」就會列在這裡，可以加上 @負責人 與截止日（例如 10/25）。")
      : desktop && !workspaceRoot
        ? t("開啟資料夾後，這裡會列出資料夾中所有文件的待辦；目前只看已開啟的分頁。")
        : t("這裡會列出已開啟分頁中的待辦。在文件中寫「- [ ] 要做的事」就會列在這裡，可以加上 @負責人 與截止日（例如 10/25）。"),
});
$("#tasks-refresh").addEventListener("click", () => {
  indexStale = true;
  void tasksPanel.refresh();
});

const tagsPanel = new TagsPanel($("#tags-host"), {
  docs: indexedDocs,
  open: (doc, line) => openIndexed(doc, line),
  text: (doc) => docIndex.text(doc),
  emptyHint: () =>
    indexScope() === "folder"
      ? t("資料夾中還沒有標籤。在文件中寫 #專案A、#KR2 這樣的標籤，就能在這裡依標籤找文件。")
      : t("這裡會列出已開啟分頁中的標籤；開啟資料夾後會列出資料夾中所有文件的標籤。"),
});
$("#tags-refresh").addEventListener("click", () => {
  indexStale = true;
  void tagsPanel.refresh();
});

/** 列出有這個標籤的文件。 */
function openTag(tag: string): void {
  showPanel("tags");
  void tagsPanel.select(tag);
}

let backlinksSeq = 0;
/** 大綱面板下方的反向連結：哪些文件連到目前的文件。 */
async function renderBacklinks(): Promise<void> {
  const el = $("#backlinks");
  const path = fileHandle?.path;
  const seq = ++backlinksSeq;
  if (!path || kind !== "markdown" || indexScope() !== "folder") {
    el.hidden = true;
    return;
  }
  const docsNow = await indexedDocs().catch(() => null);
  if (!docsNow || seq !== backlinksSeq) return;
  fileListCache ??= await desktop!.listFiles(workspaceRoot!.path).catch(() => []);
  const list = backlinks(path, docsNow, markdownFiles(fileListCache));
  // 摘要要用到那一行的內容：只讀連過來的這幾份。
  const texts = await docIndex.texts(list.map((b) => b.doc)).catch(() => list.map(() => ""));
  if (seq !== backlinksSeq) return;
  el.hidden = false;
  el.replaceChildren();
  const h = document.createElement("h3");
  h.textContent = list.length ? t("反向連結（{n}）", { n: list.length }) : t("反向連結");
  el.append(h);
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "outline-empty";
    p.textContent = t("還沒有其他文件連到這裡。在別的文件中輸入 [[ 就能連過來。");
    el.append(p);
    return;
  }
  const ul = document.createElement("ul");
  for (const [i, b] of list.entries()) {
    const lines = texts[i].split("\n");
    for (const line of b.lines.slice(0, 3)) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      const name = document.createElement("strong");
      name.textContent = b.doc.rel.replace(/\.(md|markdown)$/i, "");
      const snippet = document.createElement("span");
      snippet.textContent = plainTaskText(lines[line - 1] ?? "").replace(/^[-*+>#\s]+|^\d+[.)]\s+/g, "");
      btn.append(name, snippet);
      btn.title = t("{file}：第 {line} 行", { file: b.doc.rel, line });
      btn.addEventListener("click", () => openIndexed(b.doc, line));
      li.append(btn);
      ul.append(li);
    }
  }
  el.append(ul);
}

/** 索引中的文件對應的分頁（面板列出後才開啟的也算）。 */
function tabOfIndexed(doc: IndexedDoc): Doc | undefined {
  return (doc.tabId ? docs.find((d) => d.id === doc.tabId) : undefined) ?? (doc.path ? tabForPath(doc.path) : undefined);
}

/** 打開索引中的文件並跳到某一行。 */
function openIndexed(doc: IndexedDoc, line: number): void {
  const tab = tabOfIndexed(doc);
  if (tab) {
    if (tab !== active) activate(tab);
    editor.reveal(line);
  } else if (doc.path) void openPath(doc.path, line).catch(reportError);
}

let indexPanelsTimer = 0;
/** 待辦、標籤、反向連結面板顯示中時重新整理（編輯中延遲一下）。 */
/** 打字後只更新待辦與標籤（`backlinks: false`）：反向連結是「其他文件連到這份」，打字不會改變它。 */
let indexBacklinks = false;
function refreshIndexPanels(delay = 0, { backlinks = true } = {}): void {
  clearTimeout(indexPanelsTimer);
  // 排隊中的更新有要求反向連結的話，合併後仍然要更新。
  indexBacklinks ||= backlinks;
  indexPanelsTimer = window.setTimeout(() => {
    const withBacklinks = indexBacklinks;
    indexBacklinks = false;
    if (!outlineShown) return;
    if (sidePanel === "tasks") void tasksPanel.refresh();
    if (sidePanel === "tags") void tagsPanel.refresh();
    if (withBacklinks && (sidePanel === "outline" || outlineOnRight())) void renderBacklinks();
  }, delay);
}

/** 視窗夠寬時，大綱可以固定放在內文右邊（設定「大綱放在右邊」）。 */
const wideQuery = matchMedia("(min-width: 1100px)");
function outlinePlacedRight(): boolean {
  return settings.value.outlineRight && wideQuery.matches && !narrowQuery.matches;
}
/** 大綱在右邊、而且沒有收起來。 */
function outlineOnRight(): boolean {
  return outlinePlacedRight() && rightOutlineShown;
}

function setRightOutline(shown: boolean): void {
  rightOutlineShown = shown;
  storage.save("outline-right", shown ? "shown" : "hidden");
  applyLayout();
  if (shown) {
    void renderBacklinks();
    updateActiveHeading();
  }
}

/** 依設定把大綱面板移到右邊或放回左邊的側邊欄。 */
function placeOutline(): void {
  const panel = $("#panel-outline");
  const right = $("#outline-right");
  const onRight = outlinePlacedRight();
  const outlineTab = $<HTMLButtonElement>("#side-tab-outline");
  if (onRight && panel.parentElement !== right) {
    right.append(panel);
    panel.hidden = false;
    outlineTab.hidden = true;
    if (sidePanel === "outline") showPanel("files", false);
    void renderBacklinks();
    updateActiveHeading();
  } else if (!onRight && panel.parentElement === right) {
    $("#panel-files").after(panel);
    outlineTab.hidden = false;
    panel.hidden = sidePanel !== "outline";
  }
  right.hidden = !outlineOnRight();
}

/**
 * 要開的面板圖示還沒出現（Azure DevOps、GitHub 要等連線讀到，Git 要等狀態讀到）時先顯示檔案，
 * 記在這裡；圖示出現後再切回來（例如上次關閉時開著 Azure DevOps，下次啟動仍然回到它）。
 */
let pendingPanel: SidePanel | null = null;

/** 面板的圖示不能用了（例如中斷連線）：先換到檔案，圖示再出現時切回來。 */
function panelUnavailable(panel: SidePanel): void {
  // 圖示已經藏起來，showPanel 會改開檔案並記住原本要的面板。
  if (sidePanel === panel) showPanel(panel, false);
}

/** 面板的圖示出現了：剛才因為還不能用而沒開成，現在切過去。 */
function panelAvailable(panel: SidePanel): void {
  if (pendingPanel === panel) showPanel(panel, false);
}

function showPanel(panel: SidePanel, reveal = true): void {
  const requested = panel;
  if (panel === "git" && $("#side-tab-git").hidden) panel = "files";
  if (panel === "ado" && $("#side-tab-ado").hidden) panel = "files";
  if (panel === "issues" && $("#side-tab-issues").hidden) panel = "files";
  // 不能用而改開檔案時不記住（下次啟動仍然開原本要的面板）。
  pendingPanel = panel === requested ? null : requested;
  // 大綱在右邊時一直顯示，不用切換左邊的側邊欄。
  if (panel === "outline" && outlinePlacedRight()) {
    if (!rightOutlineShown) setRightOutline(true);
    else updateActiveHeading();
    return;
  }
  sidePanel = panel;
  if (!pendingPanel) storage.save("side-panel", panel);
  for (const tab of sideTabs) {
    const on = tab.dataset.panel === panel;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    if (tab.dataset.panel === "outline" && outlinePlacedRight()) continue;
    $(`#panel-${tab.dataset.panel}`).hidden = !on;
  }
  if (reveal && !outlineShown) setOutline(true);
  if (panel === "outline") updateActiveHeading();
  if (panel === "ado") (adoTab === "wiki" ? wikiPanel : workItemsPanel)?.shown();
  if (panel === "issues") issuesPanel?.shown();
  if (panel === "search" && searchStale) {
    searchStale = false;
    searchPanel?.rerun();
  }
  refreshIndexPanels();
}

for (const tab of sideTabs) {
  tab.title ||= tab.getAttribute("aria-label") ?? "";
  // 和 VS Code 一樣：再按一次目前的圖示會收起側邊欄。
  tab.addEventListener("click", () => {
    const panel = tab.dataset.panel as SidePanel;
    if (panel === sidePanel && outlineShown) setOutline(false);
    else showPanel(panel);
  });
}
$(".activity-tabs").addEventListener("keydown", (e) => {
  // 依畫面上的順序（使用者可以調整），略過隱藏的圖示。
  const tabs = [...$(".activity-tabs").querySelectorAll<HTMLButtonElement>("[role=tab]")].filter(
    (t) => !t.hidden && !t.classList.contains("user-hidden"),
  );
  const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0 || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
  e.preventDefault();
  const next = tabs[(i + (e.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length];
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
    p.textContent = t("開啟資料夾、管理檔案與搜尋整個資料夾需要桌面版（Windows，免安裝）。");
    const a = Object.assign(document.createElement("a"), {
      className: "btn",
      href: DOWNLOAD_URL,
      textContent: t("下載桌面版"),
    });
    box.replaceChildren(p, a);
    return;
  }
  p.textContent = t("開啟一個資料夾，就能在這裡瀏覽、新增、重新命名檔案，也能搜尋整個資料夾的內容。");
  const open = document.createElement("button");
  open.type = "button";
  open.className = "btn";
  open.append(icon("folder-open"), t("開啟資料夾"));
  open.addEventListener("click", () => void commands.run("open-folder").catch(reportError));
  const remote = document.createElement("button");
  remote.type = "button";
  remote.className = "btn";
  remote.append(icon("cloud"), t("連線到 WebDAV"));
  remote.addEventListener("click", () => void commands.run("connect-webdav").catch(reportError));
  const ssh = document.createElement("button");
  ssh.type = "button";
  ssh.className = "btn";
  ssh.append(icon("server"), t("用 SSH 連線"));
  ssh.addEventListener("click", () => void commands.run("connect-ssh").catch(reportError));
  const actions = document.createElement("div");
  actions.className = "side-buttons";
  actions.append(open);
  for (const source of projectUi!.repoSources()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.append(icon(source.icon), source.title.replace(/…$/, ""));
    b.addEventListener("click", () => source.run());
    actions.append(b);
  }
  actions.append(remote, ssh);
  box.replaceChildren(p, actions);
  const [projects, conns] = await Promise.all([projectUi!.refresh(), desktop.davConnections().catch(() => [])]);
  const folders = projectSections(projects).flatMap((s) => s.items).slice(0, 10);
  if ((!folders.length && !conns.length) || workspaceRoot) return;
  const h = document.createElement("h3");
  h.textContent = t("最近開啟");
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
      x.title = t("從清單移除（也會刪除記住的密碼）");
      x.setAttribute("aria-label", t("移除「{name}」", { name: label }));
      x.append(icon("x"));
      x.addEventListener("click", forget);
      li.append(x);
    }
    list.append(li);
  };
  for (const p of folders) add("folder", p.label, displayPath(p.path), () => void openRecentFolder(p.path));
  for (const c of conns) {
    const where = c.kind === "ssh" ? c.url : t("{url}（{user}）", { url: c.url, user: c.username });
    add(c.kind === "ssh" ? "server" : "cloud", c.name, where, () => void openRemote(c), () =>
      void desktop!.davForget(c.id).then(renderFilesEmpty).catch(reportError),
    );
  }
  box.append(h, list);
  if (projects.length > folders.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "btn";
    more.append(icon("layout-grid"), t("全部 {n} 個專案…", { n: projects.length }));
    more.addEventListener("click", () => void commands.run("project-overview").catch(reportError));
    box.append(more);
  }
}

const davDialog = desktop ? new WebDavDialog(desktop) : null;
const sshDialog = desktop ? new SshDialog(desktop) : null;

/** 原生端在遠端檔案的連線沒有連上時回傳的錯誤開頭。 */
const NOT_CONNECTED = [t("還沒有連線到遠端資料夾"), t("這個檔案屬於另一個遠端連線")];

/** 遠端檔案所屬的連線目前沒有連上：提示重新連線（不自動跳出對話框打斷）。 */
async function suggestReconnect(path: string, message: (name: string) => string, label = t("重新連線")): Promise<boolean> {
  const id = remoteId(path);
  const c = (await desktop?.davConnections().catch(() => []))?.find((x) => x.id === id);
  if (!c) return false;
  toast(message(c.name), {
    duration: 15000,
    action: { label, run: () => void openRemote(c).catch(reportError) },
  });
  return true;
}

/** 開啟已儲存的遠端連線（WebDAV 或 SSH）；沒有記住密碼時先詢問。 */
async function openRemote(c: Pick<DavConnection, "id" | "kind" | "name" | "url" | "username">): Promise<void> {
  if (!desktop || !davDialog || !sshDialog) return;
  const root = remoteRoot(c);
  let folder: Folder | null = null;
  let trust: string | undefined;
  for (;;) {
    try {
      folder = await desktop.reopenFolder(root, undefined, undefined, trust);
    } catch (e) {
      const message = String(e instanceof Error ? e.message : e);
      if (message.startsWith("HOSTKEY_UNKNOWN") && !trust) {
        // 主機金鑰不在 known_hosts 裡（例如被刪掉了）：再確認一次。
        const fp = await confirmHostKey(message, c.url);
        if (!fp) return;
        trust = fp;
        continue;
      }
      if (message !== "NEED_PASSWORD") throw e;
      folder =
        c.kind === "ssh"
          ? await sshDialog.open({ passwordOnly: true, host: c.url, username: c.username, root, name: c.name })
          : await davDialog.open({ passwordOnly: true, url: c.url, username: c.username, id: c.id });
    }
    break;
  }
  if (!folder) return;
  await setWorkspace(folder);
  showPanel("files");
  await reloadRemoteDocs(folder.path);
}

async function setWorkspace(folder: Folder | null): Promise<void> {
  // 換到另一個專案：分頁也換成那個專案的（關掉資料夾時分頁留著）。
  if (folder && (tabScope === null || !samePath(tabScope, folder.path))) await switchTabs(folder.path);
  workspaceRoot = folder;
  refreshActivityCommands();
  fileListCache = null;
  if (folder) storage.save("workspace", folder.path);
  else storage.remove("workspace");
  await renderProjectName();
  await fileTree?.setRoot(folder?.path ?? null, folder?.name, folder ? loadProjectView(folder.path).expanded : []);
  treeActive = fileHandle?.path ?? null;
  await fileTree?.setActive(treeActive);
  await renderFilesEmpty();
  void gitPanel?.refresh();
  void renderIssuesTab();
}

/**
 * 換成另一個專案的分頁：先記下目前的分頁（沒存的內容留在草稿裡，切回來還在），
 * 再還原那個專案上次開著的分頁。從「沒有開啟資料夾」換過去時，開著的檔案和沒存的分頁一起帶過去。
 */
async function switchTabs(scope: string): Promise<void> {
  flushDraft();
  if (diskSaveTimer) await autoSaveNow();
  if (review.active) review.finish();
  persistSession();
  const carry = tabScope === null ? docs.filter((d) => d.dirty || d.fileBacked) : [];
  if (tabScope === null) {
    for (const d of docs) if (!carry.includes(d)) dropDraft(d.id);
    storage.remove("tabs");
  }
  tabScope = scope;
  storage.save("tab-scope", scope);
  const saved = loadSession(scope);
  const next = docsFrom(saved);
  const fresh = [...next];
  for (const d of carry) {
    const path = docPath(d);
    if (!next.some((n) => n.id === d.id || (path && n.path && samePath(n.path, path)))) next.push(d);
  }
  if (!next.length) next.push(makeDoc({ name: t("未命名.md"), kind: "markdown" }));
  const target = next.find((d) => d.id === saved?.activeId) ?? (next.includes(active) ? active : next[0]);
  docs = next;
  if (target === active) {
    persistSession();
    renderTabs();
  } else {
    activate(target);
  }
  // 分頁收起來的期間檔案可能被改過：重新讀一次（和啟動時一樣）。
  if (docsLoaded) void reloadDocs(fresh);
}

/**
 * 關閉目前的專案：分頁收起來（和切換專案一樣記住，沒存的內容留在草稿裡，下次開啟這個專案時還原），
 * 換成一個空白分頁，檔案樹回到「開啟資料夾」的畫面。
 */
async function closeProject(): Promise<void> {
  const folder = workspaceRoot;
  if (!folder || !desktop) return;
  const name = projectUi?.current?.label ?? folder.name;
  flushDraft();
  if (diskSaveTimer) await autoSaveNow();
  if (review.active) review.finish();
  persistSession();
  await desktop.closeFolder();
  tabScope = null;
  storage.remove("tab-scope");
  storage.remove("tabs");
  const blank = makeDoc({ name: t("未命名.md"), kind: "markdown" });
  docs = [blank];
  activate(blank);
  persistSession();
  renderTabs();
  await setWorkspace(null);
  toast(t("已關閉「{name}」。分頁都記住了，下次開啟這個專案會還原", { name }));
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
/** 從電腦上傳檔案到遠端資料夾（SSH、WebDAV）。 */
async function uploadFiles(dir: string, files: File[]): Promise<void> {
  if (!desktop || !fileTree || !files.length) return;
  const progress = toast(t("上傳中…（{n} 個檔案）", { n: files.length }), { duration: 600_000 });
  let done = 0;
  try {
    for (const f of files) {
      await desktop.davUpload(dir, f.name, await f.arrayBuffer());
      done++;
    }
  } finally {
    progress.dismiss();
    fileListCache = null;
    await fileTree.refresh([dir]);
  }
  toast(done === 1 ? t("已上傳「{name}」", { name: files[0].name }) : t("已上傳 {n} 個檔案", { n: done }), { tone: "success" });
}

/** 選電腦上的檔案上傳到遠端資料夾。 */
function pickAndUpload(dir: string): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.addEventListener("change", () => void uploadFiles(dir, [...(input.files ?? [])]).catch(reportError));
  input.click();
}

async function treeAction(action: TreeAction, entry: Entry): Promise<void> {
  const d = desktop;
  if (!d || !fileTree) return;
  switch (action) {
    case "upload":
      pickAndUpload(entry.path);
      break;
    case "download": {
      const saved = await d.davDownload(entry.path);
      if (saved) toast(t("已下載到「{path}」", { path: saved }), { tone: "success" });
      break;
    }
    case "new-file":
    case "new-folder": {
      const isDir = action === "new-folder";
      let name = await fileTree.promptName(entry.path, isDir ? t("新資料夾") : t("未命名.md"), isDir ? "folder" : "file");
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
      // 改名前記下各文件的連結，改名後才知道哪些要更新。
      const local = !isRemote(entry.path) && !!workspaceRoot;
      const before = local ? await indexedDocs().catch(() => []) : [];
      fileListCache ??= local && workspaceRoot ? await d.listFiles(workspaceRoot.path).catch(() => []) : fileListCache;
      const filesBefore = markdownFiles(fileListCache ?? []);
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
      fileListCache = null;
      persistSession();
      renderSaveState();
      renderTabs();
      await fileTree.refresh([parent]);
      if (local && (entry.isDir || /\.(md|markdown)$/i.test(entry.path))) await updateLinksAfterRename(entry.path, to, before, filesBefore);
      break;
    }
    case "trash": {
      stash();
      const affected = docs.filter((doc) => doc.path && isInside(doc.path, entry.path));
      const what = entry.isDir ? t("資料夾「{name}」和裡面所有的檔案", { name: entry.name }) : t("「{name}」", { name: entry.name });
      const note = affected.some((doc) => doc.dirty) ? t("已開啟的分頁會保留內容，但有尚未存檔的變更。") : "";
      // 遠端資料夾沒有資源回收筒：講清楚是永久刪除。
      const remote = isRemote(entry.path);
      const choice = remote
        ? await choose(t("永久刪除？"), t("要刪除{what}嗎？遠端資料夾沒有資源回收筒，刪除後無法復原。{note}", { what, note }), [
            { id: "trash", label: t("永久刪除"), danger: true },
            { id: "cancel", label: t("取消"), primary: true },
          ])
        : await choose(t("移到資源回收筒？"), t("要把{what}移到資源回收筒嗎？之後可以從資源回收筒還原。{note}", { what, note }), [
            { id: "trash", label: t("移到資源回收筒"), danger: true },
            { id: "cancel", label: t("取消") },
          ]);
      if (choice !== "trash") return;
      await d.trashEntry(entry.path);
      for (const doc of affected) doc.missing = true;
      fileListCache = null;
      renderTabs();
      await fileTree.refresh([dirname(entry.path)]);
      toast(remote ? t("已刪除「{name}」", { name: entry.name }) : t("已把「{name}」移到資源回收筒", { name: entry.name }));
      break;
    }
    case "reveal":
      await d.revealEntry(entry.path);
      break;
    case "copy-path":
      await navigator.clipboard.writeText(entry.path);
      toast(t("已複製路徑"));
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
  // 「{keys}」換成快速鍵的 <kbd>。
  const [before, after] = t("搜尋整個資料夾的內容需要桌面版。要搜尋目前的文件，請按 {keys}。").split("{keys}");
  p.textContent = before;
  p.append(Object.assign(document.createElement("kbd"), { textContent: formatKeys("Mod-f") }), after ?? "");
  $("#search-host").append(p);
}

// ---- 快速開啟（Ctrl+P） --------------------------------------------------

interface QuickItem {
  title: string;
  detail: string;
  doc?: Doc;
  path?: string;
}

const quickOpen = new Picker<QuickItem>({
  label: t("快速開啟"),
  placeholder: desktop ? t("輸入檔名，例如「週報」") : t("輸入檔名切換分頁"),
  empty: t("找不到符合的檔案"),
  async query(q) {
    stash();
    // 已開啟的分頁優先，目前分頁放最後（按 Enter 不會停在原地）。
    const items: QuickItem[] = [...docs.filter((d) => d !== active), active].map((d) => ({
      title: d.name,
      detail: d === active ? t("目前分頁") : t("已開啟"),
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
        items.push({ title: basename(path), detail: t("最近開啟 · {dir}", { dir: displayPath(dirname(path)) }), path });
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
    dirty: baseline !== editorHash(),
  });
}

function persistSession(): void {
  stash();
  saveSession(
    {
      activeId: active.id,
      docs: docs.map(({ id, name, kind, path, baseline, fileBacked, pinned }) => ({ id, name, kind, path, baseline, fileBacked, pinned })),
    },
    tabScope,
  );
}

function renderTabs(): void {
  tabBar.render(
    docs.map((d) => ({
      id: d.id,
      name: d === active ? fileName : d.name,
      title: ((p) => (p ? displayPath(p) : null))(d === active ? fileHandle?.path : d.path) ?? (d === active ? fileName : d.name),
      dirty: d.dirty,
      missing: d.missing,
      pinned: d.pinned,
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
  // 點分頁（包括目前的分頁）就回到文件，關掉工作項目、Git 歷史的檢視（並排顯示時留著）。
  if (!issueSide) issueView.close();
  historyView?.close();
  if (doc === active) return;
  flushDraft();
  // 切換前先把這個分頁還沒自動存的內容存起來（autoSaveNow 一開始就記下了分頁與內容）。
  if (diskSaveTimer) void autoSaveNow();
  if (review.active) review.finish();
  if (docs.includes(active)) stash();
  active = doc;
  ({ kind, name: fileName, handle: fileHandle, baseline, fileBacked } = doc);
  kindSelect.value = kind;
  if (doc.state) editor.restore(doc.state, kind, doc.scrollTop);
  else editor.load(loadDraft(doc.id) ?? "", kind);
  // 草稿被清掉的分頁：從檔案讀回內容。
  const path = docPath(doc);
  if (doc.unloaded && !doc.state && path && desktop) {
    void reloadDoc(doc, path)
      .then(() => renderTabs())
      .catch(() => {
        if (!isRemote(path)) doc.missing = true;
        renderTabs();
      });
  }
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
  refreshIndexPanels(100);
}

/** 新增一個分頁並切換過去（不會寫入內容，呼叫端負責）。 */
function addTab(doc: Doc): void {
  // 放在目前分頁的右邊，但不插進固定的分頁之間。
  const lastPinned = docs.reduce((n, d, i) => (d.pinned ? i + 1 : n), 0);
  docs.splice(Math.max(docs.indexOf(active) + 1, lastPinned), 0, doc);
  activate(doc);
}

async function closeTab(id: string): Promise<void> {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  if (doc === active) stash();
  if (doc.dirty) {
    const choice = await choose(t("要儲存變更嗎？"), t("「{name}」有尚未存檔的變更。", { name: doc.name }), [
      { id: "save", label: t("儲存"), primary: true },
      { id: "discard", label: t("不儲存"), danger: true },
      { id: "cancel", label: t("取消") },
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
  rememberClosed(doc);
  const i = docs.indexOf(doc);
  docs.splice(i, 1);
  dropDraft(doc.id);
  remoteAllowed.delete(doc.id);
  outlineCollapsed.delete(doc.id);
  changeNoticeAt.delete(doc.id);
  if (!docs.length) {
    const blank = makeDoc({ name: t("未命名{ext}", { ext: KINDS[kind].ext }), kind });
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

/** 最近關閉的分頁（Ctrl+Shift+T 重新開啟）。沒存的內容也記下來，不小心按了「不儲存」還找得回來。 */
interface ClosedTab {
  name: string;
  kind: DocKind;
  path: string | null;
  text: string;
  dirty: boolean;
}
const closedTabs: ClosedTab[] = [];
/** 重新開啟分頁的清單，保留的內容合計上限（字元數，約 16 MB）。 */
const CLOSED_TABS_TEXT_LIMIT = 8_000_000;

function rememberClosed(doc: Doc): void {
  const text = (doc === active ? editor.text : loadDraft(doc.id)) ?? "";
  const path = doc === active ? (fileHandle?.path ?? null) : doc.path;
  if (!path && !text.trim()) return; // 空白的新文件不用記
  closedTabs.push({ name: doc === active ? fileName : doc.name, kind: doc.kind, path, text, dirty: doc.dirty });
  // 最多記 20 個；內容合計太大時（例如關掉好幾份大文件）先丟掉最舊的，避免一直佔著記憶體。
  let total = closedTabs.reduce((n, c) => n + c.text.length, 0);
  while (closedTabs.length > 20 || (closedTabs.length > 1 && total > CLOSED_TABS_TEXT_LIMIT)) total -= closedTabs.shift()!.text.length;
}

async function reopenClosedTab(): Promise<void> {
  const closed = closedTabs.pop();
  if (!closed) {
    toast(t("沒有剛關閉的分頁。"));
    return;
  }
  if (closed.path && desktop) {
    try {
      await openPath(closed.path);
      if (closed.dirty && editor.text !== closed.text) {
        editor.replaceAll(closed.text, { userEvent: "input.restore", isolate: true });
        toast(t("已重新開啟，並還原關閉時沒有存的內容（可以按 Ctrl+Z 回到檔案原本的內容）。"), { duration: 8000 });
      }
      return;
    } catch {
      // 檔案已經不在了：改用關閉時的內容開一個新分頁。
    }
  }
  const doc = makeDoc({ name: closed.name, kind: closed.kind });
  saveDraft(doc.id, closed.text);
  addTab(doc);
  if (closed.path) toast(t("找不到「{name}」，已用關閉時的內容開成新分頁。", { name: closed.name }), { duration: 8000 });
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
  // 沒動過的範例文件也直接換掉，免得每次開檔都多一個「未命名」分頁。
  const untouched = !fileBacked && (editor.text === "" || (editor.text === sample && !active.dirty));
  if (!untouched) addTab(makeDoc({ name, kind: docKind ?? kindFromFileName(name) }));
  if (review.active) review.finish();
  fileHandle = handle;
  kind = docKind ?? kindFromFileName(name);
  kindSelect.value = kind;
  fileName = name;
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
  active.lossy = file.encoding === "unknown";
  if (active.lossy) {
    toast(t("「{name}」的編碼無法辨識（不是 UTF-8 也不是 Big5），畫面上可能有亂碼。為了保護原檔，這個檔案不會自動存檔。", { name: file.name }), {
      tone: "error",
      duration: 12000,
    });
  } else if (file.encoding === "big5") {
    toast(t("這個檔案是 Big5 編碼，已轉換後顯示；存檔時會改存成 UTF-8。"), { duration: 8000 });
  }
}

async function save(saveAs: boolean, force = false): Promise<void> {
  if (active.unloaded && !saveAs) {
    toast(t("「{name}」的內容還沒從檔案讀進來，先不存檔，免得把檔案蓋成空白。", { name: active.name }), { tone: "error" });
    return;
  }
  if (active.lossy && !saveAs && fileHandle?.path) {
    const choice = await choose(
      t("要覆蓋原檔嗎？"),
      t("「{name}」的編碼無法辨識，畫面上的內容可能有亂碼。存檔會改成 UTF-8 覆蓋原檔，原本的內容就無法還原。建議另存成新檔，保留原檔。", { name: active.name }),
      [
        { id: "save-as", label: t("另存新檔…"), primary: true },
        { id: "overwrite", label: t("仍要覆蓋原檔"), danger: true },
        { id: "cancel", label: t("取消") },
      ],
    );
    if (choice === "save-as") return save(true);
    if (choice !== "overwrite") return;
  }
  // 自動存檔正在寫：等它寫完再存，兩次存檔不會同時寫同一個檔案。
  while (saving) await new Promise((r) => setTimeout(r, 50));
  saving = true;
  let conflict: { name: string; diskText: string } | void;
  try {
    conflict = await saveNow(saveAs, force);
  } finally {
    saving = false;
  }
  // 衝突處理可能再存一次（覆蓋、另存），要在這次存檔結束之後。
  if (conflict) await resolveConflict(conflict.name, conflict.diskText);
}

/** 實際存檔；遇到衝突時回傳伺服器（磁碟）上的版本，交給呼叫端處理。 */
async function saveNow(saveAs: boolean, force: boolean): Promise<{ name: string; diskText: string } | void> {
  if (review.active) review.finish();
  refreshToc();
  clearTimeout(diskSaveTimer);
  // 手動存檔後恢復自動存檔。
  diskSaveBlocked = null;
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
      if (await suggestReconnect(path, (name) => t("還沒有連線到「{name}」，重新連線後再存檔。", { name }))) return;
    }
    throw e;
  }
  if (!out) return;
  if (out.status === "conflict") return { name: out.name, diskText: out.diskText };
  fileHandle = out.handle;
  active.missing = false;
  // 已經存成 UTF-8 了。
  active.lossy = false;
  // 換了位置：相對路徑的圖片、[[連結]] 要重新對應。
  preview.invalidate();
  scheduleRender();
  if (offline && offline.path === fileHandle?.path) clearOffline();
  gitPanel?.refreshSoon(300);
  setBaseline(text, true);
  setFileName(out.name);
  toast(out.handle ? t("已儲存到「{name}」", { name: out.name }) : t("已下載「{name}」", { name: out.name }), { tone: "success" });
}

// ---- 網路磁碟斷線（R1） --------------------------------------------------------

/** 原生端回報網路錯誤時，訊息以這段文字開頭（和後端的 `io::OFFLINE` 一致）。 */
const OFFLINE = t("網路磁碟無法連線");
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
    toast(
      isRemote(offline.path)
        ? t("遠端伺服器已恢復連線，記得回到那份文件存檔。")
        : t("網路磁碟已恢復連線，記得回到那份文件存檔。"),
    );
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
  const remote = isRemote(offline.path);
  const msg = document.createElement("p");
  msg.append(icon(offline.back ? "refresh-cw" : "circle-alert"));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  if (offline.back) {
    msg.append(remote ? t("遠端伺服器已恢復連線。") : t("網路磁碟已恢復連線。"));
    button.textContent = t("立即存檔");
    button.addEventListener("click", () => void save(false).catch(reportError));
  } else {
    msg.append(
      Object.assign(document.createElement("strong"), { textContent: remote ? t("遠端伺服器無法連線") : t("網路磁碟無法連線") }),
      Object.assign(document.createElement("span"), {
        textContent: t("這次沒有存到檔案。內容會保留在編輯器裡（草稿也已自動保存），連線恢復後會提醒你。"),
      }),
    );
    button.textContent = t("重試存檔");
    button.addEventListener("click", () => void save(false).catch(reportError));
  }
  offlineBar.replaceChildren(msg, button);
}

/** 提示文字用：遠端檔案存在「伺服器」，本機檔案存在「磁碟」。 */
function storeName(path = fileHandle?.path): string {
  return isRemote(path) ? t("伺服器") : t("磁碟");
}

/** 提示文字用：誰會在背後改檔案。 */
function otherWriter(path = fileHandle?.path): string {
  return isRemote(path) ? t("其他電腦或程式") : t("其他程式");
}

/** 檔案在開啟後被別的程式改過：讓使用者比較差異、覆蓋或另存。 */
async function resolveConflict(name: string, diskText: string): Promise<void> {
  const remote = isRemote(fileHandle?.path);
  const choice = await choose(
    t("檔案已被{who}修改", { who: otherWriter() }),
    remote
      ? t("「{name}」在你開啟之後被其他電腦或程式改過。要怎麼處理？", { name })
      : t("「{name}」在你開啟之後被其他程式（例如同步軟體或另一個編輯器）改過。要怎麼處理？", { name }),
    [
      { id: "compare", label: t("比較差異"), primary: true },
      { id: "overwrite", label: t("用我的版本覆蓋"), danger: true },
      { id: "save-as", label: t("另存新檔") },
      { id: "cancel", label: t("取消") },
    ],
  );
  if (choice === "overwrite") await save(false, true);
  else if (choice === "save-as") await save(true);
  else if (choice === "compare") {
    const started = review.start(diskText, {
      title: t("與{store}上的版本比較", { store: storeName() }),
      hint: t("逐段選擇要採用哪個版本，全部處理完會自動存檔。"),
      acceptLabel: isRemote(fileHandle?.path) ? t("採用伺服器版本") : t("採用磁碟版本"),
      rejectLabel: t("保留我的版本"),
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
  if (!ok) toast(kind === "delete-row" ? t("標題列與分隔列不能刪除，或游標不在表格中。") : t("請先把游標移到表格裡。"));
  editor.view.focus();
}

// ---- 指令 ---------------------------------------------------------------

const commands = new Commands();
const isMarkdown = () => kind === "markdown" && view !== "preview";

/** 插入一段範例區塊，並選取第 `line` 行（從 0 算起）的範例文字，直接打字就能取代。 */
function insertPlaceholder(text: string, line: number): void {
  editor.exec(insertBlock(text, text.split("\n")[line]?.trim()));
}

function fmt(id: string, title: string, iconName: string, run: () => void, keys?: string, group = t("格式")): Command {
  return { id, title, group, icon: iconName, keys, when: isMarkdown, run };
}

commands.register(
  {
    id: "new",
    title: t("新增文件"),
    group: t("檔案"),
    icon: "file-plus",
    // 桌面版用一般的 Ctrl+N；網頁版的 Ctrl+N 會被瀏覽器拿去開新視窗。
    keys: desktop ? "Mod-n" : "Mod-Alt-n",
    run() {
      const doc = makeDoc({ name: t("未命名{ext}", { ext: KINDS[kind].ext }), kind });
      saveDraft(doc.id, "");
      addTab(doc);
      editor.view.focus();
    },
  },
  {
    id: "reopen-closed-tab",
    title: t("重新開啟關閉的分頁"),
    group: t("分頁"),
    icon: "history",
    // 網頁版的 Ctrl+W、Ctrl+Shift+T、Ctrl+Tab 會被瀏覽器拿去用（關掉整個瀏覽器分頁），改用其他按鍵。
    keys: desktop ? "Mod-Shift-t" : "Mod-Alt-Shift-t",
    run: () => reopenClosedTab(),
  },
  {
    id: "new-from-template",
    title: t("從範本新增…"),
    group: t("檔案"),
    icon: "layout-template",
    run: () => templatePicker.open(),
  },
  {
    id: "save-as-template",
    title: t("把目前文件存成範本…"),
    group: t("檔案"),
    icon: "layout-template",
    when: () => kind === "markdown",
    run: () => saveAsTemplate(),
  },
  {
    id: "delete-template",
    title: t("刪除自訂範本…"),
    group: t("檔案"),
    icon: "x",
    when: () => settings.value.templates.length > 0,
    run: () => deleteTemplatePicker.open(),
  },
  {
    id: "tab-next",
    title: t("下一個分頁"),
    group: t("分頁"),
    icon: "arrow-right",
    keys: desktop ? "Ctrl-Tab" : "Alt-PageDown",
    when: () => docs.length > 1,
    run: () => cycleTab(1),
  },
  {
    id: "tab-prev",
    title: t("上一個分頁"),
    group: t("分頁"),
    icon: "arrow-left",
    keys: desktop ? "Ctrl-Shift-Tab" : "Alt-PageUp",
    when: () => docs.length > 1,
    run: () => cycleTab(-1),
  },
  {
    id: "tab-close",
    title: t("關閉分頁"),
    group: t("分頁"),
    icon: "x",
    keys: desktop ? "Mod-w" : "Mod-Alt-w",
    run: () => closeTab(menuTab().id),
  },
  {
    id: "fold-all",
    title: t("摺疊所有章節"),
    group: t("檢視"),
    icon: "chevrons-down-up",
    shownKeys: "Ctrl-Alt-[",
    run: () => void foldAll(editor.view),
  },
  {
    id: "unfold-all",
    title: t("展開所有章節"),
    group: t("檢視"),
    icon: "chevrons-up-down",
    shownKeys: "Ctrl-Alt-]",
    run: () => void unfoldAll(editor.view),
  },
  {
    id: "tab-close-others",
    title: t("關閉其他分頁"),
    group: t("分頁"),
    icon: "x",
    when: () => docs.some((d) => d !== menuTab() && !d.pinned),
    run() {
      const keep = menuTab();
      return closeTabs(docs.filter((d) => d !== keep && !d.pinned));
    },
  },
  {
    id: "tab-close-all",
    title: t("關閉所有分頁"),
    group: t("分頁"),
    icon: "x",
    // 固定的分頁保留（和「關閉其他分頁」一致）；沒存的分頁會逐一詢問。
    when: () => docs.some((d) => !d.pinned),
    run: () => closeTabs(docs.filter((d) => !d.pinned)),
  },
  {
    id: "tab-close-right",
    title: t("關閉右側的分頁"),
    group: t("分頁"),
    icon: "x",
    when: () => docs.slice(docs.indexOf(menuTab()) + 1).some((d) => !d.pinned),
    run() {
      return closeTabs(docs.slice(docs.indexOf(menuTab()) + 1).filter((d) => !d.pinned));
    },
  },
  {
    id: "tab-close-saved",
    title: t("關閉已儲存的分頁"),
    group: t("分頁"),
    icon: "x",
    when: () => docs.some((d) => !d.dirty && !d.pinned),
    run: () => closeTabs(docs.filter((d) => !d.dirty && !d.pinned)),
  },
  {
    id: "tab-pin",
    title: t("固定／取消固定分頁"),
    group: t("分頁"),
    icon: "pin",
    run() {
      const doc = menuTab();
      setPinned(doc, !doc.pinned);
    },
  },
  {
    id: "tab-copy-path",
    title: t("複製檔案路徑"),
    group: t("檔案"),
    icon: "copy",
    when: () => !!tabPath(menuTab()),
    async run() {
      await navigator.clipboard.writeText(displayPath(tabPath(menuTab())!));
      toast(t("已複製路徑"));
    },
  },
  {
    id: "tab-reveal",
    title: t("在檔案總管中顯示"),
    group: t("檔案"),
    icon: "folder-open",
    when: () => !!desktop && !!tabPath(menuTab()),
    run: () => desktop!.revealEntry(tabPath(menuTab())!),
  },
  {
    id: "open",
    title: t("開啟檔案…"),
    group: t("檔案"),
    icon: "folder-open",
    keys: "Mod-o",
    async run() {
      const file = await openFile(fileInput);
      if (file) openOpenedFile(file);
    },
  },
  {
    id: "open-folder",
    title: t("開啟資料夾…"),
    group: t("資料夾與專案"),
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
    id: "close-folder",
    title: t("關閉專案"),
    group: t("資料夾與專案"),
    icon: "folder-x",
    when: () => !!desktop && !!workspaceRoot,
    run: () => closeProject(),
  },
  {
    id: "switch-project",
    title: t("切換專案…"),
    group: t("資料夾與專案"),
    icon: "folder-kanban",
    keys: "Mod-Alt-p",
    when: () => !!projectUi,
    run: () => projectUi!.openSwitcher(),
  },
  {
    id: "project-overview",
    title: t("專案總覽"),
    group: t("資料夾與專案"),
    icon: "layout-grid",
    when: () => !!projectUi,
    run: () => projectUi!.openOverview(),
  },
  {
    id: "project-settings",
    title: t("目前專案的設定（名稱、顏色、群組）…"),
    group: t("資料夾與專案"),
    icon: "pencil",
    when: () => !!projectUi?.current,
    run: () => projectUi!.edit(projectUi!.current!),
  },
  {
    id: "connect-webdav",
    title: t("連線到遠端資料夾（WebDAV）…"),
    group: t("資料夾與專案"),
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
    id: "show-shortcuts",
    title: t("說明：快速鍵一覽"),
    group: t("說明"),
    icon: "command",
    keys: "F1",
    run: () => showShortcuts(),
  },
  {
    id: "show-welcome",
    title: t("說明：開啟歡迎文件"),
    group: t("說明"),
    icon: "book-open-text",
    run: () => openWelcome(),
  },
  {
    id: "show-changelog",
    title: t("說明：更新紀錄"),
    group: t("說明"),
    icon: "scroll-text",
    run: () => openChangelog(),
  },
  {
    id: "report-issue",
    title: t("說明：回報問題或建議…"),
    group: t("說明"),
    icon: "bug",
    run: () => openUrl(`${REPO_URL}/issues/new`),
  },
  {
    id: "about",
    title: t("關於 oMarker"),
    group: t("說明"),
    icon: "info",
    run: () => settingsDialog.open(t("關於")),
  },
  {
    id: "allow-remote-images",
    title: t("載入這份文件的遠端圖片"),
    group: t("檢視"),
    icon: "image",
    when: () => blockRemote(),
    run: () => allowRemoteImages(),
  },
  {
    id: "connect-ssh",
    title: t("連線到遠端資料夾（SSH）…"),
    group: t("資料夾與專案"),
    icon: "server",
    when: () => !!desktop,
    async run() {
      const folder = await sshDialog?.open();
      if (!folder) return;
      await setWorkspace(folder);
      showPanel("files");
    },
  },
  {
    id: "quick-open",
    title: t("快速開啟檔案…"),
    group: t("檔案"),
    icon: "search",
    keys: "Mod-p",
    run: () => quickOpen.open(),
  },
  {
    id: "search-in-folder",
    title: t("在資料夾中搜尋"),
    group: t("資料夾與專案"),
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
  {
    id: "replace-in-folder",
    title: t("在資料夾中取代…"),
    group: t("資料夾與專案"),
    icon: "replace",
    when: () => !!searchPanel && !!workspaceRoot && !isRemote(workspaceRoot.path),
    run() {
      showPanel("search");
      searchPanel?.showReplace();
    },
  },
  { id: "show-files", title: t("顯示檔案"), group: t("檢視"), icon: "folder", keys: "Mod-Shift-e", run: () => showPanel("files") },
  { id: "show-outline", title: t("顯示大綱"), group: t("檢視"), icon: "list-tree", run: () => showPanel("outline") },
  { id: "show-search", title: t("顯示搜尋"), group: t("檢視"), icon: "search", when: () => !!desktop, run: () => showPanel("search") },
  { id: "show-tasks", title: t("顯示待辦總覽"), group: t("檢視"), icon: "list-checks", run: () => showPanel("tasks") },
  { id: "show-tags", title: t("顯示標籤"), group: t("檢視"), icon: "tags", run: () => showPanel("tags") },
  {
    id: "show-git",
    title: t("顯示原始碼控制（Git）"),
    group: t("Git"),
    icon: "git-branch",
    keys: "Mod-Shift-g",
    when: () => !!gitPanel,
    run: () => showPanel("git"),
  },
  { id: "save", title: t("存檔"), group: t("檔案"), icon: "save", keys: "Mod-s", run: () => save(false) },
  { id: "save-as", title: t("另存新檔…"), group: t("檔案"), icon: "file", keys: "Mod-Shift-s", run: () => save(true) },
  {
    id: "export-html",
    title: t("匯出成 HTML…"),
    group: t("匯入與匯出"),
    icon: "download",
    async run() {
      const html = await preview.exportDocument(editor.text, kind, stem(fileName));
      const name = replaceExtension(fileName, ".html");
      if ((await download(name, html, "text/html")) && desktop) toast(t("已匯出「{name}」", { name }), { tone: "success" });
    },
  },
  {
    id: "export-pdf",
    title: desktop ? t("匯出成 PDF…") : t("列印／匯出成 PDF…"),
    group: t("匯入與匯出"),
    icon: desktop ? "file-down" : "printer",
    run: () => exportPdf(),
  },
  {
    id: "print",
    title: t("列印…"),
    group: t("匯入與匯出"),
    icon: "printer",
    when: () => !!desktop,
    run: () => exportPdf(true),
  },
  {
    id: "copy-html",
    title: t("複製 HTML"),
    group: t("匯入與匯出"),
    icon: "copy",
    async run() {
      // 複製出去的 HTML 不需要捲動同步用的 data-sourcepos，直接重新渲染一份。
      const result = renderMarkdown(editor.text, { kind });
      if (result.error) {
        toast(t("文件有格式錯誤，修正後才能複製。"), { tone: "error" });
        return;
      }
      await navigator.clipboard.writeText(result.html);
      toast(t("已複製 HTML 到剪貼簿"), { tone: "success" });
    },
  },
  {
    id: "export-docx",
    title: t("匯出成 Word（.docx）…"),
    group: t("匯入與匯出"),
    icon: "file-type",
    when: () => kind === "markdown",
    run: () => exportDocx(),
  },
  {
    id: "slideshow",
    title: t("簡報模式：從頭播放"),
    group: t("檢視"),
    icon: "presentation",
    keys: "F5",
    when: () => kind === "markdown",
    run: () => startSlideshow(false),
  },
  {
    id: "slideshow-here",
    title: t("簡報模式：從目前這一頁播放"),
    group: t("檢視"),
    icon: "presentation",
    keys: "Shift-F5",
    when: () => kind === "markdown",
    run: () => startSlideshow(true),
  },
  {
    id: "import-docx",
    title: t("匯入 Word 文件（.docx）…"),
    group: t("匯入與匯出"),
    icon: "file-input",
    run: () => importDocx(),
  },
  {
    id: "copy-rich",
    title: t("複製為格式文字（貼到 Word、Outlook、Teams）"),
    group: t("匯入與匯出"),
    icon: "clipboard-copy",
    keys: "Mod-Alt-c",
    when: () => kind === "markdown",
    run: () => copyRich(),
  },
  {
    id: "fix-terms",
    title: t("修正兩國用語、錯字與標點（整份文件）"),
    group: t("編輯"),
    icon: "spell-check",
    when: () => kind !== "json" && view !== "preview",
    run: () => fixTerms(),
  },
  {
    id: "s2t",
    title: t("簡體轉繁體（台灣用語）"),
    group: t("編輯"),
    icon: "languages",
    when: () => kind !== "json" && view !== "preview",
    run: () => convertToTraditional(),
  },
  {
    id: "clear-term-ignore",
    title: t("兩國用語檢查：清除「不再提示」的詞"),
    group: t("編輯"),
    icon: "spell-check",
    when: () => settings.value.termIgnore.length > 0,
    run: () => {
      const n = settings.value.termIgnore.length;
      settings.update({ termIgnore: [] });
      toast(t("已清除 {n} 個不再提示的詞。", { n }), { tone: "success" });
    },
  },
  { id: "palette", title: t("開啟指令面板"), group: t("說明"), icon: "command", keys: "Mod-Shift-p", run: () => palette.open() },
  {
    id: "rename-doc",
    title: t("重新命名文件…"),
    group: t("檔案"),
    icon: "pencil",
    run: () => tabBar.startRename(active.id),
  },
  {
    id: "toggle-format-bar",
    title: t("固定顯示／隱藏格式工具列"),
    group: t("檢視"),
    icon: "bold",
    run: () => settings.update({ fixedToolbar: !settings.value.fixedToolbar }),
  },
  {
    id: "find",
    title: t("搜尋與取代"),
    group: t("編輯"),
    icon: "search",
    keys: "Mod-f",
    when: () => view !== "preview",
    // 工作項目開在主要區域時，在它的內容裡找字。
    run: () =>
      issueView.isOpen && (!issueSide || issueView.hasFocus) ? issueView.openFind() : void openSearchPanel(editor.view),
  },
  {
    id: "format-json",
    title: t("格式化 JSON"),
    group: t("編輯"),
    icon: "wand-sparkles",
    keys: "Shift-Alt-f",
    when: () => kind === "json",
    run() {
      try {
        const formatted = formatJson(editor.text);
        if (formatted !== editor.text) editor.replaceAll(formatted);
        toast(t("已重新排版（可用 Ctrl+Z 復原）"), { tone: "success" });
      } catch (e) {
        const err = preview.result?.error;
        toast(t("無法格式化：{error}", { error: e instanceof Error ? e.message : String(e) }), {
          tone: "error",
          action: err ? { label: t("跳到錯誤"), run: () => editor.reveal(err.line, err.column) } : undefined,
        });
      }
    },
  },
  fmt("bold", t("粗體"), "bold", () => editor.exec(toggleWrap("**")), "Mod-b"),
  fmt("italic", t("斜體"), "italic", () => editor.exec(toggleWrap("*")), "Mod-i"),
  fmt("strike", t("刪除線"), "strikethrough", () => editor.exec(toggleWrap("~~")), "Mod-Shift-x"),
  fmt("code", t("行內程式碼"), "code", () => editor.exec(toggleWrap("`")), "Mod-e"),
  fmt("link", t("插入連結"), "link", () => editor.exec(insertLink), "Mod-k", t("插入")),
  fmt("underline", t("底線"), "underline", () => editor.exec(toggleWrap("<u>", "</u>")), "Mod-u"),
  fmt("highlight", t("螢光標記"), "highlighter", () => editor.exec(toggleWrap("<mark>", "</mark>")), "Mod-Shift-h"),
  fmt("superscript", t("上標（例如 m²）"), "superscript", () => editor.exec(toggleWrap("<sup>", "</sup>"))),
  fmt("subscript", t("下標（例如 H₂O）"), "subscript", () => editor.exec(toggleWrap("<sub>", "</sub>"))),
  fmt(
    "clear-format",
    t("清除格式"),
    "remove-formatting",
    () => {
      const ok = clearInlineFormat({ state: editor.view.state, dispatch: (tr) => editor.view.dispatch(tr) });
      if (!ok) toast(t("請先選取要清除格式的文字。"));
      editor.view.focus();
    },
    "Mod-\\",
  ),
  fmt("h1", t("標題 1"), "heading-1", () => editor.exec(toggleLineStyle("h1")), "Mod-Alt-1"),
  fmt("h2", t("標題 2"), "heading-2", () => editor.exec(toggleLineStyle("h2")), "Mod-Alt-2"),
  fmt("h3", t("標題 3"), "heading-3", () => editor.exec(toggleLineStyle("h3")), "Mod-Alt-3"),
  fmt("quote", t("引言"), "quote", () => editor.exec(toggleLineStyle("quote"))),
  fmt("bullet", t("項目清單"), "list", () => editor.exec(toggleLineStyle("bullet")), "Mod-Shift-8"),
  fmt("ordered", t("編號清單"), "list-ordered", () => editor.exec(toggleLineStyle("ordered")), "Mod-Shift-7"),
  fmt("task", t("待辦清單"), "list-checks", () => editor.exec(toggleLineStyle("task")), "Mod-Shift-9"),
  fmt("code-block", t("程式碼區塊"), "square-code", () => insertPlaceholder(t("```\n程式碼\n```"), 1)),
  // 插入後選取第一個欄位名稱，直接打字就能取代。
  fmt("table", t("插入表格"), "table", () => editor.exec(insertBlock(TABLE_TEMPLATE, TABLE_TEMPLATE.split("|")[1].trim())), undefined, t("插入")),
  fmt("hr", t("分隔線"), "minus", () => editor.exec(insertBlock("---")), undefined, t("插入")),
  fmt("insert-toc", t("插入或更新目錄"), "toc", () => insertToc(), undefined, t("插入")),
  fmt("math-block", t("數學公式區塊"), "sigma", () => insertPlaceholder(t("$$\n公式\n$$"), 1), undefined, t("插入")),
  fmt("mermaid-block", t("流程圖"), "workflow", () =>
    insertPlaceholder(t("```mermaid\nflowchart LR\n  A[開始] --> B[結束]\n```"), 2),
    undefined,
    t("插入"),
  ),
  fmt("insert-image", t("圖片…"), "image", () => imageInput.click(), undefined, t("插入")),
  fmt("insert-menu", t("插入…"), "plus", () => {
    const pos = editor.view.state.selection.main.head;
    const at = editor.view.coordsAtPos(pos);
    if (at) openInsertMenu(new DOMRect(at.left, at.top, 0, at.bottom - at.top));
  }, "Mod-Shift-Enter", t("插入")),
  fmt("table-format", t("表格：對齊目前的表格"), "table", () => runTableEdit("format")),
  fmt("table-insert-row", t("表格：在下方插入一列"), "table", () => runTableEdit("insert-row")),
  fmt("table-insert-column", t("表格：在右側插入一欄"), "table", () => runTableEdit("insert-column")),
  fmt("table-delete-row", t("表格：刪除目前這一列"), "table", () => runTableEdit("delete-row")),
  fmt("table-delete-column", t("表格：刪除目前這一欄"), "table", () => runTableEdit("delete-column")),
  {
    id: "format-tables",
    title: t("對齊文件中所有表格"),
    group: t("編輯"),
    icon: "wand-sparkles",
    keys: "Shift-Alt-f",
    when: () => kind === "markdown",
    run() {
      const formatted = formatAllTables(editor.text);
      if (formatted === editor.text) {
        toast(t("所有表格都已經對齊。"));
        return;
      }
      editor.replaceAll(formatted);
      toast(t("已對齊所有表格（可用 Ctrl+Z 復原）"), { tone: "success" });
    },
  },
  {
    id: "tidy-spacing",
    title: t("整理文件：在中文與英文、數字之間加空格"),
    group: t("編輯"),
    icon: "wand-sparkles",
    when: () => kind !== "json" && view !== "preview",
    run() {
      const text = editor.text;
      const positions = spacingPositions(text, kind);
      if (!positions.length) {
        toast(t("沒有需要加空格的地方。"));
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
      toast(t("已補上 {n} 個空格（可用 Ctrl+Z 復原）", { n: positions.length }), { tone: "success" });
    },
  },
  {
    id: "settings",
    title: t("設定"),
    group: t("說明"),
    icon: "settings",
    keys: "Mod-,",
    run: () => settingsDialog.open(),
  },
  ...(["editor", "live", "split", "preview"] as const).map(
    (mode): Command => ({
      id: `view-${mode}`,
      title: {
        editor: t("只顯示原始碼"),
        live: t("即時預覽（在編輯區直接顯示排版）"),
        split: t("原始碼與預覽並排"),
        preview: t("只顯示預覽"),
      }[mode],
      group: t("檢視"),
      icon: { editor: "code", live: "book-open-text", split: "columns-2", preview: "eye" }[mode],
      when: () => mode !== "split" || !narrowQuery.matches,
      run: () => setView(mode),
    }),
  ),
  {
    id: "toggle-focus-mode",
    title: t("專注模式（淡化其他段落）"),
    group: t("檢視"),
    icon: "focus",
    when: () => view !== "preview",
    run: () => toggleSetting("focusMode", t("專注模式")),
  },
  {
    id: "toggle-typewriter-mode",
    title: t("打字機模式（游標保持在畫面中央）"),
    group: t("檢視"),
    icon: "text-cursor",
    when: () => view !== "preview",
    run: () => toggleSetting("typewriterMode", t("打字機模式")),
  },
  {
    id: "font-bigger",
    title: t("放大編輯區文字"),
    group: t("檢視"),
    icon: "a-arrow-up",
    keys: "Mod-Equal",
    run: () => changeFontSize(1),
  },
  {
    id: "font-smaller",
    title: t("縮小編輯區文字"),
    group: t("檢視"),
    icon: "a-arrow-down",
    keys: "Mod-Minus",
    run: () => changeFontSize(-1),
  },
  {
    id: "font-reset",
    title: t("編輯區文字恢復預設大小"),
    group: t("檢視"),
    icon: "text-cursor",
    keys: "Mod-0",
    run: () => settings.update({ editorFontSize: DEFAULT_SETTINGS.editorFontSize }),
  },
  {
    id: "toggle-outline",
    title: t("顯示／隱藏側邊欄"),
    group: t("檢視"),
    icon: "panel-left",
    keys: "Mod-Shift-o",
    run: () => setOutline(!outlineShown),
  },
  {
    id: "toggle-outline-right",
    title: t("顯示／隱藏右邊的大綱"),
    group: t("檢視"),
    icon: "panel-right",
    keys: "Mod-Alt-b",
    when: () => outlinePlacedRight(),
    run: () => setRightOutline(!rightOutlineShown),
  },
  ...(["system", "light", "dark"] as const).map(
    (pref): Command => ({
      id: `theme-${pref}`,
      title: { system: t("主題：跟隨系統"), light: t("主題：淺色"), dark: t("主題：深色") }[pref],
      group: t("檢視"),
      icon: { system: "monitor", light: "sun", dark: "moon" }[pref],
      run: () => setTheme(pref),
    }),
  ),
  ...(Object.keys(KINDS) as DocKind[]).map(
    (k): Command => ({
      id: `kind-${k}`,
      title: t("文件類型改為 {kind}", { kind: KINDS[k].label }),
      group: t("檢視"),
      icon: "file-type",
      when: () => kind !== k,
      run: () => setKind(k),
    }),
  ),
);

const palette = new Palette(commands);
const TERMINAL_KEYS = new Set(["palette", "toggle-terminal"]);

// ---- AI 協作與終端機（桌面版） ------------------------------------------------

if (desktop) {
  terminal = new TerminalPanel(
    $("#terminal-panel"),
    desktop,
    () => editor.view.requestMeasure(),
    (at, entries, closed) => {
      for (const id of ["term-menu-anchor", "term-menu-anchor-popover"]) document.getElementById(id)?.remove();
      floatingMenu("term-menu-anchor", entries, closed).open(at);
    },
  );
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

/** 已安裝的 Claude Code／Codex（找不到時是 null）。 */
let aiFound: { claude: string | null; codex: string | null } = { claude: null, codex: null };

/**
 * 終端機只在開啟 AI 時顯示已安裝的 Claude Code／Codex 按鈕。
 * 第一次偵測到有安裝、但還沒開啟 AI 協作時，提示一次可以開啟。
 */
async function refreshAiTools(): Promise<void> {
  if (!desktop || !terminal) return;
  const none = { claude: null, codex: null };
  aiFound = await desktop.aiTools().catch(() => none);
  terminal.setAvailable(settings.value.aiEnabled ? aiFound : none);
  if (settings.value.aiEnabled || !(aiFound.claude || aiFound.codex) || storage.load("ai-hint")) return;
  storage.save("ai-hint", "shown");
  const tool = aiFound.claude ? "claude" : "codex";
  toast(
    t("偵測到 {tool}。開啟 AI 協作後，可以在下方的終端機使用它讀取、修改目前的文件。", { tool: tool === "claude" ? "Claude Code" : "Codex" }),
    { duration: 20000, action: { label: t("開啟 AI 協作"), run: () => settings.update({ aiEnabled: true, aiTool: tool }) } },
  );
}

/** 有沒有可以使用的終端機 AI（已開啟 AI 協作，而且有安裝 Claude Code 或 Codex）。 */
const terminalAiReady = () => !!terminal && !!ai?.enabled && !!(aiFound.claude || aiFound.codex);

/** 把選取範圍（或整份文件）的參照 `@檔案#L行號` 貼到終端機中的 Claude Code／Codex。 */
async function sendSelectionToAi(): Promise<void> {
  if (!terminal) return;
  const state = editor.view.state;
  const { from, to } = state.selection.main;
  let path = fileHandle?.path ?? null;
  // 遠端資料夾的檔案本機的 AI 讀不到，改成直接貼上文字。
  if (path && isRemote(path)) path = null;
  if (path && active.dirty) {
    // AI 讀的是磁碟上的檔案，先存檔行號才會對。
    await save(false);
    if (active.dirty) return;
  }
  let text: string;
  if (path) {
    const root = workspaceRoot && !isRemote(workspaceRoot.path) ? workspaceRoot.path : null;
    const first = state.doc.lineAt(from).number;
    // 選取範圍結束在下一行的開頭時，不算那一行。
    const end = to > from && state.doc.lineAt(to).from === to ? to - 1 : to;
    text = `${fileReference(path, root, from === to ? null : [first, state.doc.lineAt(end).number])} `;
  } else if (from !== to) {
    text = `${state.sliceDoc(from, to)}\n\n`;
  } else {
    toast(t("請先存檔，或選取要傳送的文字。"));
    return;
  }
  const preferred = settings.value.aiTool === "codex" ? (aiFound.codex ? "codex" : "claude") : aiFound.claude ? "claude" : "codex";
  await terminal.sendToAi(text, preferred);
}

/** 在工作區（Git 儲存庫）加入 Claude Code 的 GitHub Actions 工作流程。 */
async function addClaudeWorkflow(): Promise<void> {
  if (!desktop) return;
  const ok = await choose(
    t("加入 Claude Code 自動校對"),
    t("會在這個資料夾建立 .github/workflows/claude.yml。推送到 GitHub 之後：開 PR 修改文件時，Claude 會用台灣繁體中文校對並留言；在 issue 或 PR 留言寫「@claude 請幫我……」，Claude 會照著做。需要在 GitHub 設定一次權杖（建立後會說明）。"),
    [
      { id: "create", label: t("建立"), primary: true },
      { id: "cancel", label: t("取消") },
    ],
  );
  if (ok !== "create") return;
  await desktop.createWorkflow("claude.yml", CLAUDE_WORKFLOW);
  gitPanel?.refreshSoon(200);
  const next = await choose(
    t("已建立 .github/workflows/claude.yml"),
    t("接著：① 提交並推送；② 在 GitHub 儲存庫的 Settings → Secrets and variables → Actions 新增 CLAUDE_CODE_OAUTH_TOKEN（在終端機執行 claude setup-token 取得）。也可以在 Claude Code 裡執行 /install-github-app，它會自動設定。"),
    [
      ...(terminal && aiFound.claude ? [{ id: "token", label: t("在終端機執行 claude setup-token"), primary: true }] : []),
      { id: "done", label: t("知道了") },
    ],
  );
  if (next === "token") await terminal?.runInShell("claude setup-token");
}

/** 上次同步給 MCP 的文件內容（CodeMirror 的文件物件，內容不變時是同一個）。 */
let syncedDoc: unknown = null;

function editorSnapshot(full: boolean): EditorSnapshot {
  const { from, to } = editor.view.state.selection.main;
  const doc = editor.view.state.doc;
  // 內容沒變（例如只移動游標）：不必再把整份文件轉成字串送過去。
  const same = !full && doc === syncedDoc;
  syncedDoc = doc;
  return {
    active: {
      path: fileHandle?.path ?? null,
      name: fileName,
      text: same ? "" : doc.toString(),
      sameText: same,
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
  label: t("AI 快捷動作"),
  placeholder: t("選擇動作，或直接輸入要 AI 怎麼處理選取的文字"),
  empty: t("沒有符合的動作；按 Enter 會把輸入的文字當成指示"),
  query(q) {
    const actions = settings.value.quickActions
      .map((a) => ({ a, score: fuzzyScore(q, a.name) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .map((x) => x.a);
    const text = q.trim();
    return text && !actions.some((a) => a.name === text)
      ? [...actions, { name: t("自訂：{text}", { text }), prompt: text, custom: true }]
      : actions;
  },
  render: (a) => ({ title: a.name, detail: a.custom ? t("自訂指示") : undefined, icon: "sparkles" }),
  pick: (a) => void ai?.runAction(a).catch(reportError),
});

// ---- 最近開啟（W8） ------------------------------------------------------------

const RECENT_LIMITS = { files: 10, folders: 5 } as const;

const recentPicker = new Picker<{ path: string; folder: boolean }>({
  label: t("最近開啟"),
  placeholder: t("輸入檔名或資料夾名稱"),
  empty: t("還沒有最近開啟的檔案或資料夾。"),
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
    detail: i.folder ? t("資料夾 · {dir}", { dir: displayPath(dirname(i.path)) }) : displayPath(dirname(i.path)),
    icon: i.folder ? "folder" : "file-text",
  }),
  pick: (i) => void (i.folder ? openRecentFolder(i.path) : openPath(i.path)).catch(reportError),
});

// ---- 本機版本記錄（E12） ------------------------------------------------------

const historyPicker = new Picker<FileVersion & { path: string }>({
  label: t("版本記錄"),
  placeholder: t("選擇一個版本，和目前的內容比較"),
  empty: t("這個檔案還沒有版本記錄。存檔時會自動保存。"),
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
    detail:
      v.kind === "disk"
        ? t("存檔前{store}上的內容 · {size}", { store: storeName(v.path), size: sizeLabel(v.size) })
        : sizeLabel(v.size),
    icon: "history",
  }),
  pick: (v) => void compareWithVersion(v).catch(reportError),
});

async function compareWithVersion(v: FileVersion & { path: string }): Promise<void> {
  if (!desktop || fileHandle?.path !== v.path) return;
  const text = await desktop.historyRead(v.path, v.id);
  if (review.active) review.finish();
  const started = review.start(text, {
    title: t("與 {version} 的版本比較", { version: versionTitle(v.id) }),
    hint: t("「採用舊版」會把那一段換回舊版的內容，可以用 Ctrl+Z 復原；處理完記得存檔"),
    acceptLabel: t("採用舊版"),
    rejectLabel: t("保留目前"),
  });
  if (!started) toast(t("這個版本和目前的內容相同。"));
}

// ---- Git：檔案的提交歷史、網頁連結 --------------------------------------------

async function compareWithCommit(c: FileCommit & { path: string }): Promise<void> {
  if (!desktop || fileHandle?.path !== c.path) return;
  const text = await desktop.gitFileAt(c.path, c.id);
  if (review.active) review.finish();
  const started = review.start(text, {
    title: t("與提交 {commit}（{summary}）的版本比較", { commit: c.short, summary: c.summary }),
    hint: t("「採用這一版」會把那一段換回這次提交時的內容，可以用 Ctrl+Z 復原；處理完記得存檔"),
    acceptLabel: t("採用這一版"),
    rejectLabel: t("保留目前"),
  });
  if (!started) toast(t("這次提交時的內容和目前相同。"));
}

/** 目前檔案在 GitHub／Azure DevOps 網頁上的網址；有選取文字時標示那幾行。 */
async function webLink(): Promise<string | null> {
  const path = fileHandle?.path;
  if (!desktop || !path) return null;
  const { state } = editor.view;
  const sel = state.selection.main;
  const lines = sel.empty
    ? undefined
    : [state.doc.lineAt(sel.from).number, state.doc.lineAt(Math.max(sel.from, sel.to - 1)).number];
  return desktop.gitWebUrl(path, lines?.[0], lines?.[1]);
}

async function openOnWeb(): Promise<void> {
  if (fileHandle && !active.dirty && gitPanel?.status?.branch?.ahead) {
    toast(t("這個檔案還有提交沒有推送，網頁上看到的可能是舊的內容。"));
  }
  const url = await webLink();
  if (url) await desktop!.openExternal(url);
}

async function copyWebLink(): Promise<void> {
  const url = await webLink();
  if (!url) return;
  await navigator.clipboard.writeText(url);
  toast(url.includes("#L") || url.includes("&line=") ? t("已複製連結（含選取的行號）") : t("已複製連結"));
}

// ---- Git：合併衝突、分支、Pull Request；GitHub Pages、Gist ---------------------

/** 開啟衝突的檔案（磁碟上是都採用本機的內容），逐段和「都採用遠端」比較。 */
async function resolveMergeConflict(path: string, theirs: string): Promise<void> {
  const existing = tabForPath(path);
  if (existing) {
    activate(existing);
    await reloadDoc(existing, path);
  } else {
    await openPath(path);
  }
  if (fileHandle?.path !== path) return;
  if (review.active) review.finish();
  const started = review.start(theirs, {
    title: t("合併衝突：「{name}」", { name: basename(path) }),
    hint: t("每一段選「採用遠端」或「保留本機」，處理完存檔，再到原始碼控制按「完成合併」"),
    acceptLabel: t("採用遠端"),
    rejectLabel: t("保留本機"),
  });
  if (!started) toast(t("這個檔案已經處理好了，存檔後按「完成合併」。"));
  showPanel("git", false);
}

type BranchChoice = { name: string; kind: "local" | "remote" | "new" };

async function switchBranch(): Promise<void> {
  if (!desktop) return;
  const b = await desktop.gitBranches();
  const items: BranchChoice[] = [
    { name: "", kind: "new" },
    ...b.local.map((name) => ({ name, kind: "local" as const })),
    ...b.remote.map((name) => ({ name, kind: "remote" as const })),
  ];
  new Picker<BranchChoice>({
    label: t("切換分支"),
    placeholder: t("目前在「{branch}」，選要切換的分支", { branch: b.current ?? t("（未知）") }),
    empty: t("找不到符合的分支"),
    query: (q) => {
      const needle = q.trim().toLowerCase();
      return items.filter((i) => i.kind === "new" || !needle || i.name.toLowerCase().includes(needle));
    },
    render: (i) =>
      i.kind === "new"
        ? { title: t("建立新分支…"), detail: t("從目前的提交建立，並切換過去"), icon: "plus" }
        : {
            title: i.name,
            detail: i.name === b.current ? t("目前的分支") : i.kind === "remote" ? t("遠端的分支（會在本機建立）") : "",
            icon: "git-branch",
          },
    pick: (i) => void (i.kind === "new" ? createBranch() : checkoutBranch(i.name)).catch(reportError),
  }).open();
}

async function checkoutBranch(name: string): Promise<void> {
  if (!desktop) return;
  if (docs.some((d) => d.dirty)) {
    toast(t("有分頁還沒存檔，請先存檔再切換分支。"), { tone: "error" });
    return;
  }
  toast(await desktop.gitCheckout(name), { tone: "success" });
  await gitPanel?.refresh();
  await fileTree?.refresh();
}

async function createBranch(): Promise<string | null> {
  if (!desktop) return null;
  const name = await askText(t("建立新分支"), t("分支名稱（例如 draft、fix-typo，不能有空白）："), "", t("建立"));
  if (!name?.trim()) return null;
  toast(await desktop.gitCreateBranch(name.trim()), { tone: "success" });
  await gitPanel?.refresh();
  return name.trim();
}

/** 建立 Pull Request：在預設分支上時先建立新分支，推送後在 GitHub 或 Azure DevOps 建立。 */
/** 拉取遠端的更新，再推送自己的提交（拉取失敗或有衝突時不推送）。 */
async function gitSync(): Promise<void> {
  if (!gitPanel) return;
  showPanel("git");
  await gitPanel.pull();
  if (gitPanel.status?.merging) return;
  await gitPanel.push();
}

async function createPullRequest(): Promise<void> {
  const status = gitPanel?.status;
  if (!desktop || !status?.repo) return;
  if (status.changes.length) {
    toast(t("還有未提交的變更，請先提交再建立 Pull Request。"));
    showPanel("git");
    return;
  }
  const branch = status.branch?.name ?? "";
  let newBranch: string | null = null;
  if (/^(main|master|develop|trunk)$/i.test(branch)) {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    newBranch = await askText(
      t("建立 Pull Request"),
      t("目前在「{branch}」。Pull Request 需要另一個分支，會用這個名稱建立新分支並推送：", { branch }),
      `update-${stamp}`,
      t("下一步"),
    );
    if (!newBranch?.trim()) return;
  }
  const title = await askText(t("建立 Pull Request"), t("標題："), "", t("建立"));
  if (!title?.trim()) return;
  const wait = toast(t("正在推送並建立 Pull Request…"), { duration: 600000 });
  try {
    const url = await desktop.gitCreatePr(title.trim(), t("由 oMarker 建立"), newBranch?.trim() || null);
    wait.dismiss();
    toast(t("已建立 Pull Request"), {
      tone: "success",
      duration: 15000,
      action: { label: t("在瀏覽器開啟"), run: () => void desktop!.openExternal(url) },
    });
  } catch (e) {
    wait.dismiss();
    reportError(e);
  } finally {
    await gitPanel?.refresh();
  }
}

/** 用 GitHub Pages 把資料夾發佈成網站。 */
async function publishPages(): Promise<void> {
  if (!desktop) return;
  const ok = await choose(
    t("發佈成網站（GitHub Pages）"),
    t("會把這個儲存庫預設分支的內容發佈成網站，所有人都看得到（就算儲存庫是私人的）。Markdown 會自動轉成網頁，README.md 或 index.md 是首頁。第一次發佈大約要一兩分鐘才看得到。"),
    [
      { id: "cancel", label: t("取消") },
      { id: "go", label: t("發佈"), primary: true },
    ],
  );
  if (ok !== "go") return;
  const wait = toast(t("正在設定 GitHub Pages…"), { duration: 60000 });
  try {
    const url = await desktop.githubPages();
    wait.dismiss();
    toast(t("網站網址：{url}（之後推送就會自動更新）", { url: url.replace(/^https:\/\//, "") }), {
      tone: "success",
      duration: 20000,
      action: { label: t("開啟網站"), run: () => void desktop!.openExternal(url) },
    });
  } catch (e) {
    wait.dismiss();
    reportError(e);
  }
}

/** 把選取的內容（沒有選取時是整份文件）分享成 Gist。 */
async function shareGist(): Promise<void> {
  if (!desktop) return;
  const sel = editor.view.state.selection.main;
  const content = sel.empty ? editor.text : editor.view.state.sliceDoc(sel.from, sel.to);
  if (!content.trim()) {
    toast(t("沒有內容可以分享。"));
    return;
  }
  const visibility = await choose(
    t("分享成 Gist"),
    sel.empty
      ? t("會把整份「{name}」上傳到你的 GitHub Gist，產生一個可以分享的網址。", { name: fileName })
      : t("會把選取的內容上傳到你的 GitHub Gist，產生一個可以分享的網址。"),
    [
      { id: "cancel", label: t("取消") },
      { id: "public", label: t("公開（所有人都找得到）") },
      { id: "secret", label: t("秘密（知道網址的人才看得到）"), primary: true },
    ],
  );
  if (visibility !== "public" && visibility !== "secret") return;
  const wait = toast(t("正在上傳…"), { duration: 60000 });
  try {
    const url = await desktop.githubGist(fileName, content, stem(fileName), visibility === "public");
    wait.dismiss();
    await navigator.clipboard.writeText(url).catch(() => {});
    toast(t("已分享成 Gist，網址已複製"), {
      tone: "success",
      duration: 15000,
      action: { label: t("在瀏覽器開啟"), run: () => void desktop!.openExternal(url) },
    });
  } catch (e) {
    wait.dismiss();
    reportError(e);
  }
}

/** 外部修改後，以修改前的版本為基準逐段標示（A4）。沒有差異時回傳 false。 */
function showExternalChanges(original: string, current: string): boolean {
  return review.start(current, {
    original,
    source: "external",
    title: t("「{name}」被外部程式修改了", { name: fileName }),
    hint: t("逐段檢查改了哪裡；選「還原」後記得存檔"),
    acceptLabel: t("保留"),
    rejectLabel: t("還原"),
  });
}

commands.register(
  {
    id: "toggle-terminal",
    title: t("顯示／隱藏終端機"),
    group: t("AI 與終端機"),
    icon: "square-terminal",
    keys: "Mod-`",
    when: () => !!terminal,
    run: () => terminal?.toggle(),
  },
  {
    id: "ai-actions",
    title: t("AI：處理選取的文字…"),
    group: t("AI 與終端機"),
    icon: "sparkles",
    keys: "Mod-j",
    when: () => !!ai?.enabled && view !== "preview",
    run() {
      const { from, to } = editor.view.state.selection.main;
      if (from === to) toast(t("請先選取要處理的文字。"));
      else aiPicker.open();
    },
  },
  ...(
    [
      [
        "git-commit",
        t("Git：提交變更…"),
        "git-commit-horizontal",
        () => {
          showPanel("git");
          gitPanel?.focusMessage();
        },
      ],
      ["git-pull", t("Git：拉取"), "arrow-down-to-line", () => gitPanel?.pull()],
      ["git-push", t("Git：推送"), "arrow-up-from-line", () => gitPanel?.push()],
    ] as const
  ).map(
    ([id, title, iconName, run]): Command => ({
      id,
      title,
      group: t("檔案"),
      icon: iconName,
      when: () => !!gitPanel?.status?.repo,
      run: () => void run(),
    }),
  ),
  ...(
    [
      ["github-open", t("GitHub：下載或開啟儲存庫…"), "github", () => github?.openRepo(), () => true],
      ["github-publish", t("GitHub：把這個資料夾上傳到 GitHub…"), "arrow-up-from-line", () => github?.publish(), () => !!workspaceRoot && !isRemote(workspaceRoot.path)],
      ["github-login", t("GitHub：登入"), "shield-check", () => github?.login(), () => !github?.account],
      ["github-logout", t("GitHub：登出"), "x", () => github?.logout(), () => !!github?.account],
      [
        "git-commit",
        t("Git：提交變更…"),
        "git-commit-horizontal",
        () => {
          showPanel("git");
          gitPanel?.focusMessage();
        },
        () => !!gitPanel?.status?.repo,
      ],
      ["git-sync", t("Git：同步（拉取再推送）"), "arrow-down-up", () => void gitSync(), () => !!gitPanel?.status?.remote && !gitPanel.status.merging],
      ["git-branch-switch", t("Git：切換或建立分支…"), "git-branch", () => void switchBranch().catch(reportError), () => !!gitPanel?.status?.repo && !gitPanel.status.merging],
      ["git-create-pr", t("Git：建立 Pull Request…"), "git-pull-request", () => void createPullRequest().catch(reportError), () => !!gitPanel?.status?.remote],
      ["git-merge-finish", t("Git：完成合併"), "git-merge", () => void gitPanel?.finishMerge(), () => !!gitPanel?.status?.merging],
      ["github-pages", t("GitHub：發佈成網站（GitHub Pages）…"), "globe", () => void publishPages(), () => !!github?.account && !!issuesRepo],
      ["github-gist", t("GitHub：分享成 Gist…"), "share-2", () => void shareGist(), () => !!github?.account],
      ["ado-open", t("Azure DevOps／TFS：下載或開啟儲存庫、Wiki…"), "briefcase-business", () => ado?.openRepo(), () => !!ado],
      ["ado-items", t("Azure DevOps／TFS：工作項目"), "square-kanban", () => showAdo("workitems"), () => !!ado?.account],
      ["ado-wiki", t("Azure DevOps／TFS：Wiki"), "book-open-text", () => showAdo("wiki"), () => !!ado?.account],
      ["ado-connect", t("Azure DevOps／TFS：連線設定…"), "shield-check", () => settingsDialog.open(t("Azure DevOps／TFS")), () => !!ado],
    ] as const
  ).map(
    ([id, title, iconName, run, when]): Command => ({
      id,
      title,
      group: "Git",
      icon: iconName,
      when: () => !!github && when(),
      run: () => void run(),
    }),
  ),
  {
    id: "open-recent",
    title: t("最近開啟…"),
    group: t("檔案"),
    icon: "clock",
    when: () => !!desktop,
    run: () => recentPicker.open(),
  },
  {
    id: "activity-add",
    title: t("圖示列：新增按鈕…"),
    group: t("檢視"),
    icon: "plus",
    run: () => addActivityCommand(),
  },
  {
    id: "activity-customize",
    title: t("圖示列：自訂…"),
    group: t("檢視"),
    icon: "settings",
    run: () => settingsDialog.open(t("外觀")),
  },
  {
    id: "git-history",
    title: t("Git：顯示歷史（線圖）"),
    group: t("Git"),
    icon: "git-graph",
    keys: "Mod-Alt-h",
    when: () => !!desktop && !!gitPanel?.status?.repo,
    run: () => openGitHistory(),
  },
  {
    id: "git-file-history",
    title: t("Git：這個檔案的提交歷史…"),
    group: t("Git"),
    icon: "git-commit-horizontal",
    when: () => !!desktop && !!fileHandle?.path && !!gitPanel?.status?.repo,
    run: () => openGitHistory(fileHandle?.path ?? null),
  },
  {
    id: "git-open-web",
    title: t("Git：在網頁上開啟這個檔案（GitHub／Azure DevOps）"),
    group: t("Git"),
    icon: "external-link",
    when: () => !!desktop && !!fileHandle?.path && !!gitPanel?.status?.remote,
    run: () => void openOnWeb().catch(reportError),
  },
  {
    id: "git-copy-link",
    title: t("Git：複製這個檔案的網頁連結"),
    group: t("Git"),
    icon: "link",
    when: () => !!desktop && !!fileHandle?.path && !!gitPanel?.status?.remote,
    run: () => void copyWebLink().catch(reportError),
  },
  {
    id: "history",
    title: t("版本記錄…"),
    group: t("檔案"),
    icon: "history",
    when: () => !!desktop && !!fileHandle?.path,
    run: () => historyPicker.open(),
  },
  {
    id: "check-update",
    title: t("檢查更新"),
    group: t("說明"),
    icon: "refresh-cw",
    when: () => !!updater,
    run: () => updater?.check(),
  },
  {
    id: "ai-cancel",
    title: t("AI：取消處理中的動作"),
    group: t("AI 與終端機"),
    icon: "circle-stop",
    when: () => !!ai?.running,
    run: () => ai?.cancel(),
  },
  ...(["claude", "codex"] as const).map(
    (tool): Command => ({
      id: `start-${tool}`,
      title: t("AI：在終端機啟動 {tool}", { tool: tool === "claude" ? "Claude Code" : "Codex" }),
      group: t("AI 與終端機"),
      icon: "sparkles",
      // 沒開啟 AI 協作或沒安裝時也列出來，按下去說明怎麼開始，而不是找不到這個功能。
      when: () => !!terminal,
      run: () => void startAiTool(tool),
    }),
  ),
  {
    id: "insert-symbol",
    title: t("插入符號…"),
    group: t("插入"),
    icon: "omega",
    keys: "Mod-Alt-s",
    when: () => view !== "preview",
    run: () => symbolPicker.open(),
  },
  ...(
    [
      ["cut", t("剪下"), "scissors", "Mod-x", () => copySelection(true)],
      ["copy", t("複製"), "copy", "Mod-c", () => copySelection(false)],
      ["paste", t("貼上"), "clipboard-paste", "Mod-v", () => pasteFromClipboard(false)],
      ["paste-plain", t("貼上純文字"), "clipboard-type", "Mod-Shift-v", () => pasteFromClipboard(true)],
      ["select-all", t("全選"), "text-cursor", "Mod-a", () => editor.exec(selectAll)],
      ["indent-more", t("增加縮排"), "list-indent-increase", "Tab", () => editor.exec(indentMore)],
      ["indent-less", t("減少縮排"), "list-indent-decrease", "Shift-Tab", () => editor.exec(indentLess)],
    ] as const
  ).map(
    ([id, title, iconName, shownKeys, run]): Command => ({
      id,
      title,
      group: t("編輯"),
      icon: iconName,
      shownKeys,
      when: () =>
        view !== "preview" && ((id !== "cut" && id !== "copy") || !editor.view.state.selection.main.empty),
      run: () => void run(),
    }),
  ),
  {
    id: "send-to-terminal-ai",
    title: t("AI：把選取範圍傳給終端機中的 Claude Code／Codex"),
    group: t("AI 與終端機"),
    icon: "square-terminal",
    keys: "Mod-Alt-j",
    when: () => terminalAiReady() && view !== "preview",
    run: () => sendSelectionToAi(),
  },
  {
    id: "ai-settings",
    title: t("AI 協作設定…"),
    group: t("AI 與終端機"),
    icon: "sparkles",
    when: () => !!desktop,
    run: () => settingsDialog.open(t("AI 協作")),
  },
  {
    id: "git-claude-workflow",
    title: t("Git：加入 Claude Code 自動校對（GitHub Actions）…"),
    group: t("Git"),
    icon: "github",
    when: () => !!gitPanel?.status?.repo && !!workspaceRoot && !isRemote(workspaceRoot.path),
    run: () => addClaudeWorkflow(),
  },
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
    const inField =
      (target.matches("input, select, textarea") && !target.closest(".cm-editor")) || target.isContentEditable && !!target.closest(".cm-lp-table");
    if (inField && (cmd.group === t("格式") || cmd.group === t("插入"))) return;
    e.preventDefault();
    e.stopPropagation();
    commands.run(cmd.id).catch(reportError);
  },
  { capture: true },
);

function reportError(e: unknown): void {
  console.error(e);
  const message = e instanceof Error ? e.message : String(e);
  // 訊息本身已經說了哪個動作失敗（「無法儲存…」「拉取失敗：…」）：不再加上「操作失敗」。
  const described = /^(無法|不能|找不到|Couldn't|Can't|Cannot|Unable)/i.test(message) || /^[^：:]{1,24}(失敗|failed)[：:]/i.test(message);
  toast(described ? message : t("操作失敗：{error}", { error: message }), { tone: "error" });
}

// ---- 工具列 -------------------------------------------------------------

function withKeys(title: string, keys?: string): string {
  return keys ? t("{title}（{keys}）", { title, keys: formatKeys(keys) }) : title;
}

document.querySelectorAll<HTMLButtonElement>("[data-command]").forEach((btn) => {
  const cmd = commands.get(btn.dataset.command!)!;
  btn.title = withKeys(cmd.title, cmd.keys);
  if (btn.classList.contains("icon-only")) btn.setAttribute("aria-label", cmd.title);
  btn.addEventListener("click", () => commands.run(cmd.id).catch(reportError));
});
setupMenu($<HTMLButtonElement>("#main-menu"), commands, [
  "new",
  "new-from-template",
  "open",
  "import-docx",
  "-",
  {
    label: t("專案"),
    icon: "folder-kanban",
    items: [
      "switch-project",
      "project-overview",
      "project-settings",
      "close-folder",
      "-",
      "open-folder",
      "github-open",
      "ado-open",
      "connect-webdav",
      "connect-ssh",
      "open-recent",
    ],
  },
  "-",
  "save",
  "save-as",
  "history",
  "-",
  {
    label: t("Git"),
    icon: "git-branch",
    items: ["show-git", "git-history", "git-commit", "git-sync", "git-branch-switch", "git-create-pr", "-", "git-file-history", "git-open-web", "git-copy-link"],
  },
  { label: t("匯出"), icon: "download", items: ["export-pdf", "export-docx", "export-html", "print", "-", "copy-rich"] },
  "fix-terms",
  "s2t",
  "slideshow",
  "-",
  { label: t("AI 與終端機"), icon: "sparkles", items: ["toggle-terminal", "start-claude", "start-codex", "-", "ai-settings"] },
  { label: t("主題"), icon: "sun", items: ["theme-system", "theme-light", "theme-dark"] },
  {
    label: t("說明"),
    icon: "circle-help",
    items: ["show-shortcuts", "show-welcome", "show-changelog", "-", "check-update", "report-issue", "-", "about"],
  },
  "palette",
  "settings",
]);
setupMenu($<HTMLButtonElement>("#files-more"), commands, [
  "switch-project",
  "project-overview",
  "project-settings",
  "close-folder",
  "open-folder",
  "github-open",
  "ado-open",
  "connect-webdav",
  "connect-ssh",
  "open-recent",
]);
// 側邊欄圖示的提示附上快速鍵（例如「檔案（Ctrl+Shift+E）」）。
for (const [tab, id] of [
  ["#side-tab-files", "show-files"],
  ["#side-tab-search", "search-in-folder"],
  ["#side-tab-git", "show-git"],
] as const) {
  const keys = commands.get(id)?.keys;
  const el = $(tab);
  if (keys) el.dataset.keys = formatKeys(keys);
  if (keys) el.title = t("{label}（{keys}）", { label: el.getAttribute("aria-label") ?? "", keys: formatKeys(keys) });
}

// ---- 左側圖示列：面板圖示的順序與顯示、釘上去的指令按鈕 ----------------------

/** 面板圖示的名稱（aria-label 會加上變更數，這裡用固定的名稱）。 */
const PANEL_LABELS: Record<SidePanel, () => string> = {
  files: () => t("檔案"),
  outline: () => t("大綱"),
  search: () => t("搜尋"),
  tasks: () => t("待辦總覽"),
  tags: () => t("標籤"),
  issues: () => t("Issues（GitHub）"),
  ado: () => t("Azure DevOps（工作項目、Wiki）"),
  git: () => t("原始碼控制（Git）"),
};
const PANEL_ICONS: Record<SidePanel, string> = {
  files: "files",
  outline: "list-tree",
  search: "search",
  tasks: "list-checks",
  tags: "tags",
  issues: "circle-dot",
  ado: "square-kanban",
  git: "git-branch",
};

/** 依設定排列面板圖示（沒列到的照預設順序排在後面）、隱藏使用者不要的圖示。 */
function panelOrder(): SidePanel[] {
  // 舊版存的「工作項目」「Wiki」換成合併後的「Azure DevOps」。
  const ids = settings.value.activityOrder.map((p) => (LEGACY_ADO_PANELS.includes(p) ? "ado" : p));
  const saved = [...new Set(ids)].filter((p): p is SidePanel => (SIDE_PANELS as string[]).includes(p));
  return [...saved, ...SIDE_PANELS.filter((p) => !saved.includes(p))];
}

function applyActivityLayout(): void {
  const bar = $(".activity-tabs");
  for (const p of panelOrder()) bar.append($(`#side-tab-${p}`));
  const hidden = settings.value.activityHidden;
  // 舊版兩個都隱藏了，合併後的「Azure DevOps」也隱藏。
  const isHidden = (p: string) => hidden.includes(p) || (p === "ado" && LEGACY_ADO_PANELS.every((x) => hidden.includes(x)));
  for (const tab of sideTabs) tab.classList.toggle("user-hidden", isHidden(tab.dataset.panel!));
  renderActivityCommands();
}

/** 釘上去的指令按鈕。 */
function renderActivityCommands(): void {
  const box = $(".activity-cmds");
  box.replaceChildren(
    ...settings.value.activityCommands.flatMap((id) => {
      const cmd = commands.get(id);
      if (!cmd) return [];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "activity-btn activity-cmd";
      b.dataset.command = id;
      b.title = withKeys(cmd.title, cmd.keys);
      b.setAttribute("aria-label", cmd.title);
      b.draggable = true;
      b.append(icon(cmd.icon ?? "command"));
      b.addEventListener("click", () => {
        if (HISTORY_COMMANDS.includes(id) && historyView?.isOpen) historyView.close();
        else void commands.run(id).catch(reportError);
      });
      return [b];
    }),
  );
  markHistoryButtons();
  refreshActivityCommands();
}

/** 指令能不能用會隨著開啟的資料夾、Git 狀態改變（例如沒有 Git 儲存庫時不顯示 Git 歷史）。 */
function refreshActivityCommands(): void {
  const box = $(".activity-cmds");
  for (const b of box.querySelectorAll<HTMLButtonElement>("button")) {
    const cmd = commands.get(b.dataset.command!);
    b.hidden = !cmd || !(cmd.when?.() ?? true);
  }
  box.hidden = ![...box.querySelectorAll("button")].some((b) => !(b as HTMLElement).hidden);
}

function setActivity(patch: Partial<Pick<Settings, "activityOrder" | "activityHidden" | "activityCommands">>): void {
  settings.update(patch);
}

/** 選一個指令釘到圖示列上。 */
function pickActivityCommand(): Promise<string | null> {
  return new Promise((resolve) => {
    let picked: string | null = null;
    const picker = new Picker<Command>({
      label: t("新增按鈕到圖示列"),
      placeholder: t("選一個指令，放到左邊的圖示列"),
      empty: t("找不到符合的指令"),
      columns: true,
      query: (q) => {
        const pinned = new Set(settings.value.activityCommands);
        const needle = q.trim().toLowerCase();
        return sortByGroup(commands.available()).filter(
          (c) => c.icon && !pinned.has(c.id) && c.id !== "palette" && (!needle || `${c.group} ${c.title}`.toLowerCase().includes(needle)),
        );
      },
      render: (c) => ({ title: c.title, detail: c.group, icon: c.icon, keys: c.keys && formatKeys(c.keys) }),
      pick: (c) => (picked = c.id),
      closed: () => resolve(picked),
    });
    picker.open();
  });
}

async function addActivityCommand(): Promise<void> {
  const id = await pickActivityCommand();
  if (!id) return;
  const list = settings.value.activityCommands.filter((x) => x !== id);
  if (list.length >= ACTIVITY_LIMIT) {
    toast(t("圖示列最多放 {n} 個按鈕。", { n: ACTIVITY_LIMIT }), { tone: "error" });
    return;
  }
  setActivity({ activityCommands: [...list, id] });
  toast(t("已把「{name}」放到圖示列，拖曳可以調整位置。", { name: commands.get(id)?.title ?? id }), { tone: "success" });
}

/** 圖示列的右鍵選單：勾選要顯示的面板與按鈕、新增按鈕、到設定調整。 */
function openActivityMenu(at: DOMRect): void {
  for (const id of ["activity-menu-anchor", "activity-menu-anchor-popover"]) document.getElementById(id)?.remove();
  const toggleHidden = (p: SidePanel) => {
    const hidden = settings.value.activityHidden;
    setActivity({ activityHidden: hidden.includes(p) ? hidden.filter((x) => x !== p) : [...hidden, p] });
  };
  const entries: MenuEntry[] = [
    ...panelOrder()
      .filter((p) => !$(`#side-tab-${p}`).hidden)
      .map((p) => ({
        label: PANEL_LABELS[p](),
        icon: PANEL_ICONS[p],
        checked: () => !settings.value.activityHidden.includes(p),
        run: () => toggleHidden(p),
      })),
    "-",
    ...settings.value.activityCommands.flatMap((id) => {
      const cmd = commands.get(id);
      return cmd
        ? [
            {
              label: cmd.title,
              icon: cmd.icon,
              checked: () => settings.value.activityCommands.includes(id),
              run: () => setActivity({ activityCommands: settings.value.activityCommands.filter((x) => x !== id) }),
            },
          ]
        : [];
    }),
    "activity-add",
    "activity-customize",
  ];
  floatingMenu("activity-menu-anchor", entries).open(at);
}

{
  const bar = $(".activity-bar");
  bar.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".activity-project")) return;
    e.preventDefault();
    const at = new DOMRect(e.clientX, e.clientY, 0, 0);
    // Linux 在按下右鍵時就觸發 contextmenu：等放開再開，免得放開時被當成點在選單外。
    if (e.buttons & 2) window.addEventListener("pointerup", () => setTimeout(() => openActivityMenu(at)), { once: true });
    else openActivityMenu(at);
  });
  // 拖曳圖示調整順序（面板圖示、釘選的按鈕各自排）。
  let dragging: HTMLElement | null = null;
  bar.addEventListener("dragstart", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".activity-tabs [role=tab], .activity-cmd");
    if (!el || !e.dataTransfer) return;
    dragging = el;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", el.getAttribute("aria-label") ?? "");
    el.classList.add("activity-dragging");
  });
  bar.addEventListener("dragover", (e) => {
    if (!dragging) return;
    const over = (e.target as HTMLElement).closest<HTMLElement>(".activity-tabs [role=tab], .activity-cmd");
    if (!over || over === dragging || over.parentElement !== dragging.parentElement) return;
    e.preventDefault();
    const r = over.getBoundingClientRect();
    over.parentElement!.insertBefore(dragging, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  });
  bar.addEventListener("dragend", () => {
    if (!dragging) return;
    dragging.classList.remove("activity-dragging");
    const fromTabs = dragging.parentElement === $(".activity-tabs");
    dragging = null;
    if (fromTabs) {
      setActivity({ activityOrder: [...$(".activity-tabs").querySelectorAll<HTMLElement>("[role=tab]")].map((b) => b.dataset.panel!) });
    } else {
      setActivity({ activityCommands: [...$(".activity-cmds").querySelectorAll<HTMLElement>(".activity-cmd")].map((b) => b.dataset.command!) });
    }
  });
  for (const tab of sideTabs) tab.draggable = true;
}

/** 安裝說明的網址。 */
const AI_INSTALL_URL = { claude: "https://docs.claude.com/en/docs/claude-code/setup", codex: "https://github.com/openai/codex" } as const;

/** 在終端機啟動 AI 工具；還沒開啟 AI 協作或沒安裝時，說明下一步。 */
async function startAiTool(tool: "claude" | "codex"): Promise<void> {
  const name = tool === "claude" ? "Claude Code" : "Codex";
  if (!ai?.enabled) {
    toast(t("要先在設定開啟「啟用 AI 協作」，才能在終端機使用 {name}。", { name }), {
      duration: 12000,
      action: { label: t("開啟設定"), run: () => settingsDialog.open(t("AI 協作")) },
    });
    return;
  }
  if (!aiFound[tool]) {
    toast(t("這台電腦還沒有安裝 {name}。安裝好之後重新開啟 oMarker 就能使用。", { name }), {
      duration: 15000,
      action: { label: t("安裝說明"), run: () => void desktop?.openExternal(AI_INSTALL_URL[tool]).catch(reportError) },
    });
    return;
  }
  await terminal?.start(tool);
}

/** 說明：在新分頁開啟歡迎文件（第一次開啟時看到的那份），之後也找得回來。 */
function openWelcome(): void {
  const existing = docs.find((d) => !d.path && d.name === t("歡迎使用 oMarker.md"));
  if (existing) {
    activate(existing);
    return;
  }
  const doc = makeDoc({ name: t("歡迎使用 oMarker.md"), kind: "markdown", baseline: hash(sample) });
  saveDraft(doc.id, sample);
  addTab(doc);
}

/** 說明：在新分頁開啟更新紀錄（打包進程式的 CHANGELOG.md，用到時才載入）。 */
async function openChangelog(): Promise<void> {
  const name = t("oMarker 更新紀錄.md");
  const existing = docs.find((d) => !d.path && d.name === name);
  if (existing) {
    activate(existing);
    return;
  }
  const { default: changelog } = await import("../../CHANGELOG.md?raw");
  // 開頭的說明連到儲存庫裡的其他檔案，在這裡點不開：從第一個版本開始。
  const start = changelog.indexOf("\n## ");
  const text = "# " + t("oMarker 更新紀錄") + "\n" + (start >= 0 ? changelog.slice(start) : changelog);
  const doc = makeDoc({ name, kind: "markdown", baseline: hash(text) });
  saveDraft(doc.id, text);
  addTab(doc);
}

/** 用瀏覽器開啟網址（桌面版交給系統的預設瀏覽器）。 */
function openUrl(url: string): void {
  if (desktop) void desktop.openExternal(url).catch(reportError);
  else window.open(url, "_blank", "noopener");
}

/** 說明：所有快速鍵（依功能分組，只列目前能用的）。 */
function showShortcuts(): void {
  const dialog = document.createElement("dialog");
  dialog.className = "choice shortcuts-dialog";
  dialog.setAttribute("aria-label", t("快速鍵一覽"));
  const h = document.createElement("h2");
  h.textContent = t("快速鍵一覽");
  const hint = document.createElement("p");
  hint.textContent = t("編輯區裡按 Tab 是縮排；要用鍵盤離開編輯區，先按 Esc 再按 Tab。所有功能都可以用 {keys} 搜尋。", { keys: formatKeys("Mod-Shift-p") });
  const body = document.createElement("div");
  body.className = "shortcuts-body";
  const groups = new Map<string, [string, string][]>();
  for (const c of sortByGroup(commands.available())) {
    const keys = c.keys ?? c.shownKeys;
    if (!keys) continue;
    const list = groups.get(c.group ?? "") ?? [];
    list.push([c.title, formatKeys(keys)]);
    groups.set(c.group ?? "", list);
  }
  for (const [group, items] of groups) {
    const g = document.createElement("h3");
    g.textContent = group;
    const table = document.createElement("table");
    for (const [title, keys] of items) {
      const row = table.insertRow();
      row.insertCell().textContent = title;
      const k = document.createElement("kbd");
      k.textContent = keys;
      row.insertCell().append(k);
    }
    body.append(g, table);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-primary";
  close.textContent = t("關閉");
  close.autofocus = true;
  close.addEventListener("click", () => dialog.close());
  const actions = document.createElement("div");
  actions.className = "choice-actions";
  actions.append(close);
  dialog.append(h, hint, body, actions);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

for (const el of document.querySelectorAll<HTMLButtonElement>(".project-switch, #activity-project")) {
  el.disabled = !desktop;
  el.addEventListener("click", () => void commands.run("switch-project").catch(reportError));
}
// Windows 桌面版：頂端列兼當標題列。
void desktop
  ?.customTitleBar()
  .then((custom) => {
    if (custom) setupWindowControls($(".topbar"), (action) => desktop!.windowControl(action));
  })
  .catch(console.error);
status.save.addEventListener("click", () => void commands.run("save").catch(reportError));

/** 格式工具列的下拉按鈕（標題、插入），建立一次之後重複使用。 */
function formatMenuButton(id: string, label: string, iconName: string, entries: string[]): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.id = id;
  b.className = "btn format-menu";
  b.title = label;
  b.append(icon(iconName), Object.assign(document.createElement("span"), { textContent: label }), icon("chevron-down"));
  b.addEventListener("mousedown", (e) => e.preventDefault());
  setupMenu(b, commands, entries);
  return b;
}
const headingMenu = formatMenuButton("fmt-heading", t("標題"), "heading", ["h1", "h2", "h3"]);
const insertMenu = formatMenuButton("fmt-insert", t("插入"), "plus", [
  "table",
  "code-block",
  "math-block",
  "mermaid-block",
  "insert-image",
  "hr",
]);

/** 執行指令的按鈕（格式工具列、選取時浮出的按鈕共用）。 */
function commandButton(id: string, withLabel = false): HTMLButtonElement {
  const cmd = commands.get(id)!;
  const b = document.createElement("button");
  b.type = "button";
  b.className = withLabel ? "btn" : "btn icon-only";
  b.title = withKeys(cmd.title, cmd.keys);
  b.setAttribute("aria-label", cmd.title);
  b.append(icon(cmd.icon!));
  if (withLabel) b.append(Object.assign(document.createElement("span"), { textContent: cmd.title }));
  // 用 mousedown 阻止預設行為，按下按鈕時編輯器才不會失去選取範圍。
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => commands.run(id).catch(reportError));
  return b;
}

function separator(className: string): HTMLElement {
  const sep = document.createElement("span");
  sep.className = className;
  sep.setAttribute("aria-hidden", "true");
  return sep;
}

/** 選取文字時浮出的格式按鈕。 */
function formatBubble(): HTMLElement {
  const bar = document.createElement("div");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", t("格式"));
  bar.append(...["bold", "italic", "underline", "strike", "highlight", "code", "link"].map((id) => commandButton(id)));
  const more = document.createElement("button");
  more.type = "button";
  more.className = "btn icon-only";
  more.title = t("更多格式（上標、下標、清除格式、符號）");
  more.setAttribute("aria-label", t("更多格式"));
  more.append(icon("ellipsis"));
  more.addEventListener("mousedown", (e) => e.preventDefault());
  more.addEventListener("click", () => moreFormatMenu.open(more.getBoundingClientRect()));
  bar.append(more);
  const aiButtons = ["ai-actions", "send-to-terminal-ai"].filter((id) => commands.get(id)?.when?.() ?? false);
  if (aiButtons.length) bar.append(separator("format-sep"), ...aiButtons.map((id) => commandButton(id)));
  return bar;
}

/**
 * 浮動選單（插入選單、更多格式、右鍵選單）：用一個看不見的定位按鈕決定選單出現的位置。
 * 按 Esc 或點外面關閉時，焦點回到編輯器。
 */
function floatingMenu(id: string, entries: MenuEntry[], onClose?: () => void): { open(at: DOMRect): void } {
  const anchor = document.createElement("button");
  anchor.type = "button";
  anchor.id = id;
  anchor.className = "insert-anchor";
  anchor.tabIndex = -1;
  document.body.append(anchor);
  const menu = setupMenu(anchor, commands, entries);
  menu.addEventListener("toggle", (e) => {
    const closed = (e as ToggleEvent).newState === "closed";
    if (closed && (document.activeElement === anchor || document.activeElement === document.body)) editor.view.focus();
    if (closed) onClose?.();
  });
  return {
    open(at) {
      Object.assign(anchor.style, {
        left: `${at.left}px`,
        top: `${at.top}px`,
        width: `${at.width}px`,
        height: `${at.height}px`,
      });
      if (!menu.matches(":popover-open")) anchor.click();
    },
  };
}

/**
 * 桌面版：其他元件沒有處理的右鍵（搜尋框、設定欄位、預覽裡選取的文字等）改用自己的小選單，
 * 不顯示 WebView2 內建的選單（裡面有重新整理、列印與 Windows 的語音輸入）。
 */
if (desktop) {
  window.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const field = textField(e.target as Element);
    const entries = field ? fieldMenu(field) : selectionMenu();
    if (!entries.length) return;
    const at = new DOMRect(e.clientX, e.clientY, 0, 0);
    const open = () => {
      const ids = ["text-menu-anchor", "text-menu-anchor-popover"];
      for (const id of ids) document.getElementById(id)?.remove();
      const menu = floatingMenu("text-menu-anchor", entries, () => field?.focus());
      // 開著對話框（例如設定）時，對話框以外的東西都不能點：選單要放進對話框裡。
      const modal = [...document.querySelectorAll("dialog")].filter((d) => d.matches(":modal")).at(-1);
      if (modal) for (const id of ids) modal.append(document.getElementById(id)!);
      menu.open(at);
    };
    // Linux 按下右鍵就觸發 contextmenu：等放開再開，免得放開時被當成點在選單外。
    if (e.buttons & 2) window.addEventListener("pointerup", () => setTimeout(open), { once: true });
    else open();
  });
}

/** 插入選單：空白行左邊的「＋」或 Ctrl+Shift+Enter 開啟，位置跟著按鈕或游標。 */
const insertMenuUi = floatingMenu("insert-anchor", [
  "h1",
  "h2",
  "h3",
  "-",
  "bullet",
  "ordered",
  "task",
  "quote",
  "-",
  "table",
  "code-block",
  "math-block",
  "mermaid-block",
  "insert-image",
  "hr",
  "insert-toc",
  "-",
  "insert-symbol",
]);
const openInsertMenu = (at: DOMRect) => insertMenuUi.open(at);

/** 斜線指令的項目：插入選單的內容，加上篩選用的英文與別名（中文別名不是介面文字，兩種語言都能用來篩選）。 */
const SLASH_KEYWORDS: Record<string, string> = {
  h1: "h1 heading 大標題", // i18n-ignore
  h2: "h2 heading",
  h3: "h3 heading",
  bullet: "ul list bullet 清單", // i18n-ignore
  ordered: "ol list number 數字 編號", // i18n-ignore
  task: "todo task checkbox 待辦 勾選", // i18n-ignore
  quote: "quote blockquote 引言", // i18n-ignore
  table: "table 表", // i18n-ignore
  "code-block": "code 程式", // i18n-ignore
  "math-block": "math latex 數學 公式", // i18n-ignore
  "mermaid-block": "mermaid diagram flow 圖", // i18n-ignore
  "insert-image": "image img picture 照片", // i18n-ignore
  hr: "hr line divider 分隔", // i18n-ignore
  "insert-toc": "toc 目錄", // i18n-ignore
  "insert-symbol": "symbol 符號 特殊", // i18n-ignore
  "insert-today": "date today 日期 今天", // i18n-ignore
};
function slashItems(): SlashItem[] {
  return Object.entries(SLASH_KEYWORDS).flatMap(([id, keywords]) => {
    if (id === "insert-today") return [{ id, title: t("今天的日期"), keywords }];
    const cmd = commands.get(id);
    if (!cmd || !(cmd.when?.() ?? true)) return [];
    const keys = cmd.keys ?? cmd.shownKeys;
    return [{ id, title: cmd.title, keywords, keys: keys ? formatKeys(keys) : undefined }];
  });
}
const slashSource = slashCompletion(slashItems, (id) => {
  if (id === "insert-today") {
    editor.view.dispatch(editor.view.state.replaceSelection(dateFormats(new Date())[0].text), { userEvent: "input" });
    return;
  }
  void commands.run(id).catch(reportError);
});

/** 浮出格式按鈕的「更多」：上標、下標、清除格式、符號。 */
const moreFormatMenu = floatingMenu("format-more-anchor", ["superscript", "subscript", "-", "clear-format", "insert-symbol"]);

/** 分頁的右鍵選單。 */
const tabMenu = floatingMenu(
  "tab-menu-anchor",
  [
    "tab-close",
    "tab-close-others",
    "tab-close-all",
    "tab-close-right",
    "tab-close-saved",
    "-",
    { label: t("固定分頁"), icon: "pin", checked: () => !!menuTab().pinned, run: () => setPinned(menuTab(), !menuTab().pinned) },
    "-",
    "tab-copy-path",
    "tab-reveal",
  ],
  // 選單關閉後，指令面板裡的分頁指令回到「目前的分頁」。等點下的指令先讀到按右鍵的分頁。
  () => setTimeout(() => (menuTabId = null)),
);

const contextMenu = floatingMenu("context-anchor", [
  "cut",
  "copy",
  "copy-rich",
  "paste",
  "paste-plain",
  "select-all",
  "-",
  "bold",
  "italic",
  "underline",
  "strike",
  "highlight",
  "code",
  "superscript",
  "subscript",
  "clear-format",
  "-",
  "link",
  "insert-symbol",
  "indent-more",
  "indent-less",
  "-",
  "ai-actions",
  "send-to-terminal-ai",
  "-",
  "git-copy-link",
]);

const symbolPicker = new SymbolPicker((text) => {
  editor.view.dispatch(editor.view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.symbol" });
  editor.view.focus();
});

let slideshow: Slideshow | null = null;

/** 簡報模式：用預覽的內容（公式、流程圖都畫好了）切成一頁一頁播放。 */
async function startSlideshow(fromCursor: boolean): Promise<void> {
  renderNow(true);
  // 等流程圖等非同步的外掛畫完。
  await new Promise((r) => setTimeout(r, 120));
  const slides = splitSlides(previewEl);
  if (!slides.length) {
    toast(t("文件是空的，沒有可以播放的內容。"));
    return;
  }
  slideshow ??= new Slideshow();
  const line = editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number;
  slideshow.open(slides, fromCursor ? slideAtLine(slides, line) : 0, () => editor.view.focus());
  if (slides.length === 1 && !editor.text.includes("\n---")) {
    toast(t("用一行 --- 把內容分成多頁；沒有分隔線時，每個一級、二級標題各一頁。"), { duration: 6000 });
  }
}

/** 讓使用者選一個檔案（網頁版）。 */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.hidden = true;
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

/**
 * 匯入 Word：桌面版在 Word 檔旁邊存成同名的 .md（圖片存到旁邊的 assets 資料夾）並開啟；
 * 網頁版開成新分頁，圖片內嵌在文件裡。
 */
async function importDocx(): Promise<void> {
  if (desktop) {
    const picked = await desktop.importDocx();
    if (picked) await importDocxData(picked.name, picked.data, picked.mdPath);
    return;
  }
  let file: File | null = null;
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: [{ description: t("Word 文件"), accept: { [DOCX_TYPE]: [".docx"] } }] });
      file = await handle.getFile();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      throw e;
    }
  } else file = await pickFile(`.docx,${DOCX_TYPE}`);
  if (file) await importDocxData(file.name, await file.arrayBuffer(), null);
}

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** 轉換 Word 檔：`mdPath` 是要存成的 Markdown 檔（桌面版選檔匯入），null 時開成未存檔的新分頁、圖片內嵌。 */
async function importDocxData(name: string, data: ArrayBuffer, mdPath: string | null): Promise<void> {
  toast(t("正在轉換「{name}」…", { name }));
  const { docxToMarkdown, imageExtension } = await import("./docx-import.ts");
  let skipped = 0;
  const result = await docxToMarkdown(data, async (bytes, type) => {
    let ext = imageExtension(type);
    if (!ext) {
      skipped++;
      return "";
    }
    if (settings.value.imageCompress) {
      const c = await compressImage(new File([bytes as BlobPart], `image.${ext}`, { type }));
      if (c.changed) {
        bytes = new Uint8Array(await c.file.arrayBuffer());
        type = c.file.type;
        ext = imageExtension(type) ?? ext;
      }
    }
    // 檔名可能有空白或括號（「週報 (2)-….png」），連結中要編碼。
    if (mdPath) return encodeLinkPath(await desktop!.saveImage(mdPath, bytesToBase64(bytes), ext));
    return `data:${type};base64,${bytesToBase64(bytes)}`;
  });
  const notes = [
    skipped ? t("{n} 張圖片的格式不支援（例如 EMF 向量圖），沒有匯入", { n: skipped }) : "",
    result.warnings.length ? t("有 {n} 處格式沒辦法完整轉換", { n: result.warnings.length }) : "",
  ].filter(Boolean);
  if (mdPath) {
    const out = await saveFile(result.markdown, basename(mdPath), "markdown", desktopHandle(mdPath, basename(mdPath)));
    if (!out || out.status !== "saved") return;
    fileListCache = null;
    indexStale = true;
    await openPath(mdPath);
    void fileTree?.refresh([dirname(mdPath)]);
    toast(t("已匯入「{name}」，存成「{file}」。{notes}", { name, file: basename(mdPath), notes: notes.join(t("；")) }), { tone: "success", duration: notes.length ? 10000 : undefined });
  } else {
    openDocument(replaceExtension(name, ".md"), result.markdown, null, { kind: "markdown", fromFile: false });
    toast(t("已匯入「{name}」，存檔時再選擇位置。{notes}", { name, notes: notes.join(t("；")) }), { tone: "success", duration: notes.length ? 10000 : undefined });
  }
}

/**
 * 匯出 Word：圖片從本機、遠端資料夾或網址讀取，讀不到的改成文字說明。
 * 桌面版在後端產生 .docx（Rust）；網頁版用 docx 套件。
 */
async function exportDocx(): Promise<void> {
  refreshToc();
  const docDir = fileHandle?.path ? dirname(fileHandle.path) : null;
  const { loadImage } = await import("./docx-image.ts");
  const image = async (src: string) => {
    let url: string | null = null;
    if (/^(https?:|data:image\/)/i.test(src)) url = src;
    else if (desktop && docDir) {
      const path = localImagePath(src, docDir);
      if (path) url = isRemote(path) ? await desktop.davImage(path) : desktop.fileUrl(path);
    }
    return url ? loadImage(url) : null;
  };
  const title = stem(fileName);
  let bytes: Uint8Array;
  if (desktop) {
    const images = await Promise.all(
      imageUrls(editor.text).map(async (url) => {
        const img = await image(url).catch(() => null);
        return img && { url, kind: img.type, width: img.width, height: img.height, data: bytesToBase64(img.data) };
      }),
    );
    bytes = new Uint8Array(await desktop.exportDocx(editor.text, title, images.filter((i) => i !== null)));
  } else {
    const { htmlToDocx } = await import("./docx-export.ts");
    const blob = await htmlToDocx(renderMarkdown(editor.text, { kind: "markdown" }).html, { title, image });
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  const name = replaceExtension(fileName, ".docx");
  const saved = await downloadBytes(
    name,
    bytes,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    t("Word 文件"),
  );
  if (saved && desktop) toast(t("已匯出「{name}」", { name: basename(saved) }), { tone: "success" });
}

/** 文件有目錄區塊（<!-- toc -->）時，依目前的標題更新（存檔前呼叫）。 */
function refreshToc(): void {
  if (kind !== "markdown") return;
  const text = editor.text;
  if (!text.includes(TOC_START)) return;
  const next = updateToc(text, renderMarkdown(text, { kind: "markdown", skipHtml: true }).headings);
  if (next !== null) editor.replaceAll(next, { userEvent: "input.toc" });
}

/** 插入目錄；已經有目錄時改成更新。 */
function insertToc(): void {
  const text = editor.text;
  const headings = renderMarkdown(text, { kind: "markdown", skipHtml: true }).headings;
  if (text.includes(TOC_START)) {
    const next = updateToc(text, headings);
    if (next !== null) editor.replaceAll(next, { userEvent: "input.toc", isolate: true });
    toast(next === null ? t("目錄已經是最新的。") : t("已更新目錄。"));
    return;
  }
  editor.exec(insertBlock(tocBlock(headings)));
  toast(t("已插入目錄，存檔時會自動更新。"));
}

type TemplateItem = Template & { custom: boolean };

const templatePicker = new Picker<TemplateItem>({
  label: t("從範本新增文件"),
  placeholder: t("選擇範本"),
  empty: t("沒有符合的範本。"),
  query(q) {
    const all: TemplateItem[] = [
      ...settings.value.templates.map((tpl) => ({ ...tpl, custom: true })),
      ...BUILTIN_TEMPLATES.map((tpl) => ({ ...tpl, custom: false })),
    ];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((tpl) => tpl.name.toLowerCase().includes(needle)) : all;
  },
  render: (tpl) => ({ title: tpl.name, detail: tpl.custom ? t("自訂範本") : t("內建範本"), icon: "layout-template" }),
  pick(tpl) {
    const body = fillTemplate(tpl.body);
    const doc = makeDoc({ name: templateFileName(tpl.name), kind: "markdown", baseline: hash(body) });
    saveDraft(doc.id, body);
    addTab(doc);
    editor.view.focus();
  },
});

const deleteTemplatePicker = new Picker<Template>({
  label: t("刪除自訂範本"),
  placeholder: t("選擇要刪除的範本"),
  empty: t("還沒有自訂範本。"),
  query: (q) => settings.value.templates.filter((tpl) => tpl.name.includes(q.trim())),
  render: (tpl) => ({ title: tpl.name, icon: "x" }),
  async pick(tpl) {
    const ok = await choose(t("刪除範本？"), t("要刪除自訂範本「{name}」嗎？", { name: tpl.name }), [
      { id: "delete", label: t("刪除"), danger: true },
      { id: "cancel", label: t("取消"), primary: true },
    ]);
    if (ok !== "delete") return;
    settings.update({ templates: settings.value.templates.filter((x) => x.name !== tpl.name) });
    toast(t("已刪除範本「{name}」", { name: tpl.name }));
  },
});

/** 把目前的文件存成自訂範本（同名時取代）。 */
async function saveAsTemplate(): Promise<void> {
  const name = await askText(
    t("存成範本"),
    // 範本變數的名稱是固定的中文，不翻譯。
    t("範本名稱（可以在內容中使用 {date}、{week} 等變數）：", { date: "{{日期}}", week: "{{週次}}" }), // i18n-ignore
    stem(fileName),
  );
  if (!name) return;
  const body = editor.text;
  if (body.length > TEMPLATE_LIMITS.body) {
    toast(t("文件太長，無法存成範本。"), { tone: "error" });
    return;
  }
  const others = settings.value.templates.filter((tpl) => tpl.name !== name);
  if (others.length >= TEMPLATE_LIMITS.count) {
    toast(t("自訂範本最多 {n} 個，請先刪除一些。", { n: TEMPLATE_LIMITS.count }), { tone: "error" });
    return;
  }
  settings.update({ templates: [{ name, body }, ...others] });
  toast(t("已存成範本「{name}」，可以從「⋯」→「從範本新增…」使用", { name }), { tone: "success" });
}

/**
 * 複製為格式文字：選取範圍（沒有選取時是整份文件）渲染成 HTML 並加上行內樣式，
 * 同時放一份 Markdown 純文字，貼到純文字的地方時用。
 */
async function copyRich(): Promise<void> {
  const selected = selectedText();
  const markdown = selected || editor.text;
  const docDir = fileHandle?.path && !isRemote(fileHandle.path) ? dirname(fileHandle.path) : null;
  const html = richHtml(renderMarkdown(markdown, { kind: "markdown" }).html, (src) => {
    if (/^(https?:|data:)/i.test(src) || !docDir) return null;
    const path = localImagePath(src, docDir);
    return path ? localFileUrl(path) : null;
  });
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([markdown], { type: "text/plain" }),
      }),
    ]);
  } catch {
    toast(t("無法寫入剪貼簿。"), { tone: "error" });
    return;
  }
  toast(
    selected
      ? t("已複製選取範圍的格式文字，可以貼到 Word、Outlook、Teams")
      : t("已複製整份文件的格式文字，可以貼到 Word、Outlook、Teams"),
    { tone: "success" },
  );
  editor.view.focus();
}

/** 流程圖單獨成為圖片時的字型與背景色（和畫面上一樣）。 */
function diagramImageOptions(): SvgImageOptions {
  const style = getComputedStyle(editor.view.contentDOM);
  const bg = getComputedStyle(document.body).backgroundColor;
  return { font: style.fontFamily, background: bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#ffffff" };
}

/** 放大檢視流程圖（即時預覽中的圖可以從這裡回到原始碼）。 */
function openDiagram(svg: string, editSource?: () => void): void {
  const image = standaloneSvg(svg, diagramImageOptions());
  if (image) openLightbox(svgDataUrl(image.svg), t("流程圖"), editSource);
}

/** 預覽中程式碼區塊的「複製」。 */
async function copyCode(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast(t("無法寫入剪貼簿。"), { tone: "error" });
    return false;
  }
}

/** 流程圖複製成 PNG，可以直接貼到 Word、簡報、聊天軟體。 */
async function copyDiagram(svg: string): Promise<void> {
  try {
    const png = svgToPng(svg, diagramImageOptions());
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } catch {
    toast(t("無法把流程圖複製成圖片。"), { tone: "error" });
    return;
  }
  toast(t("已把流程圖複製成圖片"), { tone: "success" });
}

/** 選取範圍的文字（多重選取用換行連接）。 */
function selectedText(): string {
  const state = editor.view.state;
  return state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => state.sliceDoc(r.from, r.to))
    .join("\n");
}

async function copySelection(cut: boolean): Promise<void> {
  const text = selectedText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast(t("無法寫入剪貼簿，請按 Ctrl+{key}。", { key: cut ? "X" : "C" }));
    return;
  }
  if (cut) editor.view.dispatch(editor.view.state.replaceSelection(""), { userEvent: "delete.cut" });
  editor.view.focus();
}

/**
 * 從選單貼上：讀取剪貼簿後當成一般的貼上事件交給編輯器，所以智慧貼上（HTML 轉 Markdown）照樣有效。
 * 瀏覽器不允許讀取剪貼簿時，請使用者改按 Ctrl+V。
 */
async function pasteFromClipboard(plain: boolean): Promise<void> {
  const data = new DataTransfer();
  try {
    if (!plain && navigator.clipboard.read) {
      for (const item of await navigator.clipboard.read()) {
        for (const type of item.types) {
          if (type === "text/plain" || type === "text/html") data.setData(type, await (await item.getType(type)).text());
        }
      }
    }
    if (!data.getData("text/plain")) data.setData("text/plain", await navigator.clipboard.readText());
  } catch {
    toast(t("無法從選單讀取剪貼簿，請按 {keys} 貼上。", { keys: plain ? "Ctrl+Shift+V" : "Ctrl+V" }));
    return;
  }
  if (plain) plainPasteUntil = Date.now() + 1000;
  editor.view.focus();
  editor.view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

const imageInput = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", multiple: true, hidden: true });
document.body.append(imageInput);
imageInput.addEventListener("change", () => {
  const files = imageFiles(imageInput.files);
  imageInput.value = "";
  if (files.length) void insertImages(files).catch(reportError);
});

/**
 * 格式工具列依文件類型切換：Markdown 顯示常用格式（標題與插入收在下拉選單裡），
 * JSON 顯示格式化，純文字不顯示。可以在設定或指令面板中整個隱藏。
 */
function buildFormatBar(): void {
  const groups: (string | HTMLElement)[][] =
    kind === "markdown"
      ? [[headingMenu], ["bold", "italic", "strike", "code", "link"], ["bullet", "ordered", "task", "quote"], [insertMenu]]
      : kind === "json"
        ? [["format-json"]]
        : [];
  // Markdown 的固定工具列預設不顯示（選取時才浮出）；JSON 的「格式化」只有一個按鈕，一直顯示。
  formatBar.hidden = groups.length === 0 || (kind === "markdown" && !settings.value.fixedToolbar);
  formatBar.replaceChildren(
    ...groups.flatMap((items, gi) => {
      const buttons = items.map((item) => (typeof item === "string" ? commandButton(item, kind === "json") : item));
      return gi === 0 ? buttons : [separator("format-sep"), ...buttons];
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

kindSelect.addEventListener("change", () => setKind(kindSelect.value as DocKind));

// ---- 版面 ---------------------------------------------------------------

/** 預覽窗格現在看得到嗎（分割或只顯示預覽）。 */
function previewVisible(): boolean {
  return view === "preview" || (view === "split" && !narrowQuery.matches);
}

function applyLayout(): void {
  const narrow = narrowQuery.matches;
  // 手機寬度放不下並排，分割模式改為只顯示編輯區（可用分頁切換到預覽）。
  const effective: ViewMode = narrow && view === "split" ? "editor" : view;
  // 工作項目等內容和編輯區並排：版面當成分割，右半邊放內容（預覽藏起來）。
  const side = issueSide && !narrow && workspace.classList.contains("issue-open");
  workspace.classList.toggle("issue-side", side);
  // 即時預覽的版面和只顯示編輯區相同，差別在編輯區裡直接顯示排版。
  const layout = side ? "split" : effective === "live" ? "editor" : effective;
  workspace.dataset.view = layout;
  workspace.classList.toggle("live", effective === "live");
  if (liveApplied !== (effective === "live")) {
    liveApplied = effective === "live";
    editor.configure({ livePreview: liveApplied });
  }
  workspace.classList.toggle("outline-hidden", !outlineShown);
  workspace.classList.toggle("narrow", narrow);
  placeOutline();
  const cols = [
    // 收起側邊欄時只收面板，圖示列留著（和 VS Code 一樣），點圖示就能打開對應的面板。
    narrow ? "0px" : "var(--activity-width)",
    outlineShown && !narrow ? "var(--outline-width)" : "0px",
    layout === "preview" ? "0px" : layout === "split" ? `minmax(0, ${splitRatio}fr)` : "minmax(0, 1fr)",
    layout === "split" ? "var(--splitter-width)" : "0px",
    layout === "editor" ? "0px" : layout === "split" ? `minmax(0, ${1 - splitRatio}fr)` : "minmax(0, 1fr)",
    outlineOnRight() ? "var(--outline-right-width)" : "0px",
  ];
  workspace.style.gridTemplateColumns = cols.join(" ");
  document.querySelectorAll<HTMLButtonElement>(".segmented [data-view]").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.view === effective));
  });
  // 側邊欄打開時，分頁從編輯區的左緣開始，和下面的欄位對齊。
  $(".topbar").classList.toggle("with-sidebar", outlineShown && !narrow);
  // 右上角的按鈕：大綱放在右邊時，收起或打開右邊那一欄。
  const rightToggle = $("[data-command='toggle-outline-right']");
  rightToggle.hidden = !outlinePlacedRight();
  if (rightToggle.getAttribute("aria-pressed") !== String(rightOutlineShown)) {
    rightToggle.setAttribute("aria-pressed", String(rightOutlineShown));
    rightToggle.replaceChildren(icon(rightOutlineShown ? "panel-right-close" : "panel-right"));
  }
  const navToggle = $("[data-command='toggle-outline']");
  if (navToggle.getAttribute("aria-pressed") !== String(outlineShown)) {
    navToggle.setAttribute("aria-pressed", String(outlineShown));
    navToggle.replaceChildren(icon(outlineShown ? "panel-left-close" : "panel-left"));
  }
  renderEmptyState(editor.text);
  blocks = null;
  if (effective !== "preview") editor.view.requestMeasure();
  // 視窗變寬而出現預覽時（分割檢視），補畫之前略過的預覽。
  if (preview.stale && previewVisible()) scheduleRender();
}

function setView(mode: ViewMode): void {
  if (!issueSide) issueView.close();
  historyView?.close();
  view = mode;
  storage.save("view", mode);
  applyLayout();
  // 預覽之前沒有顯示、內容是舊的：現在補畫。
  if (preview.stale && previewVisible()) renderNow();
  renderEmptyState(editor.text);
  syncPreview();
  updateActiveHeading();
  if (mode === "editor" || mode === "live") editor.view.focus();
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
  // 流程圖的配色跟著主題，需要重畫。
  if (settings.value.mermaid) {
    preview.invalidate();
    scheduleRender();
    refreshLivePreview(editor.view);
    rerenderIssue();
  }
  terminal?.applyTheme();
}

// 跟隨系統時，系統切換深淺色也要重畫流程圖。
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (themePref === "system") terminal?.applyTheme();
  if (themePref === "system" && settings.value.mermaid) {
    preview.invalidate();
    scheduleRender();
    refreshLivePreview(editor.view);
    rerenderIssue();
  }
});

// ---- 設定 ---------------------------------------------------------------

const PREVIEW_WIDTH: Record<Settings["previewWidth"], string> = { narrow: "680px", medium: "820px", wide: "1080px" };
/** 內文字型：英文字型在前，中文指定台灣的字型（沒有安裝時往後找）。 */
const DOC_FONT: Record<Settings["docFont"], string> = {
  sans: "",
  serif:
    'Georgia, "Times New Roman", "Noto Serif TC", "Source Han Serif TC", "思源宋體", "PMingLiU", "新細明體", "Songti TC", serif', // i18n-ignore
  kai: 'Georgia, "Times New Roman", "BiauKai", "DFKai-SB", "標楷體", "TW-Kai", "Kaiti TC", "AR PL UKai TW", serif', // i18n-ignore
  mono: "var(--font-mono)",
  // 由 docFontCustom 決定（見 applySettings）。
  custom: "",
};
const DOC_LINE_HEIGHT: Record<Settings["docLineHeight"], string> = { compact: "1.6", normal: "1.8", relaxed: "2.1" };

function toggleSetting(key: "focusMode" | "typewriterMode", label: string): void {
  const on = !settings.value[key];
  settings.update({ [key]: on });
  toast(on ? t("{label}已開啟", { label }) : t("{label}已關閉", { label }));
  editor.view.focus();
}

function changeFontSize(delta: number): void {
  const size = Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, settings.value.editorFontSize + delta));
  if (size === settings.value.editorFontSize) {
    toast(delta > 0 ? t("已經是最大的字級（{size}px）", { size }) : t("已經是最小的字級（{size}px）", { size }));
    return;
  }
  settings.update({ editorFontSize: size });
}

function applySettings(s: Readonly<Settings>, changed?: (keyof Settings)[]): void {
  if (!changed || changed.some((k) => k.startsWith("activity"))) applyActivityLayout();
  const root = document.documentElement.style;
  root.setProperty("--editor-font-size", `${s.editorFontSize}px`);
  root.setProperty("--preview-width", PREVIEW_WIDTH[s.previewWidth]);
  const docFont =
    s.docFont === "custom" ? fontStack(s.docFontCustom, "var(--font-doc-default)") : DOC_FONT[s.docFont];
  if (docFont) root.setProperty("--font-doc", docFont);
  else root.removeProperty("--font-doc");
  const codeFont = fontStack(s.codeFont, "var(--font-mono-default)");
  if (codeFont) root.setProperty("--font-mono", codeFont);
  else root.removeProperty("--font-mono");
  root.setProperty("--doc-line-height", DOC_LINE_HEIGHT[s.docLineHeight]);
  if (!changed) return;
  const fontKeys: (keyof Settings)[] = ["docFont", "docFontCustom", "codeFont", "docLineHeight"];
  if (changed.some((k) => fontKeys.includes(k))) editor.view.requestMeasure();
  const editorKeys: (keyof Settings)[] = ["lineNumbers", "autoPairBrackets", "focusMode", "typewriterMode"];
  if (changed.some((k) => editorKeys.includes(k))) {
    editor.configure({
      lineNumbers: s.lineNumbers,
      autoPairBrackets: s.autoPairBrackets,
      focusMode: s.focusMode,
      typewriterMode: s.typewriterMode,
    });
  }
  if (changed.includes("editorFontSize")) {
    editor.view.requestMeasure();
    terminal?.applyFont();
  }
  if (changed.includes("fixedToolbar")) {
    buildFormatBar();
    editor.view.requestMeasure();
  }
  if (changed.includes("math") || changed.includes("mermaid") || changed.includes("blockRemoteImages")) {
    preview.clear();
    renderNow();
    refreshLivePreview(editor.view);
    rerenderIssue();
  }
  if (changed.includes("termCheck") || changed.includes("termIgnore")) recheckTerms(editor.view);
  if (changed.includes("outlineRight")) {
    // 打開「大綱放在右邊」時，一定讓它顯示出來。
    if (settings.value.outlineRight) rightOutlineShown = true;
    applyLayout();
  }
}

/** 整份文件的兩國用語與錯字：不需要判斷文意的直接換掉，其他的留著波浪底線。 */
/** 簡體轉繁體：有選取時只轉選取範圍，否則轉整份文件。程式碼與網址不轉。 */
async function convertToTraditional(ranges?: readonly { from: number; to: number }[]): Promise<void> {
  const doc = active;
  const loading = window.setTimeout(() => toast(t("正在載入簡繁轉換詞庫…")), 300);
  let convert: Convert;
  try {
    convert = await loadConverter();
  } finally {
    clearTimeout(loading);
  }
  if (active !== doc) return;
  const state = editor.view.state;
  const targets = ranges ?? state.selection.ranges.filter((r) => !r.empty);
  const list = targets.length ? targets : [{ from: 0, to: state.doc.length }];
  const changes = list.flatMap((r) => conversionChanges(state.sliceDoc(r.from, r.to), convert, r.from));
  if (!changes.length) {
    toast(t("沒有需要轉換的簡體字。"), { tone: "success" });
    return;
  }
  editor.view.dispatch({ changes, userEvent: "input.s2t" });
  toast(
    targets.length
      ? t("已轉成繁體（選取範圍，{n} 處；可以按 Ctrl+Z 復原）。", { n: changes.length })
      : t("已轉成繁體（整份文件，{n} 處；可以按 Ctrl+Z 復原）。", { n: changes.length }),
    { tone: "success" },
  );
}

/** 貼上的內容看起來是簡體時，提示可以轉成繁體。 */
function onSimplifiedPaste(u: ViewUpdate): void {
  if (kind === "json" || !u.transactions.some((tr) => tr.isUserEvent("input.paste"))) return;
  const ranges: { from: number; to: number }[] = [];
  let inserted = "";
  u.changes.iterChanges((_fa, _ta, from, to, text) => {
    ranges.push({ from, to });
    inserted += text.toString();
  });
  if (!looksSimplified(inserted)) return;
  const doc = active;
  toast(t("貼上的內容看起來是簡體中文。"), {
    duration: 10000,
    action: {
      label: t("轉成繁體"),
      run: () => {
        // 貼上的內容還在原處就只轉它；之後又改過內容時改為轉換整份文件（或選取範圍）。
        const state = editor.view.state;
        const intact = active === doc && ranges.every((r) => r.to <= state.doc.length) &&
          ranges.map((r) => state.sliceDoc(r.from, r.to)).join("") === inserted;
        void convertToTraditional(intact ? ranges : undefined).catch(reportError);
      },
    },
  });
}

function fixTerms(): void {
  const matches = scanDocument(editor.view.state, new Set(settings.value.termIgnore));
  const fixes = sureFixes(matches);
  const left = matches.length - fixes.length;
  if (fixes.length) editor.view.dispatch({ changes: fixes, userEvent: "input.proofread" });
  if (!matches.length) toast(t("沒有找到中國用語、常見錯字或半形標點。"), { tone: "success" });
  else {
    const parts = [
      fixes.length ? t("已修正 {n} 處（可以按 Ctrl+Z 復原）。", { n: fixes.length }) : "",
      left
        ? settings.value.termCheck
          ? t("另有 {n} 處要依文意判斷，已畫上波浪底線，滑鼠移上去可以選擇。", { n: left })
          : t("另有 {n} 處要依文意判斷；打開設定的「檢查兩國用語與錯字」就會標示出來。", { n: left })
        : "",
    ];
    // 英文的句子之間要空一格。
    toast(
      parts.filter(Boolean).join(currentLang() === "en" ? " " : ""),
      { tone: fixes.length ? "success" : "info", duration: left ? 8000 : undefined },
    );
  }
}

settings.subscribe(applySettings);
const settingsDialog = new SettingsDialog(
  settings,
  { get: () => themePref, set: setTheme },
  desktop && ai ? { available: () => desktop!.aiTools(), registration: () => ai!.registration() } : null,
  updater
    ? {
        async version() {
          const v = await updater!.version();
          return { label: versionLabel(v), detail: versionDetail(v), title: versionTooltip(v) };
        },
        pending: () => (updater!.state.kind === "ready" ? updater!.state.version : null),
        checking: () => updater!.checking,
        onChange: (fn) => void updater!.subscribe(fn),
        check: () => void updater!.check(),
        restart: () => updater!.restart(),
      }
    : null,
  github
    ? {
        account: () => github!.account,
        canPublish: () => !!workspaceRoot && !isRemote(workspaceRoot.path),
        login: () => void github!.login(),
        logout: () => void github!.logout(),
        openRepo: () => void github!.openRepo(),
        publish: () => void github!.publish(),
      }
    : null,
  ado
    ? {
        account: () => ado!.account,
        connect: (url, pat) => ado!.connect(url, pat),
        disconnect: () => void ado!.disconnect(),
        openRepo: () => void ado!.openRepo(),
        workItems: () => showAdo("workitems"),
      }
    : null,
  {
    version: __APP_VERSION__,
    openUrl,
    shortcuts: () => showShortcuts(),
    welcome: () => openWelcome(),
    changelog: () => void openChangelog().catch(reportError),
  },
  {
    panels: () =>
      panelOrder().map((p) => ({ id: p, label: PANEL_LABELS[p](), icon: PANEL_ICONS[p], available: !$(`#side-tab-${p}`).hidden })),
    command(id) {
      const c = commands.get(id);
      return c ? { title: c.title, icon: c.icon ?? "command" } : null;
    },
    add: () => void addActivityCommand().catch(reportError),
  },
);
void ado?.ready().then(() => {
  renderAdoTab();
  settingsDialog.refresh();
});
// 讀到 GitHub 登入狀態後更新設定頁與原始碼控制面板。
void github?.ready().then(() => {
  settingsDialog.refresh();
  void gitPanel?.refresh();
  void renderIssuesTab();
});

document.querySelectorAll<HTMLButtonElement>(".segmented [data-view]").forEach((btn) => {
  const mode = btn.dataset.view as ViewMode;
  const cmd = commands.get(`view-${mode}`)!;
  btn.title = withKeys(cmd.title, cmd.keys);
  // 視窗窄時只剩圖示（文字藏起來）：螢幕閱讀器仍然要念得出名稱。
  btn.setAttribute("aria-label", btn.querySelector(".label")?.textContent || cmd.title);
  btn.addEventListener("click", () => setView(mode));
});

// 側邊欄與右邊大綱的寬度：拖曳面板邊緣調整，各自記住。
for (const [panel, side, key, cssVar] of [
  [$("#sidebar"), "left", "sidebar-width", "--outline-width"],
  [$("#outline-right"), "right", "outline-right-width", "--outline-right-width"],
] as const) {
  const saved = Number(storage.load(key));
  if (saved) document.documentElement.style.setProperty(cssVar, `${clampSidebarWidth(saved)}px`);
  setupSidebarResize(
    workspace,
    side,
    () => panel.getBoundingClientRect().width,
    (px) => {
      document.documentElement.style.setProperty(cssVar, `${px}px`);
      storage.save(key, String(px));
      editor.view.requestMeasure();
    },
  );
}

setupSplitter($("#splitter"), workspace, splitRatio, (r) => {
  splitRatio = r;
  storage.save("split", String(r));
  applyLayout();
});

wideQuery.addEventListener("change", () => applyLayout());
narrowQuery.addEventListener("change", () => {
  // 切換到手機寬度時，大綱抽屜先收起來，避免蓋住內容。
  if (narrowQuery.matches) outlineShown = false;
  applyLayout();
});

// 手機版：大綱以抽屜方式蓋在內容上，點外面關閉。
workspace.addEventListener("click", (e) => {
  if (narrowQuery.matches && outlineShown && !(e.target as HTMLElement).closest(".sidebar, .activity-bar")) {
    setOutline(false);
  }
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
async function insertImages(original: File[]): Promise<void> {
  if (kind !== "markdown") {
    toast(t("只有 Markdown 文件可以插入圖片。"));
    return;
  }
  let files = original;
  if (settings.value.imageCompress) {
    const out = await Promise.all(original.map(compressImage));
    files = out.map((c) => c.file);
    const changed = out.filter((c) => c.changed);
    if (changed.length) {
      const before = changed.reduce((n, c) => n + c.before, 0);
      const after = changed.reduce((n, c) => n + c.file.size, 0);
      toast(t("已自動縮小圖片（{before} → {after}）。不想壓縮可以在設定的「編輯」關閉。", { before: formatBytes(before), after: formatBytes(after) }), {
        duration: 6000,
      });
    }
  }
  if (!desktop) {
    if (files.reduce((n, f) => n + f.size, 0) > EMBED_LIMIT) {
      toast(t("圖片超過 2 MB，網頁版無法內嵌。桌面版會把圖片另存成檔案，沒有這個限制。"), { tone: "error", duration: 8000 });
      return;
    }
    toast(t("網頁版無法把圖片另存成檔案。要直接內嵌在文件裡嗎？（文件會變大）"), {
      duration: 10000,
      action: {
        label: t("內嵌圖片"),
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
    toast(t("請先存檔：圖片會存到文件所在資料夾的 assets 資料夾裡。"), {
      duration: 8000,
      action: {
        label: t("儲存"),
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
  toast(files.length > 1 ? t("已把 {n} 張圖片存到 assets 資料夾", { n: files.length }) : t("已把圖片存到 assets 資料夾"), {
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
  if (/\.docx$/i.test(file.name)) {
    await importDocxData(file.name, await file.arrayBuffer(), null).catch(reportError);
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    toast(t("檔案超過 20 MB，可能不是文字檔。"), { tone: "error" });
    return;
  }
  const text = await readTextFile(file).catch(reportError);
  if (text === undefined) return;
  openDocument(file.name, text, null);
  toast(t("已開啟「{name}」", { name: file.name }));
});

// ---- 初始狀態 -----------------------------------------------------------

const savedView = storage.load("view");
view = savedView === "editor" || savedView === "live" || savedView === "preview" ? savedView : "split";
kindSelect.value = kind;
setTheme(themePref);
applySettings(settings.value);
if (settingsRecovered) toast(t("設定檔有無法讀取的內容，相關選項已恢復成預設值。"), { tone: "error", duration: 8000 });
buildFormatBar();
showPanel(pendingPanel ?? sidePanel, false);
void renderFilesEmpty();
// 手機上大綱是蓋在內容上的抽屜，一開始先收起來。
if (narrowQuery.matches) outlineShown = false;
applyLayout();
renderNow();
renderTabs();
persistSession();
updateCursor(editor.view);
// 分頁關掉、專案移除後留下的草稿會一直佔著儲存空間：啟動一陣子後（分頁都存好了）清掉。
setTimeout(() => dropOrphanDrafts(), 10_000);

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
      toast(t("「{name}」已從磁碟刪除或移走。內容仍保留在分頁中，存檔會重新建立檔案。", { name: doc.name }), { duration: 8000 });
    }),
    d.onTreeChanged(({ dirs }) => {
      fileListCache = null;
      indexStale = true;
      refreshIndexPanels(300);
      void fileTree?.refresh(dirs).then(() => gitPanel?.refreshSoon());
      // 搜尋面板沒顯示時先記下來，打開時再重新搜尋（每次存檔都會走到這裡）。
      if (outlineShown && sidePanel === "search") searchPanel?.rerun();
      else searchStale = true;
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
            void suggestReconnect(last, (name) => t("要重新連線到「{name}」，需要輸入密碼。", { name }), t("輸入密碼"));
          }
          return null;
        })
      : null;
    await setWorkspace(folder);
    // 還沒輸入密碼不代表不用這個資料夾了：下次啟動仍然提示。
    if (needPassword && last) storage.save("workspace", last);
  }

  await reloadDocs(docs);
  docsLoaded = true;

  if (target?.kind === "file") openOpenedFile(fromDesktop(target));
}

/** 重新讀取分頁的檔案；讀不到的標成「已刪除或移走」。 */
async function reloadDocs(list: Doc[]): Promise<void> {
  const one = async (doc: Doc): Promise<void> => {
    const path = docPath(doc);
    if (!path) return;
    try {
      await reloadDoc(doc, path);
    } catch {
      // 遠端檔案讀不到多半是還沒重新連線，不代表檔案不見了；連線後會再讀一次。
      if (!isRemote(path)) doc.missing = true;
    }
  };
  // 目前的分頁先讀，畫面最快變成正確的內容。
  if (list.includes(active)) await one(active);
  // 其他分頁最多同時讀 4 個（網路磁碟上一個一個讀要等很久）。
  // 草稿被清掉的分頁（unloaded）切換過去時才讀，不必現在讀進來又寫回草稿、佔掉儲存空間。
  const rest = list.filter((doc) => doc !== active && !doc.unloaded);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, rest.length) }, async () => {
      while (next < rest.length) await one(rest[next++]);
    }),
  );
  persistSession();
  renderTabs();
  // 有了檔案路徑，預覽中的相對路徑圖片才能顯示。
  preview.clear();
  renderNow();
}

function docPath(doc: Doc): string | null {
  return doc === active ? (fileHandle?.path ?? doc.path) : doc.path;
}

/**
 * 重新讀取分頁的檔案（啟動時、重新連線到遠端資料夾後）：沒有未存檔的變更就直接採用最新內容，
 * 有的話提示比較差異。
 */
async function reloadDoc(doc: Doc, path: string): Promise<void> {
  const file = fromDesktop(await desktop!.reopenFile(path));
  doc.lossy = file.encoding === "unknown";
  const draft = doc === active ? editor.text : (loadDraft(doc.id) ?? "");
  // 沒有草稿的分頁：直接採用檔案的內容。
  const clean = doc.unloaded || hash(draft) === doc.baseline;
  if (doc.unloaded) {
    doc.unloaded = false;
    doc.dirty = false;
    if (file.text === draft) saveDraft(doc.id, file.text);
  }
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
    toast(t("「{name}」在上次關閉後被{who}修改過，你也有未存檔的變更。", { name: doc.name, who: otherWriter(path) }), {
      duration: 12000,
      action: { label: t("比較差異"), run: () => void compareDoc(doc).catch(reportError) },
    });
  }
}

/** 重新連線到遠端資料夾後，重新讀取屬於這個連線的分頁（圖片也重新載入）。 */
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
    toast(t("「{name}」被{who}修改了，你也有未存檔的變更。", { name: doc.name, who: otherWriter(path) }), {
      duration: 12000,
      action: { label: t("比較差異"), run: () => void compareDoc(doc).catch(reportError) },
    });
    return;
  }
  // 沒有未存檔的變更：直接重新載入。重新讀取也會更新原生端記錄的內容，之後存檔才不會誤判為衝突。
  const wasActive = doc === active;
  const before = wasActive ? editor.text : loadDraft(doc.id);
  const file = await desktop.reopenFile(path);
  // 讀檔期間（網路磁碟可能要等一陣子）又打了字或切換了分頁：不要蓋掉，改成提示比較差異。
  if (!docs.includes(doc)) return;
  const now = doc === active ? editor.text : loadDraft(doc.id);
  if ((doc === active) !== wasActive || now !== before) {
    toast(t("「{name}」被{who}修改了，你也有未存檔的變更。", { name: doc.name, who: otherWriter(path) }), {
      duration: 12000,
      action: { label: t("比較差異"), run: () => void compareDoc(doc).catch(reportError) },
    });
    return;
  }
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
      toast(t("「{name}」已被{who}更新，已重新載入。", { name: doc.name, who: otherWriter(path) }), {
        action: { label: t("復原"), run: () => void undo(editor.view) },
      });
    }
  } else {
    doc.state = null;
    doc.dirty = false;
    if (markChanges && doc.externalOriginal === file.text) doc.externalOriginal = undefined;
    const params = { name: doc.name, who: otherWriter(path) };
    toast(markChanges ? t("「{name}」已被{who}更新，切換過去可以看到改了哪裡。", params) : t("「{name}」已被{who}更新，已重新載入。", params));
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
    title: t("與{store}上的版本比較", { store: storeName() }),
    hint: t("逐段選擇要採用哪個版本，處理完記得存檔。"),
    acceptLabel: isRemote(fileHandle?.path) ? t("採用伺服器版本") : t("採用磁碟版本"),
    rejectLabel: t("保留我的版本"),
  });
  if (!started) toast(t("目前內容和{store}上的版本相同。", { store: storeName() }));
}

// 關閉視窗或重新整理前，把還沒寫入的草稿存起來。
window.addEventListener("pagehide", flushDraft);
