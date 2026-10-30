import "../../crates/md-core/src/document.css";
import "./styles.css";

import { undo } from "@codemirror/commands";
import { Decoration, type DecorationSet, EditorView, hoverTooltip, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { linksInLine, stateTone } from "./workitem-chips.ts";
import init, { type Heading, type RenderResult, formatTable, kindFromFileName, render as renderMarkdown } from "../pkg/md_wasm.js";
import { AiController } from "./ai.ts";
import { GitHub } from "./github-ui.ts";
import { Ado } from "./ado-ui.ts";
import { workItemLink } from "./ado-text.ts";
import { formatKeys, fuzzyScore } from "./commands.ts";
import { Editor, cursorInfo } from "./editor.ts";
import { type FileCommit, type FileItem, type Folder, desktop, displayPath, isRemote } from "./desktop.ts";
import type { EditorState, Text } from "@codemirror/state";
import { type FileHandle, type OpenedFile, desktopHandle, fromDesktop, replaceExtension, saveFile } from "./files.ts";
import { autoSymbols } from "./auto-symbols.ts";
import { refreshLivePreview } from "./live-preview.ts";
import { proofread } from "./proofread.ts";
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
import { TERM_IGNORE_LIMIT, SettingsStore } from "./settings.ts";
import { pasteAsMarkdown } from "./html-paste.ts";
import { hiddenByCollapse, subtreeEnd } from "./sections.ts";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { type HeadingRef, type RemotePage, encodeLinkPath, linkCompletion } from "./link-complete.ts";
import { type DocMeta, dropDraft, dropOrphanDrafts, loadDraft, loadSession, newId, peekSession, saveDraft, saveProjectView, saveSession, type Session } from "./session.ts";
import * as storage from "./storage.ts";
import { choose } from "./ui/choice.ts";
import { FileTree } from "./ui/filetree.ts";
import { hydrateIcons, icon } from "./ui/icons.ts";
import { type MenuEntry, setupMenu } from "./ui/menu.ts";
import { Picker } from "./ui/picker.ts";
import { currentLang, t, translateDom } from "./i18n.ts";
import { ProjectUi } from "./ui/project-ui.ts";
import { projectInitials } from "./projects.ts";
import { Review } from "./ui/review.ts";
import { flattenPages, imageRepoPath, pageName, wikiPageLink, wikiPageUrl } from "./wiki-text.ts";
import { type RepoFileLink } from "./repo-links.ts";
import { openLightbox } from "./ui/lightbox.ts";
import { dateCompletion } from "./date-complete.ts";
import { docLinksPlugin, wikiTarget } from "./plugins/doc-links.ts";
import { resolveWiki } from "./links.ts";
import { setBounded } from "./bounded.ts";
import { TabBar } from "./ui/tabbar.ts";
import { TerminalProxy } from "./terminal-proxy.ts";
import { Updater } from "./updater.ts";
import { sizeLabel, versionTitle } from "./history-label.ts";
import { choiceList } from "./multi-choice.ts";
import type { AdoWiki, AdoWorkItem, AdoWorkItemFilter, FileVersion, GitStatus } from "./desktop.ts";
import { parseRemoteLink, urlAt } from "./remote-links.ts";
import { insertHandle, selectionToolbar } from "./inline-tools.ts";
import { toast } from "./ui/toast.ts";
import { imageFiles, insertAtCursor, insertImages, wikiEditImage, wikiEditImagesPlugin } from "./app/image-paste.ts";
import { initFileDrop } from "./app/file-drop.ts";
import { clearOffline, isOffline, offline, otherWriter, renderOffline, resolveConflict, showOffline, storeName, initOfflineDrive } from "./app/offline-drive.ts";
import { initWikiHistory } from "./app/wiki-history.ts";
import { offlineImage, initOfflineCopies } from "./app/offline-copies.ts";
import { insertIssueLink, openRemoteLink, peekWorkItem, remoteCard, remoteLinkOf, wikiPagesCache, initAdoLinks } from "./app/ado-links.ts";
import { historyView, searchPanel, initGitHistory } from "./app/git-history.ts";
import { buildFormatBar, initNewWorkItem } from "./app/new-work-item.ts";
import { renderAdoTab, renderIssuesTab, wikiPanel, workItemsPanel, initWorkItemsPanel } from "./app/work-items-panel.ts";
import { initAdoStatus } from "./app/ado-status.ts";
import { gitPanel, noteWorkItems, pollWorkItems, renderAdoBadge, workItemSeen, initWorkItemUpdates } from "./app/work-item-updates.ts";
import { groupItems, showWorkItem } from "./app/work-item-actions.ts";
import { createPullRequest, reportError, resolveMergeConflict, showExternalChanges, switchBranch, initGitActions } from "./app/git-actions.ts";
import { addClaudeWorkflow, aiPicker, sendSelectionToAi, terminalAiReady, initAiTerminal } from "./app/ai-terminal.ts";
import { addActivityCommand, commandButton, contextMenu, copyCode, copyDiagram, formatBubble, headingMenu, importDocxData, insertMenu, openDiagram, openInsertMenu, refreshActivityCommands, refreshToc, separator, slashSource, startAiTool, symbolPicker, tabMenu, initActivityBar } from "./app/activity-bar.ts";
import { applySettings, onSimplifiedPaste, settingsDialog, initSettingsUi } from "./app/settings-ui.ts";
import { checkWikiNewer, issueSide, issueView, loadWikiLatest, renderWikiBar, renderWikiMine, rerenderIssue, showWikiPage, wikiCheckedAt, wikiNewer, initWikiEdit } from "./app/wiki-edit.ts";
import type { IssueFact } from "./ui/issue-view.ts";
import { TERMINAL_KEYS, commands, initCommands } from "./app/commands.ts";
import { NOT_CONNECTED, closeProject, davDialog, openPath, openRecentFolder, openRemote, openTag, outlineOnRight, outlinePlacedRight, panelAvailable, panelUnavailable, pendingPanel, placeOutline, refreshIndexPanels, renderFilesEmpty, setRightOutline, setWorkspace, showPanel, sshDialog, suggestReconnect, treeAction, uploadFiles, wideQuery, initWorkspaceUi } from "./app/workspace-ui.ts";
import { createWikiPage, deleteWikiPage, editWikiPage, openRepoFileLink, repoImagesPlugin, saveWikiPage, showIssue, wikiServerEtag } from "./app/ado-files.ts";
import { markdownFiles, openWiki, updateLinksAfterRename, wikiExists } from "./app/wiki-links.ts";
import { renderSaveState, renderStats, updateActiveHeading, initOutline } from "./app/outline.ts";
import { provideApp } from "./app/context.ts";

export type ViewMode = "editor" | "live" | "split" | "preview";
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
  get DEFAULT_WORK_ITEM_FILTER() {
    return DEFAULT_WORK_ITEM_FILTER;
  },
  get DOWNLOAD_URL() {
    return DOWNLOAD_URL;
  },
  get LEGACY_ADO_PANELS() {
    return LEGACY_ADO_PANELS;
  },
  get SIDE_PANELS() {
    return SIDE_PANELS;
  },
  get TERMINAL_KEYS() {
    return TERMINAL_KEYS;
  },
  get activate() {
    return activate;
  },
  get active() {
    return active;
  },
  get addActivityCommand() {
    return addActivityCommand;
  },
  get addClaudeWorkflow() {
    return addClaudeWorkflow;
  },
  get addTab() {
    return addTab;
  },
  get ado() {
    return ado;
  },
  get adoImagesPlugin() {
    return adoImagesPlugin;
  },
  get adoTab() {
    return adoTab;
  },
  set adoTab(v: typeof adoTab) {
    adoTab = v;
  },
  get ai() {
    return ai;
  },
  set ai(v: typeof ai) {
    ai = v;
  },
  get aiPicker() {
    return aiPicker;
  },
  get allowRemoteImages() {
    return allowRemoteImages;
  },
  get applyLayout() {
    return applyLayout;
  },
  get setIssueFacts() {
    return setIssueFacts;
  },
  get autoSaveNow() {
    return autoSaveNow;
  },
  get baseline() {
    return baseline;
  },
  get blockRemote() {
    return blockRemote;
  },
  get closeProject() {
    return closeProject;
  },
  get closeTab() {
    return closeTab;
  },
  get closeTabs() {
    return closeTabs;
  },
  get commandButton() {
    return commandButton;
  },
  get commands() {
    return commands;
  },
  get compareWithCommit() {
    return compareWithCommit;
  },
  get copyWebLink() {
    return copyWebLink;
  },
  get createPullRequest() {
    return createPullRequest;
  },
  get createWikiPage() {
    return createWikiPage;
  },
  get cycleTab() {
    return cycleTab;
  },
  get davDialog() {
    return davDialog;
  },
  get deleteWikiPage() {
    return deleteWikiPage;
  },
  get diskSaveTimer() {
    return diskSaveTimer;
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
  get draftSaved() {
    return draftSaved;
  },
  get editWikiPage() {
    return editWikiPage;
  },
  get editor() {
    return editor;
  },
  get editorHash() {
    return editorHash;
  },
  get editorTopLine() {
    return editorTopLine;
  },
  get fileBacked() {
    return fileBacked;
  },
  get fileHandle() {
    return fileHandle;
  },
  set fileHandle(v: typeof fileHandle) {
    fileHandle = v;
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
  get fileName() {
    return fileName;
  },
  set fileName(v: typeof fileName) {
    fileName = v;
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
  get gitPanel() {
    return gitPanel;
  },
  get github() {
    return github;
  },
  get groupItems() {
    return groupItems;
  },
  get hash() {
    return hash;
  },
  get headingMenu() {
    return headingMenu;
  },
  get historyPicker() {
    return historyPicker;
  },
  get importDocxData() {
    return importDocxData;
  },
  get indexStale() {
    return indexStale;
  },
  set indexStale(v: typeof indexStale) {
    indexStale = v;
  },
  get insertMenu() {
    return insertMenu;
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
  get issueView() {
    return issueView;
  },
  get kind() {
    return kind;
  },
  get kindSelect() {
    return kindSelect;
  },
  get loadWikiLatest() {
    return loadWikiLatest;
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
  get markdownFiles() {
    return markdownFiles;
  },
  get menuTab() {
    return menuTab;
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
  get noteWorkItems() {
    return noteWorkItems;
  },
  get offlineImage() {
    return offlineImage;
  },
  get openDocument() {
    return openDocument;
  },
  get openOnWeb() {
    return openOnWeb;
  },
  get openOpenedFile() {
    return openOpenedFile;
  },
  get openPath() {
    return openPath;
  },
  get openRepoFileLink() {
    return openRepoFileLink;
  },
  get openWorkItemById() {
    return openWorkItemById;
  },
  get outlineHeadings() {
    return outlineHeadings;
  },
  get outlineList() {
    return outlineList;
  },
  get outlinePlacedRight() {
    return outlinePlacedRight;
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
  get panelAvailable() {
    return panelAvailable;
  },
  get panelUnavailable() {
    return panelUnavailable;
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
  get pollWorkItems() {
    return pollWorkItems;
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
  get quickOpen() {
    return quickOpen;
  },
  get recentPicker() {
    return recentPicker;
  },
  get refreshActivityCommands() {
    return refreshActivityCommands;
  },
  get reloadDoc() {
    return reloadDoc;
  },
  get reloadDocs() {
    return reloadDocs;
  },
  get reloadRemoteDocs() {
    return reloadRemoteDocs;
  },
  get renderAdoBadge() {
    return renderAdoBadge;
  },
  get renderFolderBranch() {
    return renderFolderBranch;
  },
  get renderNow() {
    return renderNow;
  },
  get renderOutline() {
    return renderOutline;
  },
  get renderProjectName() {
    return renderProjectName;
  },
  get renderSaveState() {
    return renderSaveState;
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
  get repoImagesPlugin() {
    return repoImagesPlugin;
  },
  get reportError() {
    return reportError;
  },
  get rerenderIssue() {
    return rerenderIssue;
  },
  get resolveMergeConflict() {
    return resolveMergeConflict;
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
  get sendSelectionToAi() {
    return sendSelectionToAi;
  },
  get separator() {
    return separator;
  },
  get setBaseline() {
    return setBaseline;
  },
  get setKind() {
    return setKind;
  },
  get setOutline() {
    return setOutline;
  },
  get setPinned() {
    return setPinned;
  },
  get setRightOutline() {
    return setRightOutline;
  },
  get setTheme() {
    return setTheme;
  },
  get setView() {
    return setView;
  },
  get setWorkspace() {
    return setWorkspace;
  },
  get settings() {
    return settings;
  },
  get settingsDialog() {
    return settingsDialog;
  },
  get showAssignee() {
    return showAssignee;
  },
  get showIssue() {
    return showIssue;
  },
  get showPanel() {
    return showPanel;
  },
  get showWikiPage() {
    return showWikiPage;
  },
  get showWorkItem() {
    return showWorkItem;
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
  get sshDialog() {
    return sshDialog;
  },
  get startAiTool() {
    return startAiTool;
  },
  get stash() {
    return stash;
  },
  get status() {
    return status;
  },
  get switchBranch() {
    return switchBranch;
  },
  get symbolPicker() {
    return symbolPicker;
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
  get terminalAiReady() {
    return terminalAiReady;
  },
  get themePref() {
    return themePref;
  },
  get toggleOutline() {
    return toggleOutline;
  },
  get treeActive() {
    return treeActive;
  },
  set treeActive(v: typeof treeActive) {
    treeActive = v;
  },
  get updateActiveHeading() {
    return updateActiveHeading;
  },
  get updateLinksAfterRename() {
    return updateLinksAfterRename;
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
  get wideQuery() {
    return wideQuery;
  },
  get wikiImagesPlugin() {
    return wikiImagesPlugin;
  },
  get wikiLinkPicker() {
    return wikiLinkPicker;
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
  get wikiServerEtag() {
    return wikiServerEtag;
  },
  get withKeys() {
    return withKeys;
  },
  get workItemChipsPlugin() {
    return workItemChipsPlugin;
  },
  get workItemFilter() {
    return workItemFilter;
  },
  get workItemLinkPicker() {
    return workItemLinkPicker;
  },
  get workItemSeen() {
    return workItemSeen;
  },
  get workItemsPanel() {
    return workItemsPanel;
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

// ---- 文件裡的工作項目連結：旁邊顯示目前的狀態（即時預覽、預覽、Wiki 內容） ----------------

/** 讀過的狀態（五分鐘內不重新讀取；讀不到的記成 null）。 */
/** 工作項目相關的快取最多記幾筆（`setBounded`）。 */
const CACHE_MAX = 2000;
const chipCache = new Map<number, { item: AdoWorkItem | null; at: number }>();
const chipWanted = new Set<number>();
let chipTimer = 0;
const CHIP_TTL = 5 * 60_000;
const chipsChanged = StateEffect.define<null>();

/** 需要 `id` 的狀態：還沒讀過或太舊就排進下一次一起讀（打字停一下才送出）。 */
function wantChip(id: number): void {
  const hit = chipCache.get(id);
  if (hit && Date.now() - hit.at < CHIP_TTL) return;
  if (!desktop || !ado?.account) return;
  chipWanted.add(id);
  clearTimeout(chipTimer);
  chipTimer = window.setTimeout(() => void flushChips(), 300);
}

async function flushChips(): Promise<void> {
  const ids = [...chipWanted];
  chipWanted.clear();
  if (!ids.length) return;
  // 先記下時間，讀取期間不會重複排隊。
  for (const id of ids) setBounded(chipCache, id, { item: chipCache.get(id)?.item ?? null, at: Date.now() }, CACHE_MAX);
  try {
    const items = await desktop!.adoWorkItemsByIds(ids);
    for (const id of ids) setBounded(chipCache, id, { item: items.find((w) => w.id === id) ?? null, at: Date.now() }, CACHE_MAX);
  } catch {
    // 連不到伺服器：留著舊的狀態，五分鐘後再試。
  }
  editor.view.dispatch({ effects: chipsChanged.of(null) });
  for (const el of document.querySelectorAll<HTMLElement>(".wi-chip[data-wi]")) fillChip(el, Number(el.dataset.wi));
}

function fillChip(el: HTMLElement, id: number): void {
  const item = chipCache.get(id)?.item;
  el.hidden = !item;
  if (!item) return;
  el.textContent = item.state;
  el.dataset.tone = stateTone(item.state);
  el.title = t("{label}：{title}・{state}", { label: `${item.kind} ${item.id}`, title: item.title, state: item.state });
}

function chipElement(id: number): HTMLElement {
  const el = document.createElement("span");
  el.className = "wi-chip";
  el.dataset.wi = String(id);
  fillChip(el, id);
  wantChip(id);
  return el;
}

class ChipWidget extends WidgetType {
  constructor(readonly id: number) {
    super();
  }
  eq(other: ChipWidget): boolean {
    return other.id === this.id;
  }
  toDOM(): HTMLElement {
    return chipElement(this.id);
  }
}

/** 即時預覽：看得到的行裡，連到工作項目的連結後面加上狀態標籤。 */
function chipDecorations(view: EditorView): DecorationSet {
  const base = ado?.account?.url;
  if (!desktop || !base) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      for (const link of linksInLine(line.text)) {
        const target = parseRemoteLink(link.url, base);
        if (target?.kind === "workitem") {
          builder.add(line.from + link.end, line.from + link.end, Decoration.widget({ widget: new ChipWidget(target.id), side: 1 }));
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const workItemChips = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = chipDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(chipsChanged)))) {
        this.decorations = chipDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** 預覽、Wiki 內容：連到工作項目的連結後面加上狀態標籤。 */
const workItemChipsPlugin: PreviewPlugin = {
  name: "workitem-chips",
  apply(_root, scope) {
    const base = ado?.account?.url;
    if (!desktop || !base) return;
    for (const a of scope.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (a.nextElementSibling?.classList.contains("wi-chip")) continue;
      const target = parseRemoteLink(a.getAttribute("href") ?? "", base);
      if (target?.kind === "workitem") a.after(chipElement(target.id));
    }
  },
  // 匯出的文件不帶狀態標籤（狀態會變，別人看的時候已經不準了）。
  exportTransform(root) {
    for (const chip of root.querySelectorAll(".wi-chip")) chip.remove();
  },
};

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
        localImagesPlugin(() => (fileHandle?.path ? dirname(fileHandle.path) : null), desktop.fileUrl, (p) => davImageCached(p)),
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
  const dir = fileHandle?.path ? dirname(fileHandle.path) : null;
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
  live: [workItemChips, livePreview({
    imageUrl(src) {
      if (/^https?:/i.test(src)) return blockRemote() ? null : src;
      if (/^data:image\//i.test(src)) return src;
      if (active.wiki) return wikiEditImage(active.wiki, src);
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
    review.extension,
    EditorView.updateListener.of((u) => onSimplifiedPaste(u)),
    autoSymbols(() => kind !== "json" && settings.value.autoSymbols),
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
        remotePages: () => wikiLinkPages(1000),
      },
      [
        (ctx) => (kind === "json" ? null : dateCompletion(ctx)),
        (ctx) => (kind === "markdown" ? workItemIdCompletion(ctx) : null),
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
  const html = isHtmlName(fileName) && !full;
  const result = preview.update(text, kind, html || (!full && !previewVisible()));
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
  // 不用 trim()：大文件每次都會複製一份字串。
  const empty = !/\S/.test(text);
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
/** 大綱的結構（範圍、能否搬移、各標題的層級）；一樣時只更新項目的文字與行號。 */
let outlineShape = "";
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
  const levels = headings.map((h) => h.level);
  // 標題的數量與層級都沒變（例如正在改某個標題的文字、在上面加了一行）：只更新原本的項目，
  // 不重建整份大綱（重建後要重新標示目前的段落、捲到它的位置，大文件每個字都要重新排版）。
  const shape = `${scope}\n${movable}\n${levels.join(",")}`;
  if (shape === outlineShape && outlineList.childElementCount === headings.length) {
    const links = outlineList.querySelectorAll<HTMLAnchorElement>("a");
    headings.forEach((h, i) => {
      const a = links[i];
      if (a.dataset.id !== h.id) {
        a.href = `#${encodeURIComponent(h.id)}`;
        a.dataset.id = h.id;
      }
      if (a.dataset.line !== String(h.line)) a.dataset.line = String(h.line);
      const label = h.text || t("（空白標題）");
      if (a.textContent !== label) a.textContent = label;
    });
    return;
  }
  outlineShape = shape;
  // 重新產生大綱時保留鍵盤焦點（例如用 Alt+↑／↓ 連續搬移章節）。
  const focused = document.activeElement as HTMLElement | null;
  const focusedIndex = focused && outlineList.contains(focused) ? Number(focused.dataset.index) : -1;
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


let outlineHeadings: Heading[] = [];
initOutline();

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
  draftSaved = false;
  // 記下是哪個分頁的內容：計時器觸發前可能已經切換到別的分頁。
  pendingDraft = { id: active.id, doc };
  saveTimer = window.setTimeout(flushDraft, draftDelay(doc.length));
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
    // 自動存檔：只更新這個檔案的 Git 狀態，不重新掃描整個資料夾。
    if (out.handle?.path) void gitPanel?.fileSaved(out.handle.path);
    else gitPanel?.refreshSoon(300);
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

export type SidePanel = "files" | "outline" | "search" | "tasks" | "tags" | "issues" | "ado" | "git";
const SIDE_PANELS: SidePanel[] = ["files", "outline", "search", "tasks", "tags", "issues", "ado", "git"];
const sideTabs = [...document.querySelectorAll<HTMLButtonElement>(".activity-tabs [role=tab]")];
/** 舊版的「工作項目」「Wiki」是兩個面板，現在合成「Azure DevOps」一個面板（裡面再切換）。 */
const LEGACY_ADO_PANELS = ["workitems", "wiki"];
const savedSidePanel = storage.load("side-panel");
let sidePanel: SidePanel =
  SIDE_PANELS.find((p) => p === (LEGACY_ADO_PANELS.includes(savedSidePanel ?? "") ? "ado" : savedSidePanel)) ?? "outline";
/** Azure DevOps 面板目前顯示工作項目還是 Wiki。 */
export type AdoTab = "workitems" | "wiki";
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
      remotes: () => (features.remote ? desktop!.davConnections() : Promise.resolve([])),
      openRemote: (c) => void openRemote(c).catch(reportError),
      changed: () => void renderProjectName().then(renderFilesEmpty),
      unsaved: (path) =>
        (peekSession(path)?.docs ?? []).some((m) => m.baseline !== null && draftState(m).dirty),
      repoSources: () => [
        ...(github ? [{ id: "github", title: t("從 GitHub 下載儲存庫…"), icon: "github", run: () => void github.openRepo() }] : []),
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
        if (sidePanel === "ado") showPanel("ado", false);
        settingsDialog.refresh();
        void gitPanel?.refresh();
      },
      openSettings: () => settingsDialog.open(t("Azure DevOps／TFS")),
    })
  : null;

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

// ---- 狀態列：開著 Wiki、工作項目、Git 歷史時，顯示正在看什麼，藏起只跟本機文件有關的項目 ----

const statusView = $("#status-view");
const issuePane = $(".issue-pane:not(.history-pane)");
/** 頂端列的分頁區（側邊欄右邊到視窗右緣）至少這麼寬，標頭才搬到頂端列。 */
const HEAD_IN_TOPBAR_MIN = 760;
/** 正在看的工作項目等內容的摘要（狀態、留言數…），顯示在狀態列右邊。 */
let issueFacts: IssueFact[] = [];

function setIssueFacts(list: IssueFact[]): void {
  issueFacts = list;
  renderStatusView();
}

function renderStatusView(): void {
  // 並排顯示時編輯區還在，狀態列照常顯示文件的資訊。
  const issueOpen = workspace.classList.contains("issue-open") && !workspace.classList.contains("issue-side");
  const historyOpen = workspace.classList.contains("history-open");
  const viewing = issueOpen || historyOpen;
  $(".statusbar").classList.toggle("viewing", viewing);
  statusView.hidden = !viewing;
  // 開著工作項目等內容時，標頭（位置、標題、動作）放在頂端列，省下一整列。並排顯示時也一樣，
  // 切換並排時按鈕才不會跳到別的地方；頂端列太窄（放不下標題與按鈕）時才放回內容上方。
  const topbar = $(".topbar");
  const room = topbar.getBoundingClientRect().right - $("#tab-bar").getBoundingClientRect().left;
  const headUp =
    workspace.classList.contains("issue-open") && !historyOpen && !workspace.classList.contains("narrow") && room >= HEAD_IN_TOPBAR_MIN;
  topbar.classList.toggle("has-issue-head", headUp);
  issueView?.placeHead(headUp ? $(".topbar .top-actions") : null);
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
    source === "git" ? names.git : t("{name}・唯讀", { name: names[source] ?? issuePane.dataset.sourceName ?? "" }),
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
  const facts = document.createElement("span");
  facts.className = "status-facts";
  if (issueOpen && !historyOpen) {
    for (const f of issueFacts) {
      const item = document.createElement("span");
      if (f.dot) {
        const dot = document.createElement("span");
        dot.className = `ado-state-dot ${f.dot}`;
        dot.setAttribute("aria-hidden", "true");
        item.append(dot);
      }
      item.append(f.text);
      if (f.title) item.title = f.title;
      facts.append(item);
    }
  }
  statusView.replaceChildren(label, back, facts);
}
new MutationObserver(renderStatusView).observe(workspace, { attributes: true, attributeFilter: ["class"] });
// 視窗或側邊欄寬度改變時，重新決定標頭放在頂端列還是內容上方。
new ResizeObserver(() => {
  if (workspace.classList.contains("issue-open")) renderStatusView();
}).observe(issuePane);
issueView.setSide(issueSide);
// 並排顯示時，檢視打開或關閉要重新排版（編輯區讓出右半邊）。
let issueWasOpen = false;
new MutationObserver(() => {
  const open = workspace.classList.contains("issue-open");
  if (open === issueWasOpen) return;
  issueWasOpen = open;
  if (issueSide) applyLayout();
}).observe(workspace, { attributes: true, attributeFilter: ["class"] });
new MutationObserver(renderStatusView).observe(issuePane, { attributes: true, attributeFilter: ["data-source", "data-source-name"] });

/** 工作項目的篩選條件（記住上次的選擇）。 */
const DEFAULT_WORK_ITEM_FILTER: AdoWorkItemFilter = {
  role: "assigned",
  person: "@me",
  state: "open",
  kinds: [],
  projects: [],
  areas: [],
};
const workItemFilter: AdoWorkItemFilter = (() => {
  try {
    // 舊版存的是單一的 kind、project、area。
    const v = JSON.parse(storage.load("workitem-filter") ?? "{}") as Partial<AdoWorkItemFilter> & Record<"kind" | "project" | "area", unknown>;
    const projects = choiceList(v.projects ?? v.project);
    return {
      role: v.role === "created" ? "created" : "assigned",
      person: typeof v.person === "string" ? v.person : "@me",
      state: v.state === "closed" || v.state === "all" ? v.state : "open",
      kinds: choiceList(v.kinds ?? v.kind),
      projects,
      areas: projects.length ? choiceList(v.areas ?? v.area) : [],
    };
  } catch {
    return { ...DEFAULT_WORK_ITEM_FILTER };
  }
})();
const isDefaultFilter = () =>
  workItemFilter.role === "assigned" &&
  workItemFilter.person === "@me" &&
  workItemFilter.state === "open" &&
  !workItemFilter.kinds.length &&
  !workItemFilter.projects.length &&
  !workItemFilter.areas.length;
/** 清單上要不要顯示指派給誰（只看自己的就不必）。 */
const showAssignee = () => !(workItemFilter.role === "assigned" && workItemFilter.person === "@me");

/** 讀取篩選列的選項（第一次列出工作項目時）。 */
let loadWorkItemFilterOptions = (): void => {};

initWorkItemsPanel();
initAdoStatus();

/** 最近一次「指派給你、還沒結束」的清單（背景檢查或面板的預設清單）。 */
let pollItems: AdoWorkItem[] = [];
initWorkItemUpdates();

/** 上次的 Git 狀態摘要（變了才重新載入歷史）。 */
let gitHistoryKey = "";
initGitHistory();

initWorkspaceUi();

// ---- 快速開啟（Ctrl+P） --------------------------------------------------

interface QuickItem {
  title: string;
  detail: string;
  doc?: Doc;
  path?: string;
  /** 工作項目、Wiki 頁面：選了之後在主要區域開啟。 */
  remote?: { icon: string; open(): void };
}

let quickRemoteSeq = 0;

/**
 * Ctrl+P 裡的工作項目與 Wiki 頁面（連上 Azure DevOps 時）：
 * `#123` 直接開啟那個工作項目，`#文字` 搜尋工作項目的標題；其他字找目前 Wiki 的頁面名稱。
 */
async function quickRemoteItems(q: string): Promise<QuickItem[]> {
  const text = q.trim();
  if (!desktop || !ado?.account || !text) return [];
  if (text.startsWith("#")) {
    const rest = text.slice(1).trim();
    if (/^\d+$/.test(rest)) {
      const id = Number(rest);
      return [
        {
          title: `#${id}`,
          detail: t("開啟 Azure DevOps 工作項目"),
          remote: { icon: "square-kanban", open: () => void openWorkItemById(id) },
        },
      ];
    }
    if (rest.length < 2) return [];
    // 打字停一下才查詢，免得每個字都向伺服器查一次。
    const seq = ++quickRemoteSeq;
    await new Promise((r) => setTimeout(r, 300));
    if (seq !== quickRemoteSeq) return [];
    const found = await desktop
      .adoWorkItems(rest, { ...DEFAULT_WORK_ITEM_FILTER, person: "", state: "all" })
      .catch(() => [] as AdoWorkItem[]);
    return found.slice(0, 30).map((w) => ({
      title: w.title,
      detail: [`${w.kind} ${w.id}`, w.state].join("・"),
      remote: { icon: "square-kanban", open: () => showWorkItem(w) },
    }));
  }
  // Wiki 頁面清單在背景讀取：還沒讀到（或網路慢）時先只列檔案，不讓 Ctrl+P 卡住。
  if (!wikiListCache) {
    wikiListCache = desktop.adoWikis();
    wikiListCache.catch(() => (wikiListCache = null));
  }
  const wikis = await soon(wikiListCache);
  const id = wikiPanel?.wiki?.id ?? storage.load("ado-wiki");
  const wiki = wikis?.find((w) => w.id === id) ?? wikis?.[0];
  if (!wiki) return [];
  let pages = wikiPagesCache.get(wiki.id);
  if (!pages) {
    pages = desktop.adoWikiPages(wiki);
    wikiPagesCache.set(wiki.id, pages);
    pages.catch(() => wikiPagesCache.delete(wiki.id));
  }
  const paths = flattenPages((await soon(pages)) ?? []);
  return paths.map((path) => ({
    title: pageName(path),
    detail: t("Wiki・{where}", { where: [wiki.name, path.slice(1, path.lastIndexOf("/"))].filter(Boolean).join(" › ") }),
    remote: { icon: "book-open-text", open: () => showWikiPage(wiki, path) },
  }));
}

/** 連結用的 Wiki 頁面：編輯 Wiki 頁面時是那個 Wiki，否則是 Wiki 面板選的那個。等不到 `wait` 毫秒就先不列。 */
async function wikiLinkPages(wait = 150): Promise<RemotePage[]> {
  if (!desktop || !ado?.account) return [];
  if (!wikiListCache) {
    wikiListCache = desktop.adoWikis();
    wikiListCache.catch(() => (wikiListCache = null));
  }
  const wikis = await soon(wikiListCache, wait);
  const target = active.wiki;
  const id = target?.wikiId ?? wikiPanel?.wiki?.id ?? storage.load("ado-wiki");
  const wiki = wikis?.find((w) => w.id === id) ?? wikis?.[0];
  if (!wiki) return [];
  let pages = wikiPagesCache.get(wiki.id);
  if (!pages) {
    pages = desktop.adoWikiPages(wiki);
    wikiPagesCache.set(wiki.id, pages);
    pages.catch(() => wikiPagesCache.delete(wiki.id));
  }
  const paths = flattenPages((await soon(pages, wait)) ?? []);
  // 在同一個 Wiki 裡用 Wiki 的相對連結（`/上層/頁面`），TFS 網頁版也點得到；其他文件用網頁網址。
  const sameWiki = target?.wikiId === wiki.id;
  return paths.flatMap((path) => {
    const name = pageName(path);
    const where = [wiki.name, path.slice(1, path.lastIndexOf("/"))].filter(Boolean).join(" › ");
    if (sameWiki) return [{ label: name, detail: t("Wiki・{where}", { where }), link: `[${name.replace(/[[\]]/g, "")}](${encodeLinkPath(path)})` }];
    if (!wiki.webUrl) return [];
    return [{ label: name, detail: t("Wiki・{where}", { where }), link: wikiPageLink(name, wikiPageUrl(wiki.webUrl, path)) }];
  });
}

/** 文件裡打 `#123`（編號）時列出符合的工作項目，選了就換成 `[#123 標題](網址)`。 */
async function workItemIdCompletion(ctx: CompletionContext): Promise<CompletionResult | null> {
  if (!desktop || !ado?.account) return null;
  const m = ctx.matchBefore(/(?<=^|[\s(（「、，,:：])#\d{1,9}$/);
  if (!m) return null;
  // 打字停一下才查詢。
  await new Promise((r) => setTimeout(r, 250));
  if (ctx.aborted) return null;
  const found = await desktop
    .adoWorkItems(m.text.slice(1), { ...DEFAULT_WORK_ITEM_FILTER, person: "", state: "all" })
    .catch(() => [] as AdoWorkItem[]);
  if (ctx.aborted || !found.length) return null;
  return {
    from: m.from,
    filter: false,
    options: found.slice(0, 20).map((w) => ({
      label: `#${w.id} ${w.title}`,
      detail: `${w.kind}・${w.state}`,
      type: "class",
      apply: workItemLink(w),
    })),
  };
}

/** 插入工作項目連結：輸入標題關鍵字或編號搜尋（空白時列出指派給我的）。 */
let workItemLinkSeq = 0;
const workItemLinkPicker = new Picker<AdoWorkItem>({
  label: t("插入工作項目連結"),
  placeholder: t("輸入標題關鍵字或編號"),
  empty: t("找不到符合的工作項目"),
  async query(q) {
    if (!desktop) return [];
    const seq = ++workItemLinkSeq;
    await new Promise((r) => setTimeout(r, 250));
    if (seq !== workItemLinkSeq) return [];
    const text = q.trim().replace(/^#/, "");
    const filter = text ? { ...DEFAULT_WORK_ITEM_FILTER, person: "", state: "all" as const } : DEFAULT_WORK_ITEM_FILTER;
    return (await desktop.adoWorkItems(text, filter)).slice(0, 50);
  },
  render: (w) => ({ title: w.title, detail: [`${w.kind} ${w.id}`, w.state].join("・"), icon: "square-kanban" }),
  pick: (w) => insertIssueLink(w),
});

/** 插入 Wiki 頁面連結。 */
const wikiLinkPicker = new Picker<RemotePage>({
  label: t("插入 Wiki 頁面連結"),
  placeholder: t("輸入頁面名稱"),
  empty: t("找不到符合的 Wiki 頁面"),
  async query(q) {
    const needle = q.trim().toLowerCase();
    const pages = await wikiLinkPages(3000);
    return needle ? pages.filter((p) => `${p.label} ${p.detail}`.toLowerCase().includes(needle)) : pages;
  },
  render: (p) => ({ title: p.label, detail: p.detail, icon: "book-open-text" }),
  pick: (p) => insertAtCursor(p.link),
});

/** `p` 在一小段時間內有結果就回傳結果，否則（或失敗時）回傳 null。 */
function soon<T>(p: Promise<T>, ms = 150): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** 依編號開啟工作項目（讀不到時提示）。 */
async function openWorkItemById(id: number): Promise<void> {
  try {
    showWorkItem(await peekWorkItem(id));
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

const quickOpen = new Picker<QuickItem>({
  label: t("快速開啟"),
  placeholder: desktop ? t("輸入檔名、Wiki 頁面，或 #編號 開啟工作項目") : t("輸入檔名切換分頁"),
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
    const remote = await quickRemoteItems(q);
    // `#…` 只找工作項目（伺服器已經依相關程度排序）。
    if (q.trim().startsWith("#")) return remote;
    items.push(...remote);
    return items
      .map((it) => ({ it, score: Math.max(fuzzyScore(q, it.title) * 2, fuzzyScore(q, `${it.detail}/${it.title}`)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 200)
      .map((x) => x.it);
  },
  render: (it) => ({ title: it.title, detail: it.detail, icon: it.remote?.icon ?? (it.doc ? "file-text" : "file") }),
  pick: (it) => (it.remote ? it.remote.open() : it.doc ? activate(it.doc) : void openPath(it.path!).catch(reportError)),
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
      docs: docs.map(({ id, name, kind, path, baseline, fileBacked, pinned, wiki }) => ({ id, name, kind, path, baseline, fileBacked, pinned, wiki })),
    },
    tabScope,
  );
}

function renderTabs(): void {
  tabBar.render(
    docs.map((d) => ({
      id: d.id,
      name: d === active ? fileName : d.name,
      title: d.wiki
        ? t("Azure DevOps Wiki：{wiki}{path}（按 Ctrl+S 存回伺服器）", { wiki: d.wiki.wikiName, path: d.wiki.path })
        : (((p) => (p ? displayPath(p) : null))(d === active ? fileHandle?.path : d.path) ?? (d === active ? fileName : d.name)),
      source: d.wiki ? ("wiki" as const) : undefined,
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
  const closedPath = docPath(doc);
  const i = docs.indexOf(doc);
  docs.splice(i, 1);
  // 遠端（WebDAV、SSH）的檔案：沒有其他分頁開著同一個檔案時，原生端不用再輪詢它、留著它的內容。
  if (desktop && closedPath && isRemote(closedPath) && !docs.some((d) => docPath(d) === closedPath)) {
    void desktop.davClose(closedPath).catch(() => {});
  }
  dropDraft(doc.id);
  remoteAllowed.delete(doc.id);
  outlineCollapsed.delete(doc.id);
  changeNoticeAt.delete(doc.id);
  wikiNewer.delete(doc.id);
  wikiCheckedAt.delete(doc.id);
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
  // 編輯中的 Wiki 頁面：存回伺服器（另存新檔則照常存成本機檔案）。
  if (active.wiki && !saveAs && desktop) return saveWikiPage(text, force);
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
  // 另存成本機檔案之後，這個分頁就是那個檔案，不再對應 Wiki 頁面。
  if (out.handle) active.wiki = undefined;
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

initOfflineDrive();

initCommands();
initAiTerminal();

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

initGitActions();

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
// 工作項目等內容的標頭在頂端列時，它的「更多動作」併到主選單最上面（頂端列只留一個「⋯」）。
const issueMoreInMenu = () => $(".topbar").classList.contains("has-issue-head");
setupMenu($<HTMLButtonElement>("#main-menu"), commands, [
  ...issueView.moreEntries.map((e): MenuEntry => {
    if (typeof e === "string" || "items" in e) return e;
    return { ...e, when: () => issueMoreInMenu() && (e.when?.() ?? true) };
  }),
  "-",
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

initActivityBar();
initNewWorkItem();

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

initSettingsUi();
initFileDrop();

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
