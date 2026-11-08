import "../../crates/md-core/src/document.css";
import "./styles.css";
import "./palettes.css";

import { EditorView, hoverTooltip } from "@codemirror/view";
import init, { type Heading, type RenderResult, formatTable, kindFromFileName, render as renderMarkdown } from "../pkg/md_wasm.js";
import { AiController } from "./ai.ts";
import { GitHub } from "./github-ui.ts";
import { Ado } from "./ado-ui.ts";
import { type PaletteId, applyPalette, isDark, loadAccent, loadPalette, savePalette } from "./palette.ts";
import { formatKeys } from "./commands.ts";
import { Editor, type EditorHandlers, type EditorOptions, cursorInfo } from "./editor.ts";
import { type FileItem, type Folder, desktop, displayPath, isRemote } from "./desktop.ts";
import type { EditorState, Text } from "@codemirror/state";
import { type FileHandle, type OpenedFile, type SaveOutcome, desktopHandle, replaceExtension, saveFile } from "./files.ts";
import { autoSymbols } from "./auto-symbols.ts";
import { refreshLivePreview } from "./live-preview.ts";
import { proofread } from "./proofread.ts";
import { spellcheck } from "./spellcheck.ts";
import { type DocKind, KINDS, isTextFileName } from "./kinds.ts";
import { basename, dirname, localImagePath, resolvePath } from "./paths.ts";
import { HtmlPreview, isHtmlName } from "./html-preview.ts";
import { highlightPlugin } from "./plugins/highlight.ts";
import { localImagesPlugin } from "./plugins/local-images.ts";
import { mathPlugin, renderTex } from "./plugins/math.ts";
import { imageSize, livePreview } from "./live-preview.ts";
import { codeToolsPlugin } from "./plugins/code-tools.ts";
import { tablesPlugin } from "./plugins/tables.ts";
import { mermaidPlugin, mermaidTheme, renderMermaid, setMermaidBlockRemote } from "./plugins/mermaid.ts";
import { blockRemoteImages, blockRemoteImagesInHtml } from "./remote-images.ts";
import { Preview, type PreviewPlugin } from "./preview.ts";
import sampleEn from "./sample.en.md?raw";
import sampleZh from "./sample.md?raw";
import { type BlockRef, collectBlocks, offsetForLineLazy } from "./scroll-sync.ts";
import { SPELL_IGNORE_LIMIT, TERM_IGNORE_LIMIT, SettingsStore } from "./settings.ts";
import { smartPasteText } from "./app/table-paste.ts";
import { type HeadingRef, linkCompletion } from "./link-complete.ts";
import { type DocMeta, dropDraft, dropOrphanDrafts, loadDraft, loadSession, newId, peekSession, saveDraft, saveProjectView, saveSession, type Session } from "./session.ts";
import * as storage from "./storage.ts";
import { choose } from "./ui/choice.ts";
import { FileTree } from "./ui/filetree.ts";
import { aiAppPresent } from "./app/ai-app-presence.ts";
import { cometBadge } from "./ui/comet-badge.ts";
import { cometFileGuard, cometTreeMark } from "./app/comet-files.ts";
import { hydrateIcons, icon } from "./ui/icons.ts";
import { type StartAction, buildStartPage } from "./ui/start-page.ts";
import { KindPicker } from "./ui/kind-picker.ts";
import { initDocLanguage } from "./app/doc-language.ts";
import { askUtf8, encodingLabel, initFileFormat } from "./app/file-format.ts";
import { currentLang, t, translateDom } from "./i18n.ts";
import { ProjectUi } from "./ui/project-ui.ts";
import { projectInitials } from "./projects.ts";
import { Review } from "./ui/review.ts";
import { imageRepoPath } from "./wiki-text.ts";
import { type RepoFileLink } from "./repo-links.ts";
import { openLightbox } from "./ui/lightbox.ts";
import { dateCompletion } from "./date-complete.ts";
import { docLinksPlugin, wikiTarget } from "./plugins/doc-links.ts";
import { resolveWiki } from "./links.ts";
import { type TabInfo, TabBar } from "./ui/tabbar.ts";
import { initSideDrop } from "./app/side-drop.ts";
import { TerminalProxy } from "./terminal-proxy.ts";
import { Updater } from "./updater.ts";
import { isDefaultWorkItemFilter, parseWorkItemFilter } from "./work-item-filter.ts";
import type { AdoWiki, AdoWorkItem, AdoWorkItemFilter, GitStatus } from "./desktop.ts";
import { urlAt } from "./remote-links.ts";
import { insertHandle, selectionToolbar } from "./inline-tools.ts";
import { toast } from "./ui/toast.ts";
import { imageFiles, insertImages, wikiEditImage, wikiEditImagesPlugin } from "./app/image-paste.ts";
import { initFileDrop } from "./app/file-drop.ts";
import { pasteLink } from "./app/paste-link.ts";
import { clearOffline, isOffline, offline, renderOffline, resolveConflict, showOffline, initOfflineDrive } from "./app/offline-drive.ts";
import { initWikiHistory } from "./app/wiki-history.ts";
import { offlineImage, initOfflineCopies } from "./app/offline-copies.ts";
import { openRemoteLink, remoteCard, remoteLinkOf, initAdoLinks } from "./app/ado-links.ts";
import { historyView, initGitHistory } from "./app/git-history.ts";
import { buildFormatBar, initNewWorkItem } from "./app/new-work-item.ts";
import { markBarShortcuts, renderAdoTab, renderIssuesTab, wikiPanel, workItemsPanel, initWorkItemsPanel } from "./app/work-items-panel.ts";
import { initAdoStatus } from "./app/ado-status.ts";
import { gitPanel, initWorkItemUpdates } from "./app/work-item-updates.ts";
import { reportError, showExternalChanges, switchBranch, initGitActions } from "./app/git-actions.ts";
import { initAiTerminal } from "./app/ai-terminal.ts";
import { contextMenu, copyCode, copyDiagram, formatBubble, openDiagram, openInsertMenu, openWelcome, refreshToc, showActivityLabels, slashSource, tabMenu, initActivityBar } from "./app/activity-bar.ts";
import { showShortcuts } from "./app/shortcuts-dialog.ts";
import { applySettings, onSimplifiedPaste, settingsDialog, initSettingsUi } from "./app/settings-ui.ts";
import { type ClosedItem, closeItem, closeItems, docClosing, findItemTab, focusedItem, hideItem, itemTabInfo, itemTabs, reopenItem, selectItem, selectedItemId, setItemPinned, tabOrder } from "./app/item-tabs.ts";
import { checkWikiNewer, issueSide, renderWikiBar, renderWikiMine, rerenderIssue, wikiCheckedAt, wikiNewer, initWikiEdit } from "./app/wiki-edit.ts";
import { commands, initCommands } from "./app/commands.ts";
import { NOT_CONNECTED, canRenameFile, closeProject, fileSaved, openPath, openRecentFolder, openRemote, openTag, renameEntry, rightColumnOn, pendingPanel, placeOutline, refreshIndexPanels, renderFilesEmpty, setWorkspace, showPanel, suggestReconnect, treeAction, uploadFiles, initWorkspaceUi } from "./app/workspace-ui.ts";
import { openRepoFileLink, saveWikiPage } from "./app/ado-files.ts";
import { markdownFiles, openWiki, wikiExists } from "./app/wiki-links.ts";
import { renderSaveState, updateActiveHeading, initOutline, markBlankTab, onlyBlankDoc } from "./app/outline.ts";
import { docName, docTooltip, renumber, saveFileName } from "./app/doc-names.ts";
import { wikiLinkPages, workItemIdCompletion } from "./app/quick-open.ts";
import { availableRightTabs } from "./app/right-tabs.ts";
import { initDocStats, renderStats } from "./app/doc-stats.ts";
import { provideApp } from "./app/context.ts";
import { initMainMenu } from "./app/main-menu.ts";
import { closeSide, initSideBySide, refreshOtherPane, renderPaneHeads } from "./app/side-by-side.ts";
import { initFileHistory } from "./app/file-history.ts";
import { initStatusView } from "./app/status-view.ts";
import { autoSaveNow, autoSavePending, exclusiveSave, resumeAutoSave, scheduleDiskSave } from "./app/autosave.ts";
import { forgetOutlineCollapse, initOutlineList, renderOutline } from "./app/outline-list.ts";
import { workItemChips, workItemChipsPlugin } from "./app/work-item-chips.ts";
import { forgetChangeNotice, reloadDoc, startDesktop } from "./app/desktop-startup.ts";
import { initTaskboard } from "./app/taskboard.ts";
import { renderStartRecent } from "./app/recent-files.ts";
import { initErrorHandling } from "./app/error-handling.ts";
import { refreshRepoNotes, repoSources } from "./app/repo-sources.ts";

import { type ViewMode, applyViewSwitch, chooseView, currentView } from "./view-modes.ts";
type ThemePref = "system" | "light" | "dark";

/** 範例文件（英文介面用英文版）。 */
const sample = currentLang() === "en" ? sampleEn : sampleZh;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const workspace = $(".workspace");
const previewEl = $("#preview");
const previewScroller = $("#preview-scroller");
const outlineList = $<HTMLOListElement>("#outline-list");
const parseErrorEl = $("#parse-error");
const emptyStateEl = $("#empty-state");
const formatBar = $("#format-bar");
const kindSelect = new KindPicker($<HTMLButtonElement>("#doc-kind"));
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

/**
 * 在設定開啟的整合功能（桌面版）。關掉的功能不建立、不顯示；原生端也會拒絕它的指令（desktop/src/features.rs）。
 * 開關改了就重新載入介面（開著的分頁和沒存的內容都會保留），不必在各處處理「用到一半被關掉」。
 */
const features = {
  git: !!desktop && settings.value.gitEnabled,
  ado: !!desktop && settings.value.adoEnabled,
  remote: !!desktop && settings.value.remoteEnabled,
};
settings.subscribe((_, changed) => {
  if (changed.some((k) => k === "gitEnabled" || k === "adoEnabled" || k === "remoteEnabled")) void settings.saved().then(() => location.reload());
});

// ---- 給 app/ 模組用的狀態與函式 ---------------------------------------------

/**
 * 拆到 app/ 的模組透過這個物件使用 main.ts 的狀態與函式。都是 getter（用到時才取值），
 * 所以模組拿到的永遠是目前的值（例如切換分頁後的 fileName）。
 */
const app = {
  get features() {
    return features;
  },
  get $() {
    return $;
  },
  get CACHE_MAX() {
    return CACHE_MAX;
  },
  get DOWNLOAD_URL() {
    return DOWNLOAD_URL;
  },
  get LEGACY_ADO_PANEL() {
    return LEGACY_ADO_PANEL;
  },
  get SIDE_PANELS() {
    return SIDE_PANELS;
  },
  get activate() {
    return activate;
  },
  get active() {
    return active;
  },
  get addTab() {
    return addTab;
  },
  /**
   * 這份文件不顯示起始頁（按「新增文件」開的：已經要開始寫了，只留編輯區的灰色提示）。
   * 「預覽」檢視時編輯器是藏起來的，換成可以打字的檢視（和起始頁的「開始寫作」一樣），不然畫面一片空白。
   */
  skipStartPage(id: string) {
    startDismissed.add(id);
    if (view === "preview") setView(cur.kind === "markdown" ? "live" : "editor");
  },
  /** 按「新增文件」開的（不是一開始或關掉所有文件後補上的空白文件）：空白時分頁也照常顯示。 */
  startSkipped(id: string) {
    return startDismissed.has(id);
  },
  get ado() {
    return ado;
  },
  get adoImagesPlugin() {
    return adoImagesPlugin;
  },

  get ai() {
    return ai;
  },
  set ai(v: typeof ai) {
    ai = v;
  },
  get allowRemoteImages() {
    return allowRemoteImages;
  },
  get applyLayout() {
    return applyLayout;
  },
  get cur() {
    return cur;
  },
  get blockRemote() {
    return blockRemote;
  },
  get closeTab() {
    return closeTab;
  },
  get closeTabs() {
    return closeTabs;
  },
  get cycleTab() {
    return cycleTab;
  },
  get docHeadings() {
    return docHeadings;
  },
  get docPath() {
    return docPath;
  },
  get docs() {
    return docs;
  },
  set docs(v: typeof docs) {
    docs = v;
  },
  get docsFrom() {
    return docsFrom;
  },
  get docsLoaded() {
    return docsLoaded;
  },
  set docsLoaded(v: boolean) {
    docsLoaded = v;
  },
  get editor() {
    return editor;
  },
  get editors() {
    return allEditors();
  },
  get focusPane() {
    return focusPane;
  },
  get ensureSideEditor() {
    return ensureSideEditor;
  },
  get otherPane() {
    return otherPane;
  },
  get paneEditor() {
    return paneEditor;
  },
  get focusedPane() {
    return focusedPane;
  },
  setSideDoc(doc: Doc | null): void {
    paneDocs.side = doc;
  },
  get paneDocs(): Readonly<typeof paneDocs> {
    return paneDocs;
  },
  get editorHash() {
    return editorHash;
  },
  get editorTopLine() {
    return editorTopLine;
  },
  get fileInput() {
    return fileInput;
  },
  get fileListCache() {
    return fileListCache;
  },
  set fileListCache(v: typeof fileListCache) {
    fileListCache = v;
  },
  get fileTree() {
    return fileTree;
  },
  get flushDraft() {
    return flushDraft;
  },
  get followLink() {
    return followLink;
  },
  get formatBar() {
    return formatBar;
  },
  get gitHistoryKey() {
    return gitHistoryKey;
  },
  set gitHistoryKey(v: typeof gitHistoryKey) {
    gitHistoryKey = v;
  },
  get github() {
    return github;
  },
  get pendingDraft() {
    return pendingDraft;
  },
  set pendingDraft(v: typeof pendingDraft) {
    pendingDraft = v;
  },
  get hash() {
    return hash;
  },
  get indexStale() {
    return indexStale;
  },
  set indexStale(v: typeof indexStale) {
    indexStale = v;
  },
  get isDefaultFilter() {
    return isDefaultFilter;
  },
  get issueKey() {
    return issueKey;
  },
  set issueKey(v: typeof issueKey) {
    issueKey = v;
  },
  get kindSelect() {
    return kindSelect;
  },
  get loadWorkItemFilterOptions() {
    return loadWorkItemFilterOptions;
  },
  set loadWorkItemFilterOptions(v: typeof loadWorkItemFilterOptions) {
    loadWorkItemFilterOptions = v;
  },
  get makeDoc() {
    return makeDoc;
  },
  get menuTab() {
    return menuTab;
  },
  get menuItemTab() {
    return menuItemTab;
  },
  get closeTabIds() {
    return closeTabIds;
  },
  get tabPinned() {
    return tabPinned;
  },
  get rememberClosedItem() {
    return rememberClosedItem;
  },
  get menuTabId() {
    return menuTabId;
  },
  set menuTabId(v: typeof menuTabId) {
    menuTabId = v;
  },
  get narrowQuery() {
    return narrowQuery;
  },
  get openDocument() {
    return openDocument;
  },
  get openOpenedFile() {
    return openOpenedFile;
  },
  get outlineList() {
    return outlineList;
  },
  get outlineShown() {
    return outlineShown;
  },
  set outlineShown(v: typeof outlineShown) {
    outlineShown = v;
  },
  get outlineView() {
    return outlineView;
  },
  set outlineView(v: typeof outlineView) {
    outlineView = v;
  },
  get persistSession() {
    return persistSession;
  },
  get plainPasteUntil() {
    return plainPasteUntil;
  },
  set plainPasteUntil(v: typeof plainPasteUntil) {
    plainPasteUntil = v;
  },
  get pollItems() {
    return pollItems;
  },
  set pollItems(v: typeof pollItems) {
    pollItems = v;
  },
  get preview() {
    return preview;
  },
  get previewEl() {
    return previewEl;
  },
  get previewScroller() {
    return previewScroller;
  },
  get previewVisible() {
    return previewVisible;
  },
  get projectUi() {
    return projectUi;
  },
  get renderFolderBranch() {
    return renderFolderBranch;
  },
  get renderNow() {
    return renderNow;
  },
  get renderProjectName() {
    return renderProjectName;
  },
  get renderTabs() {
    return renderTabs;
  },
  get reopenClosedTab() {
    return reopenClosedTab;
  },
  get repoFile() {
    return repoFile;
  },
  set repoFile(v: typeof repoFile) {
    repoFile = v;
  },
  get review() {
    return review;
  },
  get rightOutlineShown() {
    return rightOutlineShown;
  },
  set rightOutlineShown(v: typeof rightOutlineShown) {
    rightOutlineShown = v;
  },
  get sample() {
    return sample;
  },
  get save() {
    return save;
  },
  get scrollToAnchor() {
    return scrollToAnchor;
  },
  get searchStale() {
    return searchStale;
  },
  set searchStale(v: typeof searchStale) {
    searchStale = v;
  },
  get setBaseline() {
    return setBaseline;
  },
  get setKind() {
    return setKind;
  },
  get setFileName() {
    return setFileName;
  },
  get setOutline() {
    return setOutline;
  },
  get setPinned() {
    return setPinned;
  },
  get setTheme() {
    return setTheme;
  },
  get setView() {
    return setView;
  },
  get settings() {
    return settings;
  },
  get showAssignee() {
    return showAssignee;
  },
  get sidePanel() {
    return sidePanel;
  },
  set sidePanel(v: typeof sidePanel) {
    sidePanel = v;
  },
  get sideTabs() {
    return sideTabs;
  },
  get splitRatio() {
    return splitRatio;
  },
  set splitRatio(v: typeof splitRatio) {
    splitRatio = v;
  },
  get stash() {
    return stash;
  },
  get status() {
    return status;
  },
  get tabBar() {
    return tabBar;
  },
  get tabForPath() {
    return tabForPath;
  },
  get tabPath() {
    return tabPath;
  },
  get tabScope() {
    return tabScope;
  },
  set tabScope(v: typeof tabScope) {
    tabScope = v;
  },
  get terminal() {
    return terminal;
  },
  set terminal(v: typeof terminal) {
    terminal = v;
  },
  get themePref() {
    return themePref;
  },
  get palette() {
    return palette;
  },
  get accent() {
    return accent;
  },
  get setPalette() {
    return setPalette;
  },
  get setAccent() {
    return setAccent;
  },
  get treeActive() {
    return treeActive;
  },
  set treeActive(v: typeof treeActive) {
    treeActive = v;
  },
  get updater() {
    return updater;
  },
  set updater(v: typeof updater) {
    updater = v;
  },
  get view() {
    return view;
  },
  get wikiImagesPlugin() {
    return wikiImagesPlugin;
  },
  get wikiListCache() {
    return wikiListCache;
  },
  set wikiListCache(v: typeof wikiListCache) {
    wikiListCache = v;
  },
  get wikiPage() {
    return wikiPage;
  },
  set wikiPage(v: typeof wikiPage) {
    wikiPage = v;
  },
  get withKeys() {
    return withKeys;
  },
  get refreshKeyHints() {
    return refreshKeyHints;
  },
  get workItemFilter() {
    return workItemFilter;
  },
  get workspace() {
    return workspace;
  },
  get workspaceRoot() {
    return workspaceRoot;
  },
  set workspaceRoot(v: typeof workspaceRoot) {
    workspaceRoot = v;
  },
};
export type App = typeof app;
provideApp(app);

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
export interface Doc extends DocMeta {
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
/** 第一次使用（沒有可以還原的分頁）。 */
const firstLaunch = !docs.length;
if (firstLaunch) {
  // 第一次使用：空白文件，畫面上是起始頁（新增、開啟、連線、「3 分鐘認識 oMarker」）。
  // 「3 分鐘認識 oMarker」很長，不再一開始就塞給使用者；想看時從起始頁或「說明」開啟。
  docs = [makeDoc({ name: t("未命名.md"), kind: "markdown", baseline: hash("") })];
}
let active: Doc = docs.find((d) => d.id === restored?.activeId) ?? docs[0];

/**
 * 目前分頁的狀態。和 `active` 這份文件的欄位對應：切換分頁時從文件讀出（`activate`），
 * 存檔、改名、切走時寫回（`stash`）。
 */
interface ActiveDoc {
  kind: DocKind;
  fileName: string;
  fileHandle: FileHandle | null;
  /** 最後一次存檔／開檔／新增時內容的雜湊；目前內容與它不同就代表有未存檔的變更。 */
  baseline: string | null;
  /** 目前內容是否對應到一個實際存過或開啟過的檔案。 */
  fileBacked: boolean;
  /** 草稿已經存進瀏覽器（自動儲存草稿用）。 */
  draftSaved: boolean;
}
const cur: ActiveDoc = {
  kind: active.kind,
  fileName: active.name,
  fileHandle: active.handle,
  baseline: active.baseline,
  fileBacked: active.fileBacked,
  draftSaved: false,
};
/**
 * 開著 Wiki、工作項目時，大綱改列它的標題（`body` 是內容的元素，用來捲動）；
 * 編輯中文件的標題記在 `docHeadings`，關掉後換回來。
 */
let outlineView: { key: string; headings: Heading[]; body: HTMLElement | null } | null = null;
let docHeadings: Heading[] = [];
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
/** 配色風格與強調色（設定 → 外觀 → 配色）；畫面繪製前已由 theme-init.js 套用。 */
let palette: PaletteId = loadPalette();
let accent = loadAccent();
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

/** 工作項目相關的快取最多記幾筆（`setBounded`）。 */
const CACHE_MAX = 2000;

const preview = new Preview(previewEl, [
  highlightPlugin(),
  workItemChipsPlugin,
  mathPlugin(() => settings.value.math),
  mermaidPlugin(() => settings.value.mermaid, { open: (svg) => openDiagram(svg), copy: (svg) => void copyDiagram(svg) }),
  tablesPlugin(),
  codeToolsPlugin({
    copy: copyCode,
    skip: (lang) => (lang === "mermaid" && settings.value.mermaid) || (lang === "math" && settings.value.math),
  }),
  docLinksPlugin({ wikiExists: (target) => wikiExists(target) }),
  ...(desktop
    ? [
        localImagesPlugin(() => (cur.fileHandle?.path ? dirname(cur.fileHandle.path) : null), desktop.fileUrl, (p) => davImageCached(p)),
        wikiEditImagesPlugin(),
      ]
    : []),
  {
    name: "remote-images",
    apply() {},
    prepare(content) {
      if (blockRemote()) blockRemoteImages(content);
    },
  },
]);

/** 網頁檔（.html）的預覽。 */
const htmlPreview = new HtmlPreview($("#preview-scroller"), (href) => void followLink(href).catch(reportError));

function showHtmlPreview(text: string): void {
  const dir = cur.fileHandle?.path ? dirname(cur.fileHandle.path) : null;
  htmlPreview.show(text, active.id, {
    blockRemote: blockRemote(),
    image: (src) => {
      // 本機資料夾的圖片用程式的 mdimg: 網址；遠端資料夾（WebDAV、SSH）的先不載入。
      if (!desktop || !dir || /^(webdav|ssh):\/\//.test(dir)) return null;
      const path = localImagePath(src, dir);
      return path ? desktop.fileUrl(path) : null;
    },
  });
}

/** 表格排版：關閉自動對齊時只移動游標，不重排。 */
const tableFormatter = (block: string) => (settings.value.tableAutoFormat ? formatTable(block) : undefined);

const review = new Review($("#review-bar"));
/** AI 協作與終端機（桌面版才有，在下面的「AI 協作」段落建立）。 */
let ai: AiController | null = null;
let terminal: TerminalProxy | null = null;
let updater: Updater | null = null;

/** 按下 Ctrl+Shift+V 後的短時間內，貼上一律用純文字。 */
let plainPasteUntil = 0;

export type Pane = "main" | "side";
/** 並排編輯時游標所在的那一邊；「目前的文件」（active、editor、kind 等）都是那一邊的。 */
let focusedPane: Pane = "main";
/** 兩邊各顯示哪一份文件（沒有並排時 side 是 null）。 */
const paneDocs: { main: Doc; side: Doc | null } = { main: active, side: null };
/** 那一邊的文件、檔案：游標所在的那一邊用目前的全域變數，另一邊用分頁物件裡存的。 */
const paneDoc = (pane: Pane): Doc => (pane === focusedPane ? active : (paneDocs[pane] ?? active));
const paneHandle = (pane: Pane) => (pane === focusedPane ? cur.fileHandle : (paneDocs[pane]?.handle ?? null));
/** 這個編輯畫面是哪一邊的（兩個編輯器共用擴充與事件處理，靠 view 分辨）。 */
const paneOfView = (v: EditorView): Pane => (v === sideEditor?.view ? "side" : "main");

/** 編輯器的事件：只處理游標所在那一邊的（另一邊的捲動、內容不影響目前的文件）。 */
function editorHandlers(): EditorHandlers {
  return {
    onChange(doc, v) {
      if (paneOfView(v) !== focusedPane) return;
      scheduleRender();
      scheduleAutosave(doc);
      scheduleDiskSave();
      ai?.scheduleSync();
      refreshIndexPanels(800, { backlinks: false });
    },
    onSelection(v) {
      if (paneOfView(v) !== focusedPane) return;
      updateCursor(v);
      ai?.scheduleSync();
    },
    onScroll(line, v) {
      if (paneOfView(v) !== focusedPane) return;
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
    getError: (v) => (paneOfView(v) === focusedPane ? (preview.result?.error ?? null) : null),
  };
}

/** 編輯器的設定（左邊與並排的右邊共用；圖片網址依顯示圖片的那一邊的文件）。 */
function editorOptions(): EditorOptions {
  return {
    lineNumbers: settings.value.lineNumbers,
    autoPairBrackets: settings.value.autoPairBrackets,
    formatTable: tableFormatter,
    focusMode: settings.value.focusMode,
    typewriterMode: settings.value.typewriterMode,
    live: [workItemChips, livePreview({
      imageUrl(src, view) {
        const pane = view ? paneOfView(view) : focusedPane;
        if (/^https?:/i.test(src)) return blockRemote() ? null : src;
        if (/^data:image\//i.test(src)) return src;
        const doc = paneDoc(pane);
        if (doc.wiki) return wikiEditImage(doc.wiki, src);
        const docPath = paneHandle(pane)?.path;
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
    })],
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
      review.extension, cometFileGuard(), // COMET 的設定檔唯讀（app/comet-files.ts）
      EditorView.updateListener.of((u) => onSimplifiedPaste(u)),
      autoSymbols(() => cur.kind !== "json" && settings.value.autoSymbols),
      // 連到 Azure DevOps 工作項目、Wiki 頁面的連結：滑鼠移上去顯示摘要。
      hoverTooltip(
        (view, pos) => {
          const line = view.state.doc.lineAt(pos);
          const hit = urlAt(line.text, pos - line.from);
          const link = hit && remoteLinkOf(hit.url);
          if (!hit || !link) return null;
          return {
            pos: line.from + hit.from,
            end: line.from + hit.to,
            above: true,
            create: () => ({ dom: remoteCard(link, t("即時預覽中按住 Ctrl 點一下，或在預覽中點一下，就在 oMarker 開啟")) }),
          };
        },
        { hoverTime: 400 },
      ),
      proofread({
        enabled: () => cur.kind !== "json" && settings.value.termCheck,
        ignored: () => new Set(settings.value.termIgnore),
        ignore: (word) => {
          settings.update({ termIgnore: [...settings.value.termIgnore, word].slice(-TERM_IGNORE_LIMIT) });
          toast(t("不再提示「{word}」。之後可以在指令面板執行「{command}」恢復。", { word, command: commands.title("clear-term-ignore") }));
        },
      }),
      spellcheck({
        // 文件、Wiki 頁面才檢查（程式碼檔與 JSON 裡的英文多半是名稱）。
        enabled: () => cur.kind === "markdown" && settings.value.spellCheck,
        ignored: () => new Set(settings.value.spellIgnore),
        ignore: (word) => {
          const lower = word.toLowerCase();
          settings.update({ spellIgnore: [...settings.value.spellIgnore.filter((w) => w !== lower), lower].slice(-SPELL_IGNORE_LIMIT) });
          toast(t("已把「{word}」加入字典。之後可以在指令面板執行「{command}」恢復。", { word, command: commands.title("clear-spell-ignore") }));
        },
      }),
      linkCompletion(
        {
          enabled: () => cur.kind === "markdown",
          docPath: () => cur.fileHandle?.path ?? null,
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
            return resolveWiki(target, markdownFiles(fileListCache), cur.fileHandle?.path ? dirname(cur.fileHandle.path) : null);
          },
          remotePages: () => wikiLinkPages(1000),
        },
        [
          (ctx) => (cur.kind === "json" ? null : dateCompletion(ctx)),
          (ctx) => (cur.kind === "markdown" ? workItemIdCompletion(ctx) : null),
          (ctx) => (cur.kind === "markdown" ? slashSource(ctx) : null),
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
          if (plainOnly || !data || cur.kind !== "markdown" || !settings.value.smartPaste) return false;
          if (pasteLink(v, data.getData("text/plain"))) {
            e.preventDefault();
            return true;
          }
          if (data.types.includes("vscode-editor-data")) return false;
          const md = smartPasteText(v.state, data.getData("text/html"), data.getData("text/plain"));
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
          const show = () => setTimeout(() => contextMenu.open(at));
          if (e.buttons & 2) window.addEventListener("pointerup", show, { once: true });
          else show();
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
  };
}

const mainEditor = new Editor($("#editor"), loadDraft(active.id) ?? "", cur.kind, editorHandlers(), editorOptions());
/** 游標所在那一邊的編輯器（沒有並排時就是左邊這個）。 */
let editor = mainEditor;
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
  // 預覽沒有顯示時（即時預覽、原始碼）只更新大綱與字數，不必每個字都算：停手一下再更新。
  if (!previewVisible()) {
    clearTimeout(renderTimer);
    renderTimer = window.setTimeout(run, Math.min(400, Math.max(250, lastRenderMs * 2)));
  } else if (lastRenderMs > 25 || editor.view.state.doc.length > LARGE_DOC) {
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
  // 網頁檔：預覽照網頁本身的樣子顯示（iframe），一般的預覽只算統計。
  const html = isHtmlName(cur.fileName) && !full;
  const result = preview.update(text, cur.kind, html || (!full && !previewVisible()));
  if (html && previewVisible()) showHtmlPreview(text);
  else htmlPreview.hide();
  $("#preview-scroller").classList.toggle("html-mode", htmlPreview.shown);
  blocks = null;
  renderError(result);
  renderEmptyState(text);
  docHeadings = result.headings;
  if (!outlineView) renderOutline(result.headings);
  renderStats(result);
  renderSaveState();
  editor.relint();
  // 對齊捲動位置、標示目前的標題都要量元素的位置（強制重新排版）：放到下一個畫面更新時一起做，
  // 每次按鍵只排版一次。
  scheduleLayoutWork();
  lastRenderMs = performance.now() - started;
}

let layoutFrame = 0;
function scheduleLayoutWork(): void {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    syncPreview();
    updateActiveHeading();
  });
}

function renderError({ error }: RenderResult): void {
  previewEl.classList.toggle("stale", !!error);
  parseErrorEl.hidden = !error;
  if (!error) return;
  const msg = document.createElement("p");
  msg.append(icon("circle-alert"));
  const strong = document.createElement("strong");
  strong.textContent = t("{kind} 格式錯誤（第 {line} 行，第 {column} 欄）", { kind: KINDS[cur.kind].label, line: error.line, column: error.column });
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

/** 起始頁目前畫的內容（一樣就不重畫，最近開啟的檔案也不重讀）。 */
let emptyStateKey = "";
/** 按了「新增文件」的空白文件：不再顯示起始頁（直接開始寫）。 */
const startDismissed = new Set<string>();
/** 起始頁正顯示著（目前的分頁是還沒寫任何字的空白文件）。 */
let startOpen = false;
/** Azure DevOps、GitHub 的帳號讀到了沒（讀到之前不列「連線」，免得已連線的人看到一閃而過的連結）。 */
let accountsReady = false;

/** 還沒連線的 Azure DevOps、GitHub（起始頁的「連線」）。功能關掉時不列。 */
function startConnect(): StartAction[] {
  if (!desktop || !accountsReady) return [];
  const list: StartAction[] = [];
  if (ado && !ado.account)
    list.push({ icon: "briefcase-business", label: t("連線 Azure DevOps／TFS…"), run: () => settingsDialog.open("Azure DevOps") });
  if (github && !github.account) list.push({ icon: "github", label: t("登入 GitHub…"), run: () => settingsDialog.open("GitHub") });
  return list;
}

/**
 * 空白文件的起始頁：開始（新增、開啟檔案、開啟資料夾、從範本新增）、連線、專案與最近開啟的檔案、小提示。
 * 有預覽時放在預覽區；即時預覽、原始碼只有編輯區，改放在編輯區中間（不擋打字，打字就消失）。
 */
function renderEmptyState(text: string): void {
  // 不用 trim()：大文件每次都會複製一份字串。磁碟上的空白檔案、Wiki 頁面是使用者開的檔案，不顯示起始頁。
  const empty = !/\S/.test(text) && !startDismissed.has(active.id) && !cur.fileBacked && !cur.fileHandle && !active.wiki;
  emptyStateEl.hidden = !empty;
  if (startOpen !== empty) {
    startOpen = empty;
    // 起始頁不是文件：不顯示檢視切換，也不分檢視一律佔滿（分割時開始打字才分成左右兩半）。
    workspace.classList.toggle("start-open", empty);
    if (view === "split") return applyLayout(); // 版面排好後會再回到這裡畫起始頁
  }
  if (!empty) {
    emptyStateKey = "";
    return;
  }
  const inEditor = workspace.dataset.view === "editor";
  const host = inEditor ? $(".editor-pane") : previewScroller;
  if (emptyStateEl.parentElement !== host) host.append(emptyStateEl);
  emptyStateEl.classList.toggle("in-editor", inEditor);
  const connect = startConnect();
  const key = `${cur.kind}|${view}|${inEditor}|${currentLang()}|${connect.map((c) => c.icon).join()}`;
  if (key === emptyStateKey) return;
  emptyStateKey = key;
  // 只有預覽時旁邊沒有編輯區，第一個動作改成切換到可以打字的檢視。
  const previewOnly = view === "preview";
  const hint = previewOnly
    ? t("按「開始寫作」就能直接在畫面上打字，或從下面選一個開始")
    : inEditor
      ? t("直接打字就開始寫新文件，或從下面選一個開始")
      : t("在左邊打字就開始寫，這裡會即時顯示排版；或從下面選一個開始");
  const run = (id: string) => () => void commands.run(id).catch(reportError);
  const keysOf = (id: string) => {
    const keys = commands.get(id)?.keys;
    return keys ? formatKeys(keys) : undefined;
  };
  const actions: StartAction[] = [
    previewOnly
      ? { icon: "pencil", label: t("開始寫作"), primary: true, run: () => setView(cur.kind === "markdown" ? "live" : "editor") }
      : {
          icon: "pencil",
          label: t("新增文件"),
          keys: keysOf("new"),
          primary: true,
          // 這份就是新的空白文件：收起起始頁，直接開始寫。
          run: () => {
            startDismissed.add(active.id);
            renderEmptyState(editor.text);
            renderSaveState(); // 分頁列跟著出現（見 onlyBlankDoc）
            editor.view.focus();
          },
        },
    { icon: "file-text", label: t("開啟檔案…"), keys: keysOf("open"), run: run("open") },
  ];
  if (desktop) {
    actions.push({ icon: "folder-open", label: t("開啟資料夾…"), run: run("open-folder") });
    actions.push({ icon: "folder-plus", label: t("新專案…"), run: run("new-project") });
  }
  // 範本一律開成新的 Markdown 分頁，和目前空白分頁是什麼類型無關。
  actions.push({ icon: "layout-template", label: t("從範本新增…"), run: run("new-from-template") });
  const page = buildStartPage({
    hint,
    actions,
    connect,
    tips: [
      { keys: keysOf("quick-open"), label: t("找檔案"), run: run("quick-open") },
      { keys: keysOf("palette"), label: t("所有指令"), run: run("palette") },
      { keys: keysOf("show-shortcuts"), label: t("快速鍵一覽"), run: () => showShortcuts() },
      { label: t("把檔案拖進視窗就能開啟") },
    ],
    tour: () => openWelcome(),
  });
  emptyStateEl.replaceChildren(page);
  void renderStartRecent(page, () => key !== emptyStateKey);
}

initOutlineList();

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
    // 連到 Azure DevOps 儲存庫裡的 Markdown 等文字檔：在 oMarker 裡閱讀，不下載。
    if (openRepoFileLink(href)) return;
    // 連到工作項目、Wiki 頁面的連結在 oMarker 裡開啟（讀不到就照舊用瀏覽器）。
    if (await openRemoteLink(href)) return;
    if (desktop) await desktop.openExternal(href);
    else window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  // 其他協定（file: 等）一律不處理。
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return;
  const hashAt = href.indexOf("#");
  const rel = decodeHref(hashAt >= 0 ? href.slice(0, hashAt) : href);
  const anchor = hashAt >= 0 ? decodeHref(href.slice(hashAt + 1)) : "";
  const base = cur.fileHandle?.path;
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
setMermaidBlockRemote(blockRemote);

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


initOutline();
initDocStats();

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

/**
 * 草稿在停手多久後寫入：寫入瀏覽器的儲存空間是同步的，文件越大越久（會卡住畫面），
 * 大文件不要每停一下就寫：100 KB 以下 0.4 秒，之後每 100 KB 多等 0.4 秒，最多 3 秒。
 */
function draftDelay(length: number): number {
  return Math.min(3000, 400 * Math.max(1, Math.ceil(length / 100_000)));
}

function scheduleAutosave(doc: Text): void {
  clearTimeout(saveTimer);
  cur.draftSaved = false;
  // 記下是哪個分頁的內容：計時器觸發前可能已經切換到別的分頁。
  pendingDraft = { id: active.id, doc };
  saveTimer = window.setTimeout(flushDraft, draftDelay(doc.length));
}

/** 立刻寫入尚未儲存的草稿（切換、關閉分頁前呼叫）。 */
function flushDraft(): void {
  clearTimeout(saveTimer);
  if (!pendingDraft) return;
  const { id, doc } = pendingDraft;
  pendingDraft = null;
  if (!docs.some((d) => d.id === id)) return; // 分頁已經關閉
  const text = doc.toString();
  cur.draftSaved = saveDraft(id, text);
  // 儲存空間滿了：先清掉其他「已存檔、沒改過」分頁的草稿（之後從檔案讀回），再試一次。
  if (!cur.draftSaved && freeDraftSpace(id)) cur.draftSaved = saveDraft(id, text);
  if (!cur.draftSaved && !draftWarned) {
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
  cur.fileName = name;
  persistSession();
  renderSaveState();
  renderTabs();
}

function setKind(next: DocKind, { rename = true } = {}): void {
  if (next === cur.kind) return;
  cur.kind = next;
  kindSelect.value = next;
  persistSession();
  editor.setKind(next);
  // 還沒對應到實際檔案時，順便改副檔名，存檔時才會是正確的類型。
  if (rename && !cur.fileHandle) setFileName(replaceExtension(cur.fileName, KINDS[next].ext));
  preview.clear();
  buildFormatBar();
  renderNow();
  applyLayout();
}

function setBaseline(text: string, backed: boolean): void {
  cur.baseline = hash(text);
  cur.fileBacked = backed;
  persistSession();
}

// ---- 分頁 ---------------------------------------------------------------

const tabBar = new TabBar($("#tab-bar"), {
  select: (id, via) => {
    selectTab(id);
    // 用滑鼠點文件的分頁：游標放回編輯器，可以直接打字（方向鍵切換時焦點留在分頁上）。
    if (via === "pointer" && docs.some((d) => d.id === id)) editor.view.focus();
  },
  close: (id) => {
    if (findItemTab(id)) closeItem(id);
    else void closeTab(id).catch(reportError);
  },
  create: () => void commands.run("new"),
  canRename: (id) => {
    const doc = docs.find((d) => d.id === id);
    return !!doc && ((doc === active ? cur.fileHandle : doc.handle) === null || canRenameFile(tabPath(doc)));
  },
  rename: (id, name) => renameDoc(id, name),
  menu: (id, at) => {
    menuTabId = id;
    tabMenu.open(at);
  },
  unpair: () => closeSide(),
  unpin: (id) => {
    if (findItemTab(id)) return setItemPinned(id, false);
    const doc = docs.find((d) => d.id === id);
    if (doc) setPinned(doc, false);
  },
});
// 拖曳分頁到編輯區的右半邊並排開啟。
initSideDrop();
// ---- 分頁選單：關閉其他、關閉右側、固定分頁…… ---------------------------------

/** 按右鍵的分頁；從指令面板執行時是目前的分頁。 */
let menuTabId: string | null = null;
const menuTab = (): Doc => docs.find((d) => d.id === menuTabId) ?? active;
/** 按右鍵的是工作項目等的分頁時是它（從指令面板執行時是顯示中的那一個）；文件的分頁時是 null。 */
const menuItemTab = () => (menuTabId ? (findItemTab(menuTabId) ?? null) : focusedItem());

/** 關掉好幾個分頁（文件或工作項目等）：沒存的文件會逐一詢問。 */
async function closeTabIds(ids: string[]): Promise<void> {
  closeItems(itemTabs.filter((tab) => ids.includes(tab.id)));
  await closeTabs(docs.filter((d) => ids.includes(d.id)));
}

/** 分頁固定了沒有（文件或工作項目等）。 */
const tabPinned = (id: string): boolean => !!(findItemTab(id)?.pinned ?? docs.find((d) => d.id === id)?.pinned);

/** 切換到分頁（文件或工作項目等）。 */
function selectTab(id: string): void {
  if (findItemTab(id)) return selectItem(id);
  const doc = docs.find((d) => d.id === id);
  if (doc) activate(doc);
}
const tabPath = (doc: Doc): string | null => (doc === active ? cur.fileHandle?.path : doc.path) ?? null;

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

/** 在分頁上改名：存成檔案的和檔案面板一樣改磁碟上的檔名；還沒存成檔案的只改名稱（存檔時的預設檔名），輸入已知的副檔名時順便切換文件類型。 */
function renameDoc(id: string, name: string): void {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  const path = tabPath(doc);
  if (path) return void renameEntry({ path, name: basename(path), isDir: false }, name).catch(reportError);
  if (doc !== active) {
    doc.name = name;
    persistSession();
    renderTabs();
    return;
  }
  setFileName(name);
  const k = kindFromFileName(name);
  if (isTextFileName(name) && k !== cur.kind) setKind(k, { rename: false });
}

// ---- 側邊欄：檔案、大綱、搜尋 ---------------------------------------------

export type SidePanel = "files" | "outline" | "search" | "tasks" | "tags" | "issues" | "workitems" | "board" | "wiki" | "git";
const SIDE_PANELS: SidePanel[] = ["files", "outline", "search", "tasks", "tags", "issues", "workitems", "board", "wiki", "git"];
const sideTabs = [...document.querySelectorAll<HTMLButtonElement>(".activity-tabs [role=tab]")];
/** 前幾版的「Azure DevOps」面板（裡面切換工作項目與 Wiki）；現在拆成「工作項目」「Wiki」兩個面板。 */
const LEGACY_ADO_PANEL = "ado";
/** 舊設定的「Azure DevOps」面板換成當時切到的那一邊。 */
const legacyAdoTab = (): SidePanel => (storage.load("ado-panel-tab") === "wiki" ? "wiki" : "workitems");
const savedSidePanel = storage.load("side-panel");
let sidePanel: SidePanel =
  SIDE_PANELS.find((p) => p === (savedSidePanel === LEGACY_ADO_PANEL ? legacyAdoTab() : savedSidePanel)) ?? "outline";
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
      action: (action, entry) => void treeAction(action, entry).catch(reportError), mark: cometTreeMark,
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
      newProject: () => void commands.run("new-project").catch(reportError),
      aiAppInstalled: aiAppPresent,
      close: () => void commands.run("close-folder").catch(reportError),
      closeAndWait: () => closeProject(),
      remotes: () => (features.remote ? desktop!.davConnections() : Promise.resolve([])),
      openRemote: (c) => void openRemote(c).catch(reportError),
      changed: () => void renderProjectName().then(renderFilesEmpty),
      unsaved: (path) =>
        (peekSession(path)?.docs ?? []).some((m) => m.baseline !== null && draftState(m).dirty),
      repoSources,
    })
  : null;

/** 側邊欄上方與狀態列的專案名稱（自訂名稱與顏色）。 */
async function renderProjectName(): Promise<void> {
  if (workspaceRoot && !isRemote(workspaceRoot.path)) await projectUi?.refresh();
  const project = workspaceRoot ? projectUi?.current : undefined;
  const label = project?.label ?? workspaceRoot?.name ?? t("檔案");
  const color = project?.color ?? null;
  const keys = commands.get("switch-project")?.keys;
  const hint = keys ? t("切換專案（{keys}）", { keys: formatKeys(keys) }) : t("切換專案");
  const comet = !!project?.comet;
  $("#folder-name").textContent = label;
  const switcher = $(".project-switch");
  switcher.querySelector(".comet-badge")?.remove();
  if (comet) $("#folder-name").after(cometBadge());
  switcher.title = workspaceRoot ? `${displayPath(workspaceRoot.path)}\n${hint}` : hint;
  const dot = switcher.querySelector<HTMLElement>(".project-dot")!;
  dot.hidden = !workspaceRoot;
  if (color) dot.dataset.color = color;
  else delete dot.dataset.color;
  // 圖示列最上方的專案方塊：專案的顏色與縮寫；沒有開資料夾時是資料夾圖示。
  const button = $("#activity-project");
  button.hidden = !projectUi;
  const name = workspaceRoot ? label : t("開啟資料夾或切換專案");
  const cometLabel = t("COMET 專案");
  const kind = comet ? `\n${cometLabel}` : "";
  button.title = workspaceRoot ? `${label}${kind}\n${displayPath(workspaceRoot.path)}\n${hint}` : `${name}\n${hint}`;
  button.classList.toggle("comet", comet);
  button.setAttribute("aria-label", name);
  const avatar = button.querySelector<HTMLElement>(".project-avatar")!;
  if (workspaceRoot) avatar.textContent = projectInitials(label);
  else avatar.replaceChildren(icon("folder-open"));
  avatar.classList.toggle("empty", !workspaceRoot);
  if (color) avatar.dataset.color = color;
  else delete avatar.dataset.color;
  // 「專案色」配色的上方列用專案的顏色。
  if (workspaceRoot && color) document.documentElement.dataset.projectColor = color;
  else delete document.documentElement.dataset.projectColor;
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
const github = desktop && features.git
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
        renderEmptyState(editor.text);
        refreshRepoNotes();
      },
    })
  : null;

/** Azure DevOps（桌面版）：用個人存取權杖連線、從 ADO 開啟儲存庫或 Wiki、查看工作項目。 */
const ado = desktop && features.ado
  ? new Ado(desktop, {
      openFolder: async (folder) => {
        await setWorkspace(folder);
        showPanel("files");
      },
      changed: () => {
        renderAdoTab();
        workItemsPanel?.reset();
        wikiPanel?.reset();
        if (sidePanel === "workitems" || sidePanel === "wiki") showPanel(sidePanel, false);
        settingsDialog.refresh();
        void gitPanel?.refresh();
        renderEmptyState(editor.text);
        refreshRepoNotes();
      },
      openSettings: () => settingsDialog.open("Azure DevOps"),
    })
  : null;
// 帳號讀到後，起始頁才列出還沒連線的 Azure DevOps、GitHub。
void Promise.all([ado?.ready(), github?.ready()]).then(() => {
  accountsReady = true;
  renderEmptyState(editor.text);
  refreshRepoNotes();
});

let wikiListCache: Promise<AdoWiki[]> | null = null;
initAdoLinks();

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
      const src = img.dataset.adoSrc!;
      img.dataset.offlineKey = `ado-img:${src}`;
      void offlineImage(img.dataset.offlineKey, () => desktop!.adoImage(src))
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
      const path = img.dataset.wikiSrc!;
      img.dataset.offlineKey = `wiki-img:${page.wiki.id}:${path}`;
      void offlineImage(img.dataset.offlineKey, () => desktop!.adoWikiImage(page.wiki, path))
        .then((url) => (img.src = url))
        .catch((e) => (img.title = e instanceof Error ? e.message : String(e)));
    }
  },
};

/** 主要區域開著的頁面（圖片記在它底下）。 */
let issueKey: string | null = null;
initOfflineCopies();

/** 正在看的儲存庫檔案（內容裡相對路徑的圖片以它為準）。 */
let repoFile: Extract<RepoFileLink, { kind: "git" }> | null = null;
initWikiHistory();
initWikiEdit();

initStatusView();
// 並排顯示時，檢視打開或關閉要重新排版（編輯區讓出右半邊）。
let issueWasOpen = false;
new MutationObserver(() => {
  const open = workspace.classList.contains("issue-open");
  if (open === issueWasOpen) return;
  issueWasOpen = open;
  if (issueSide) applyLayout();
}).observe(workspace, { attributes: true, attributeFilter: ["class"] });

/** 工作項目的篩選條件（記住上次的選擇）。 */
const workItemFilter: AdoWorkItemFilter = parseWorkItemFilter(storage.load("workitem-filter"));
const isDefaultFilter = () => isDefaultWorkItemFilter(workItemFilter);
/** 清單上要不要顯示指派給誰（只看自己的就不必）。 */
const showAssignee = () => !(workItemFilter.role === "assigned" && workItemFilter.person === "@me");

/** 讀取篩選列的選項（第一次列出工作項目時）。 */
let loadWorkItemFilterOptions = (): void => {};

initWorkItemsPanel();
initTaskboard();
initAdoStatus();

/** 最近一次「指派給你、還沒結束」的清單（背景檢查或面板的預設清單）。 */
let pollItems: AdoWorkItem[] = [];
initWorkItemUpdates();

/** 上次的 Git 狀態摘要（變了才重新載入歷史）。 */
let gitHistoryKey = "";
initGitHistory();

initWorkspaceUi();

// ---- 分頁的狀態 -------------------------------------------------------

/** 把全域變數（目前分頁）寫回分頁物件。 */
function stash(): void {
  Object.assign(active, {
    kind: cur.kind,
    name: cur.fileName,
    handle: cur.fileHandle,
    path: cur.fileHandle?.path ?? null,
    baseline: cur.baseline,
    fileBacked: cur.fileBacked,
    state: editor.state,
    scrollTop: editor.view.scrollDOM.scrollTop,
    dirty: cur.baseline !== editorHash(),
  });
}

function persistSession(): void {
  stash();
  saveSession(
    {
      activeId: active.id,
      docs: docs.map(({ id, name, kind, path, baseline, fileBacked, pinned, wiki }) => ({ id, name, kind, path, baseline, fileBacked, pinned, wiki })),
    },
    tabScope,
  );
}

function renderTabs(): void {
  const infos = new Map<string, TabInfo>([
    ...docs.map((d): [string, TabInfo] => [
      d.id,
      {
        id: d.id,
        name: docName(d),
        title: d.wiki
          ? t("Azure DevOps Wiki：{wiki}{path}（按 Ctrl+S 存回伺服器）", { wiki: d.wiki.wikiName, path: d.wiki.path })
          : (((p) => (p ? displayPath(p) : null))(d === active ? cur.fileHandle?.path : d.path) ?? docTooltip(d)),
        source: d.wiki ? ("wiki" as const) : undefined,
        dirty: d.dirty,
        missing: d.missing,
        pinned: d.pinned,
      },
    ]),
    ...itemTabs.map((tab): [string, TabInfo] => [tab.id, itemTabInfo(tab)]),
  ]);
  // 工作項目、Wiki 頁面等和文件排在一起；蓋住編輯區顯示時，標成目前的分頁。
  // 並排中的兩份文件合成一個「左｜右」的分頁（見 TabBar.render）。
  tabBar.render(
    tabOrder().map((id) => infos.get(id)!),
    selectedItemId() ?? active.id,
    paneDocs.side ? { main: paneDocs.main.id, side: paneDocs.side.id } : undefined,
  );
  // 並排時另一邊的文件。
  const besideId = ((p) => (p ? paneDocs[p]?.id : undefined))(otherPane());
  document.querySelectorAll<HTMLElement>("#tab-bar .tab").forEach((tab) => tab.classList.toggle("tab-beside", tab.dataset.id === besideId));
  refreshOtherPane();
  if (paneDocs.side) renderPaneHeads();
  // 只有一份空白文件時藏起分頁列的內容；有工作項目等分頁時照常顯示（才點得回文件）。
  $("#tab-bar").classList.toggle("has-items", itemTabs.length > 0);
  markBlankTab();
  markBarShortcuts(); // 左側圖示列上的檔案捷徑：開在中間的那一個加上小圓點
  const path = cur.fileHandle?.path ?? null;
  if (path !== treeActive) {
    treeActive = path;
    void fileTree?.setActive(path);
  }
}

/** 切換到另一個分頁。 */
// ---- 並排編輯 -----------------------------------------------------------
// 右邊再開一個編輯器顯示另一份文件。游標在哪一邊，那一邊的文件就是「目前的文件」：
// 存檔、格式、找字、大綱、狀態列都跟著它；另一邊的內容存在它的分頁物件裡（和沒顯示的分頁一樣）。

let sideEditor: Editor | null = null;

/** 兩邊的編輯器（設定改變時都要套用）。 */
function allEditors(): Editor[] {
  return sideEditor ? [mainEditor, sideEditor] : [mainEditor];
}

function paneEditor(pane: Pane): Editor | null {
  return pane === "main" ? mainEditor : sideEditor;
}

/** 並排時游標不在的那一邊；沒有並排時是 null。 */
function otherPane(): Pane | null {
  return paneDocs.side ? (focusedPane === "main" ? "side" : "main") : null;
}

function ensureSideEditor(): Editor {
  if (sideEditor) return sideEditor;
  // 和左邊共用擴充：文件的狀態（含復原紀錄）才能在兩邊之間搬。
  sideEditor = new Editor($("#editor-side"), "", "markdown", editorHandlers(), { ...editorOptions(), livePreview: liveApplied }, mainEditor);
  sideEditor.configure({ livePreview: liveApplied });
  sideEditor.view.dom.addEventListener("focusin", () => focusPane("side"));
  return sideEditor;
}

/**
 * 換到某一邊：先把目前這一邊的內容存回它的分頁（和切換分頁一樣：草稿、自動存檔、審閱），
 * 再把那一邊的文件當成目前的文件。`focusView`：把游標放進那一邊的編輯器。
 */
function focusPane(pane: Pane, focusView = false): void {
  const target = paneEditor(pane);
  const doc = paneDocs[pane];
  if (!target || !doc) return;
  if (pane !== focusedPane) {
    flushDraft();
    if (autoSavePending()) void autoSaveNow();
    if (review.active) review.finish();
    if (docs.includes(active)) stash();
    focusedPane = pane;
    editor = target;
    review.attach(editor.view);
    active = doc;
    ({ kind: cur.kind, name: cur.fileName, handle: cur.fileHandle, baseline: cur.baseline, fileBacked: cur.fileBacked } = doc);
    kindSelect.value = cur.kind;
    // 在另一邊時內容被換掉了（例如外部修改後重新讀取）：顯示新的內容。
    if (doc.state && doc.state.doc !== editor.state.doc) editor.restore(doc.state, cur.kind, doc.scrollTop);
    const v = editor.view;
    editorTopLine = v.state.doc.lineAt(v.lineBlockAtHeight(Math.max(0, v.scrollDOM.scrollTop - v.documentPadding.top)).from).number;
    preview.clear();
    buildFormatBar();
    persistSession();
    renderNow();
    applyLayout();
    renderTabs();
    renderOffline();
    renderWikiBar();
    renderWikiMine();
    updateCursor(v);
    ai?.scheduleSync();
    refreshIndexPanels(100);
  }
  renderPaneHeads();
  if (focusView) editor.view.focus();
}

initSideBySide();
mainEditor.view.dom.addEventListener("focusin", () => focusPane("main"));

function activate(doc: Doc): void {
  // 點分頁（包括目前的分頁）就回到文件，收起工作項目等（分頁留著；並排顯示時留在右邊）與 Git 歷史。
  if (!issueSide) hideItem();
  historyView?.close();
  // 並排的其中一份文件已經關掉（例如切換專案）：先關閉並排。
  if (paneDocs.side && (!docs.includes(paneDocs.side) || !docs.includes(paneDocs.main))) closeSide();
  // 另一邊顯示的文件：換到那一邊（同一份文件不會在兩邊各開一個）。
  const other = otherPane();
  if (other && paneDocs[other] === doc) {
    focusPane(other, true);
    return;
  }
  if (doc === active) return;
  flushDraft();
  // 切換前先把這個分頁還沒自動存的內容存起來（autoSaveNow 一開始就記下了分頁與內容）。
  if (autoSavePending()) void autoSaveNow();
  if (review.active) review.finish();
  if (docs.includes(active)) stash();
  active = doc;
  paneDocs[focusedPane] = doc;
  ({ kind: cur.kind, name: cur.fileName, handle: cur.fileHandle, baseline: cur.baseline, fileBacked: cur.fileBacked } = doc);
  kindSelect.value = cur.kind;
  if (doc.state) editor.restore(doc.state, cur.kind, doc.scrollTop);
  else editor.load(loadDraft(doc.id) ?? "", cur.kind);
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
  applyLayout();
  renderTabs();
  renderOffline();
  renderWikiBar();
  renderWikiMine();
  if (doc.wiki) void checkWikiNewer(doc);
  if (doc.externalOriginal !== undefined) {
    const original = doc.externalOriginal;
    doc.externalOriginal = undefined;
    showExternalChanges(original, editor.text);
  }
  ai?.scheduleSync();
  refreshIndexPanels(100);
}

/** 新增一個分頁並切換過去（不會寫入內容，呼叫端負責）。 */
/** 新增分頁：放在目前分頁的右邊；給了 `after` 時放在那個文件後面（null 是一般分頁的最前面）。都不插進固定的分頁之間。 */
function addTab(doc: Doc, after?: string | null): void {
  // 只剩一份沒顯示的空白文件（一開始、或關掉所有文件後補上的）：開好新分頁後收掉它，不多留一個「未命名」。
  const placeholder = onlyBlankDoc() ? active : null;
  const lastPinned = docs.reduce((n, d, i) => (d.pinned ? i + 1 : n), 0);
  const left = after === undefined ? docs.indexOf(active) : after === null ? -1 : docs.findIndex((d) => d.id === after);
  docs.splice(Math.max(left + 1, lastPinned), 0, doc);
  activate(doc);
  if (placeholder) {
    renumber(doc); // 新文件不必是「未命名 2」
    void closeTab(placeholder.id).then(renderSaveState); // 收掉之後重算名稱與視窗標題
  }
}

async function closeTab(id: string): Promise<void> {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  if (doc === active) stash();
  if (doc.dirty) {
    const choice = await choose(t("要存檔嗎？"), t("「{name}」有尚未存檔的變更。", { name: docName(doc) }), [
      { id: "save", label: t("存檔"), primary: true },
      { id: "discard", label: t("不存檔"), danger: true },
      { id: "cancel", label: t("取消") },
    ]);
    if (choice === "save") {
      activate(doc);
      await save(false);
      if (active.dirty || cur.baseline !== hash(editor.text)) return; // 取消存檔或存檔失敗
    } else if (choice !== "discard") {
      return;
    }
  }
  // 確定要關閉了才處理並排（問存檔時按「取消」就什麼都不變）：關掉並排中的文件時先關閉並排，另一份文件留在左邊。
  if (paneDocs.side === doc) closeSide();
  else if (paneDocs.side && paneDocs.main === doc) {
    const keep = paneDocs.side;
    closeSide();
    activate(keep);
  }
  if (pendingDraft?.id === doc.id) pendingDraft = null;
  rememberClosed(doc);
  docClosing(doc.id);
  const closedPath = docPath(doc);
  const i = docs.indexOf(doc);
  docs.splice(i, 1);
  // 遠端（WebDAV、SSH）的檔案：沒有其他分頁開著同一個檔案時，原生端不用再輪詢它、留著它的內容。
  if (desktop && closedPath && isRemote(closedPath) && !docs.some((d) => docPath(d) === closedPath)) {
    void desktop.davClose(closedPath).catch(() => {});
  }
  dropDraft(doc.id);
  remoteAllowed.delete(doc.id);
  forgetOutlineCollapse(doc.id);
  forgetChangeNotice(doc.id);
  wikiNewer.delete(doc.id);
  wikiCheckedAt.delete(doc.id);
  if (!docs.length) {
    const blank = makeDoc({ name: t("未命名{ext}", { ext: KINDS[cur.kind].ext }), kind: cur.kind });
    docs.push(blank);
  }
  if (doc === active) {
    const next = docs[Math.min(i, docs.length - 1)];
    active = doc; // 讓 activate 知道要換掉的是這個分頁
    activate(next);
    // 只剩一份空白文件、還開著工作項目等分頁：換到那些分頁（空白文件的分頁不顯示，見 markBlankTab）。
    if (itemTabs.length && onlyBlankDoc()) selectItem(itemTabs[itemTabs.length - 1].id);
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
/** 關閉的文件或工作項目等的分頁（`item`）。 */
const closedTabs: (ClosedTab | { item: ClosedItem })[] = [];

function rememberClosedItem(item: ClosedItem): void {
  closedTabs.push({ item });
  while (closedTabs.length > 20) closedTabs.shift();
}
/** 重新開啟分頁的清單，保留的內容合計上限（字元數，約 16 MB）。 */
const CLOSED_TABS_TEXT_LIMIT = 8_000_000;

function rememberClosed(doc: Doc): void {
  const text = (doc === active ? editor.text : loadDraft(doc.id)) ?? "";
  const path = doc === active ? (cur.fileHandle?.path ?? null) : doc.path;
  if (!path && !text.trim()) return; // 空白的新文件不用記
  closedTabs.push({ name: doc === active ? cur.fileName : doc.name, kind: doc.kind, path, text, dirty: doc.dirty });
  // 最多記 20 個；內容合計太大時（例如關掉好幾份大文件）先丟掉最舊的，避免一直佔著記憶體。
  const size = (c: (typeof closedTabs)[number]) => ("text" in c ? c.text.length : 0);
  let total = closedTabs.reduce((n, c) => n + size(c), 0);
  while (closedTabs.length > 20 || (closedTabs.length > 1 && total > CLOSED_TABS_TEXT_LIMIT)) total -= size(closedTabs.shift()!);
}

async function reopenClosedTab(): Promise<void> {
  const closed = closedTabs.pop();
  if (!closed) {
    toast(t("沒有剛關閉的分頁。"));
    return;
  }
  if ("item" in closed) return reopenItem(closed.item);
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

/** 切換到下一個（`step` 是 1）或上一個分頁，工作項目等的分頁也算。 */
function cycleTab(step: number): void {
  const order = tabOrder();
  const i = order.indexOf(selectedItemId() ?? active.id);
  selectTab(order[(i + step + order.length) % order.length]);
}

/** 找出已經開啟同一個檔案的分頁。 */
function tabForPath(path: string): Doc | undefined {
  return docs.find((d) => (d === active ? cur.fileHandle?.path : d.path) === path);
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
  // 編輯中的 Wiki 頁面（空白的也一樣）不沿用：沿用了會帶著 Wiki 的資訊，Ctrl+S 把檔案的內容存回 Wiki。
  const untouched = !cur.fileBacked && !active.wiki && (editor.text === "" || (editor.text === sample && !active.dirty));
  if (!untouched) addTab(makeDoc({ name, kind: docKind ?? kindFromFileName(name) }));
  if (review.active) review.finish();
  cur.fileHandle = handle;
  cur.kind = docKind ?? kindFromFileName(name);
  kindSelect.value = cur.kind;
  cur.fileName = name;
  editor.load(text, cur.kind);
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
  } else if (file.encoding && file.encoding !== "utf-8" && isRemote(file.handle?.path)) {
    // 本機檔案存檔時照原本的編碼寫回（見 app/file-format.ts）；遠端資料夾的檔案一律存成 UTF-8。
    toast(t("這個檔案是 {encoding} 編碼，已轉換後顯示；遠端的檔案存檔時會改存成 UTF-8。", { encoding: encodingLabel(file.encoding) }), { duration: 8000 });
  }
}

async function save(saveAs: boolean, force = false): Promise<void> {
  if (active.unloaded && !saveAs) {
    toast(t("「{name}」的內容還沒從檔案讀進來，先不存檔，免得把檔案蓋成空白。", { name: active.name }), { tone: "error" });
    return;
  }
  if (active.lossy && !saveAs && cur.fileHandle?.path) {
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
  const conflict = await exclusiveSave(() => saveNow(saveAs, force));
  // 檔案的編碼（例如 Big5）寫不進某些字：問要不要改存成 UTF-8，要的話再存一次。
  if (conflict && "chars" in conflict) return void ((await askUtf8(conflict)) && (await save(saveAs)));
  // 衝突處理可能再存一次（覆蓋、另存），要在這次存檔結束之後。
  if (conflict) await resolveConflict(conflict.name, conflict.diskText);
}

/** 實際存檔；遇到衝突時回傳伺服器（磁碟）上的版本，交給呼叫端處理。 */
async function saveNow(saveAs: boolean, force: boolean): Promise<{ name: string; diskText: string } | Extract<SaveOutcome, { status: "unencodable" }> | void> {
  if (review.active) review.finish();
  refreshToc();
  // 手動存檔後恢復自動存檔。
  resumeAutoSave();
  const text = editor.text;
  // 編輯中的 Wiki 頁面：存回伺服器（另存新檔則照常存成本機檔案）。
  if (active.wiki && !saveAs && desktop) return saveWikiPage(text, force);
  let out: Awaited<ReturnType<typeof saveFile>>;
  try {
    out = await saveFile(text, saveFileName(), cur.kind, cur.fileHandle, { saveAs, force });
  } catch (e) {
    if (isOffline(e) && cur.fileHandle?.path) {
      showOffline(cur.fileHandle.path);
      return;
    }
    const path = cur.fileHandle?.path;
    const message = e instanceof Error ? e.message : String(e);
    if (isRemote(path) && NOT_CONNECTED.some((m) => message.startsWith(m))) {
      if (await suggestReconnect(path, (name) => t("還沒有連線到「{name}」，重新連線後再存檔。", { name }))) return;
    }
    throw e;
  }
  if (!out) return;
  if (out.status === "conflict") return { name: out.name, diskText: out.diskText };
  if (out.status === "unencodable") return out;
  cur.fileHandle = fileSaved(cur.fileHandle?.path, out.handle); // 新檔案：檔案樹要自己更新
  // 另存成本機檔案之後，這個分頁就是那個檔案，不再對應 Wiki 頁面。
  if (out.handle) active.wiki = undefined;
  active.missing = false;
  // 已經存成 UTF-8 了。
  active.lossy = false;
  // 換了位置：相對路徑的圖片、[[連結]] 要重新對應。
  preview.invalidate();
  scheduleRender();
  if (offline && offline.path === cur.fileHandle?.path) clearOffline();
  gitPanel?.refreshSoon(300);
  setBaseline(text, true);
  setFileName(out.name);
  toast(out.handle ? t("已存檔為「{name}」", { name: out.name }) : t("已下載「{name}」", { name: out.name }), { tone: "success" });
}

initOfflineDrive();

initCommands();
initAiTerminal();

initFileHistory();

initGitActions();
initErrorHandling();

// ---- 工具列 -------------------------------------------------------------

function withKeys(title: string, keys?: string): string {
  return keys ? t("{title}（{keys}）", { title, keys: formatKeys(keys) }) : title;
}

/**
 * 按鈕提示裡的快速鍵：有 `data-keys-for`（指令 id）的元素，提示是「指令名稱（快速鍵）」；
 * 再加上 `data-keys-label="aria"` 的用 aria-label 當名稱。自訂快速鍵之後全部重新套用，
 * 滑鼠移上去時也會再更新一次（不在畫面上的按鈕，例如浮出的格式按鈕）。
 */
function keyHint(el: HTMLElement): void {
  const cmd = commands.get(el.dataset.keysFor!);
  if (!cmd) return;
  const label = el.dataset.keysLabel === "aria" ? (el.getAttribute("aria-label") ?? cmd.title) : cmd.title;
  el.title = withKeys(label, cmd.keys);
  if (cmd.keys) el.dataset.keys = formatKeys(cmd.keys);
  else delete el.dataset.keys;
}

function refreshKeyHints(): void {
  document.querySelectorAll<HTMLElement>("[data-keys-for]").forEach(keyHint);
  void renderProjectName();
}

document.addEventListener(
  "pointerover",
  (e) => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-keys-for]") : null;
    if (el) keyHint(el);
  },
  { capture: true, passive: true },
);

document.querySelectorAll<HTMLButtonElement>("[data-command]").forEach((btn) => {
  const cmd = commands.get(btn.dataset.command!)!;
  btn.dataset.keysFor = cmd.id;
  btn.title = withKeys(cmd.title, cmd.keys);
  if (btn.classList.contains("icon-only")) btn.setAttribute("aria-label", cmd.title);
  btn.addEventListener("click", () => commands.run(cmd.id).catch(reportError));
});
initMainMenu();
// 側邊欄圖示的提示附上快速鍵（例如「檔案（Ctrl+Shift+E）」）。網頁版不能在資料夾中搜尋，Ctrl+Shift+F 沒有作用，不寫。
for (const [tab, id] of [
  ["#side-tab-files", "show-files"],
  ...(desktop ? ([["#side-tab-search", "search-in-folder"]] as const) : []),
  ["#side-tab-git", "show-git"],
] as const) {
  const el = $(tab);
  el.dataset.keysFor = id;
  el.dataset.keysLabel = "aria";
  keyHint(el);
}

initActivityBar();
initNewWorkItem();
initDocLanguage();
initFileFormat();

// ---- 版面 ---------------------------------------------------------------

/** 預覽窗格現在看得到嗎（分割或只顯示預覽）。 */
function previewVisible(): boolean {
  // 工作項目並排時右半邊被佔住，「分割」當成即時預覽，只有「預覽」看得到預覽（在左半邊）。
  if (workspace.classList.contains("issue-side")) return view === "preview";
  return view === "preview" || (view === "split" && !narrowQuery.matches);
}

function applyLayout(): void {
  view = currentView(cur.kind); // 這種文件用不到的模式退回原始碼（見 view-modes.ts）
  const narrow = narrowQuery.matches;
  // 手機寬度放不下並排，分割模式改為只顯示編輯區（可用分頁切換到預覽）。
  // 起始頁也一樣：佔滿整個區域，開始打字後才分成左右兩半。
  const effective: ViewMode = (narrow || startOpen) && view === "split" ? "editor" : view;
  // 工作項目等內容和編輯區並排：版面當成分割，右半邊放內容（預覽藏起來）。
  const side = issueSide && !narrow && workspace.classList.contains("issue-open");
  // 兩份文件並排：右半邊放另一個編輯器。視窗太窄、工作項目要並排時關閉並排。
  if (paneDocs.side && (narrow || side)) closeSide();
  const docSide = !!paneDocs.side;
  workspace.classList.toggle("doc-side", docSide);
  if (workspace.classList.contains("issue-side") !== side) {
    workspace.classList.toggle("issue-side", side);
    // 分頁列上標成目前分頁的換了（並排時是文件，蓋住編輯區時是工作項目等）。
    renderTabs();
  }
  // 工作項目並排時右半邊被佔住：「分割」當成即時預覽，「預覽」換到左半邊（編輯區的位置）顯示。
  const shown: ViewMode = side && effective === "split" ? "live" : effective;
  workspace.classList.toggle("side-preview", side && shown === "preview");
  // 即時預覽的版面和只顯示編輯區相同，差別在編輯區裡直接顯示排版。
  const layout = side || docSide ? "split" : shown === "live" ? "editor" : shown;
  workspace.dataset.view = layout;
  workspace.classList.toggle("live", shown === "live");
  if (liveApplied !== (shown === "live")) {
    liveApplied = shown === "live";
    for (const ed of allEditors()) ed.configure({ livePreview: liveApplied });
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
    rightColumnOn() ? "var(--outline-right-width)" : "0px",
  ];
  workspace.style.gridTemplateColumns = cols.join(" ");
  applyViewSwitch(document, cur.kind, effective);
  // 側邊欄打開時，分頁從編輯區的左緣開始，和下面的欄位對齊。
  $(".topbar").classList.toggle("with-sidebar", outlineShown && !narrow);
  $(".topbar").classList.toggle("with-right", rightColumnOn());
  // 右上角那一塊：右側欄的分頁列（app/right-tabs.ts）和收起／打開右側欄的開關；沒有任何分頁時整塊藏起來。
  const rightToggle = $("[data-command='toggle-outline-right']");
  rightToggle.hidden = availableRightTabs().length === 0;
  $(".top-actions").hidden = rightToggle.hidden;
  if (rightToggle.getAttribute("aria-pressed") !== String(rightOutlineShown)) {
    rightToggle.setAttribute("aria-pressed", String(rightOutlineShown));
    rightToggle.replaceChildren(icon(rightOutlineShown ? "panel-right-on" : "panel-right"));
  }
  // 側邊欄開關：寬視窗在圖示列最上面，窄視窗在左上角（兩顆一起更新）。
  for (const navToggle of document.querySelectorAll<HTMLElement>("[data-command='toggle-outline']")) {
    if (navToggle.getAttribute("aria-pressed") === String(outlineShown)) continue;
    navToggle.setAttribute("aria-pressed", String(outlineShown));
    navToggle.replaceChildren(icon(outlineShown ? "panel-left-on" : "panel-left"));
  }
  renderEmptyState(editor.text);
  blocks = null;
  if (effective !== "preview") editor.view.requestMeasure();
  // 視窗變寬而出現預覽時（分割檢視），補畫之前略過的預覽。
  if (preview.stale && previewVisible()) scheduleRender();
}

function setView(mode: ViewMode): void {
  // 分割、只看預覽要用到右半邊：先關閉並排。
  if (paneDocs.side && (mode === "split" || mode === "preview")) closeSide();
  if (!issueSide) hideItem();
  historyView?.close();
  chooseView(mode);
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
  colorsChanged();
}

function setPalette(id: PaletteId): void {
  palette = id;
  savePalette(palette, accent);
  applyPalette(document.documentElement, palette, accent);
  colorsChanged();
}

/** `value` 是空字串（用配色風格自己的強調色）、預設的顏色名稱或自訂的 #rrggbb。 */
function setAccent(value: string): void {
  accent = value;
  savePalette(palette, accent);
  applyPalette(document.documentElement, palette, accent);
  colorsChanged();
}

/** 上一次畫流程圖時是不是深色（配色改了但明暗沒變時，不必重畫）。 */
let drawnDark: boolean | null = null;

/** 明暗或配色改了：終端機跟著換色；流程圖的配色跟著明暗，變了才重畫。 */
function colorsChanged(): void {
  terminal?.applyTheme();
  const dark = isDark();
  if (drawnDark === dark) return;
  const first = drawnDark === null;
  drawnDark = dark;
  if (first || !settings.value.mermaid) return;
  preview.invalidate();
  scheduleRender();
  for (const ed of allEditors()) refreshLivePreview(ed.view);
  rerenderIssue();
}

// 跟隨系統時，系統切換深淺色也要重畫流程圖。
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (themePref === "system") colorsChanged();
});

initSettingsUi();
initFileDrop();

// ---- 初始狀態 -----------------------------------------------------------

view = currentView(cur.kind);
kindSelect.value = cur.kind;
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
// 第一次使用：圖示列旁邊短暫顯示每個圖示的名稱（畫面排好之後；側邊欄開著時留到之後啟動）。
window.setTimeout(() => showActivityLabels(firstLaunch), 800);
// 分頁關掉、專案移除後留下的草稿會一直佔著儲存空間：啟動一陣子後（分頁都存好了）清掉。
setTimeout(() => dropOrphanDrafts(), 10_000);

if (desktop) void startDesktop(desktop).catch(reportError);

function docPath(doc: Doc): string | null {
  return doc === active ? (cur.fileHandle?.path ?? doc.path) : doc.path;
}

// 關閉視窗或重新整理前，把還沒寫入的草稿存起來。
window.addEventListener("pagehide", flushDraft);
