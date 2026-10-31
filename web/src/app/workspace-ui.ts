/**
 * 資料夾：開啟、切換專案、遠端資料夾（WebDAV、SSH），以及資料夾文件索引（待辦總覽、標籤、反向連結）。
 */
import { parseDoc } from "../../pkg/md_wasm.js";
import { formatKeys } from "../commands.ts";
import { desktop, isRemote, displayPath, remoteId, type DavConnection, remoteRoot, type Folder, type Entry } from "../desktop.ts";
import { setTaskLine, setTaskDone, plainTaskText } from "../doc-index.ts";
import { fromDesktop, desktopHandle } from "../files.ts";
import { t } from "../i18n.ts";
import { backlinks } from "../links.ts";
import { dirname, rebase, basename, isInside } from "../paths.ts";
import { projectSections, samePath } from "../projects.ts";
import { draftVersion, loadDraft, loadProjectView, dropDraft, loadSession } from "../session.ts";
import * as storage from "../storage.ts";
import { choose } from "../ui/choice.ts";
import type { TreeAction } from "../ui/filetree.ts";
import { icon } from "../ui/icons.ts";
import { SshDialog, confirmHostKey } from "../ui/ssh-dialog.ts";
import { TagsPanel } from "../ui/tags-panel.ts";
import { TasksPanel } from "../ui/tasks-panel.ts";
import { toast } from "../ui/toast.ts";
import { WebDavDialog } from "../ui/webdav-dialog.ts";
import { WorkspaceIndex, type OpenDoc, type IndexedDoc } from "../workspace-index.ts";
import { refreshActivityCommands } from "./activity-bar.ts";
import { commands } from "./commands.ts";
import { reportError } from "./git-actions.ts";
import { searchPanel } from "./git-history.ts";
import { gitPanel } from "./work-item-updates.ts";
import { wikiPanel, workItemsPanel, issuesPanel, renderIssuesTab } from "./work-items-panel.ts";
import type { Doc, SidePanel } from "../main.ts";
import { app } from "./context.ts";


// 從其他程式切回來時，資料夾中的檔案可能改過了（其他程式直接改寫檔案時不一定有變動通知）。
// 重新掃描整個資料夾在網路磁碟上很慢，一分鐘內最多一次。
let indexScannedAt = 0;

/** 文件中的待辦、標籤與連結（截止日沒寫年份就是今年）。 */
const docInfo = (text: string) => parseDoc(text, new Date().getFullYear());

const docIndex = new WorkspaceIndex(
  (known, root) => desktop!.scanDocs(known, root),
  (paths) => desktop!.readDocs(paths),
  docInfo,
);

/** 已開啟的 Markdown 分頁（以編輯器中的內容為準）。 */
function openDocsForIndex(): OpenDoc[] {
  return app.docs
    .filter((d) => (d === app.active ? app.kind : d.kind) === "markdown")
    .map((d) => {
      // 內容的版本：CodeMirror 的文件物件（內容不變時是同一個），還沒載入的分頁看草稿寫過幾次。
      // 版本沒變就不必取出整份文字、也不必讀草稿（每次編輯後都會重新整理面板）。
      const doc = d === app.active ? app.editor.view.state.doc : d.state?.doc;
      return {
        id: d.id,
        path: app.docPath(d),
        name: d === app.active ? app.fileName : d.name,
        version: doc ?? `draft:${draftVersion(d.id)}`,
        text: () => (doc ? doc.toString() : (loadDraft(d.id) ?? "")),
      };
    });
}

/** 資料夾（本機）中的所有文件加上已開啟的分頁；網頁版與遠端資料夾只有已開啟的分頁。 */
async function indexedDocs(): Promise<IndexedDoc[]> {
  const root = desktop && app.workspaceRoot && !isRemote(app.workspaceRoot.path) ? app.workspaceRoot.path : null;
  if (app.indexStale || !root) {
    app.indexStale = false;
    indexScannedAt = Date.now();
    await docIndex.refresh(root).catch((e) => {
      app.indexStale = true;
      throw e;
    });
  }
  return docIndex.docs(openDocsForIndex());
}

function indexScope(): string {
  if (desktop && app.workspaceRoot && !isRemote(app.workspaceRoot.path)) return "folder";
  return "tabs";
}

// 在 init 時建立。
let tasksPanel: TasksPanel;

// 在 init 時建立。
let tagsPanel: TagsPanel;

/** 列出有這個標籤的文件。 */
export function openTag(tag: string): void {
  showPanel("tags");
  void tagsPanel.select(tag);
}

let backlinksSeq = 0;
/** 大綱面板下方的反向連結：哪些文件連到目前的文件。 */
async function renderBacklinks(): Promise<void> {
  const el = app.$("#backlinks");
  const path = app.fileHandle?.path;
  const seq = ++backlinksSeq;
  if (!path || app.kind !== "markdown" || indexScope() !== "folder") {
    el.hidden = true;
    return;
  }
  const docsNow = await indexedDocs().catch(() => null);
  if (!docsNow || seq !== backlinksSeq) return;
  app.fileListCache ??= await desktop!.listFiles(app.workspaceRoot!.path).catch(() => []);
  const list = backlinks(path, docsNow, app.markdownFiles(app.fileListCache));
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
  return (doc.tabId ? app.docs.find((d) => d.id === doc.tabId) : undefined) ?? (doc.path ? app.tabForPath(doc.path) : undefined);
}

/** 打開索引中的文件並跳到某一行。 */
function openIndexed(doc: IndexedDoc, line: number): void {
  const tab = tabOfIndexed(doc);
  if (tab) {
    if (tab !== app.active) app.activate(tab);
    app.editor.reveal(line);
  } else if (doc.path) void openPath(doc.path, line).catch(reportError);
}

let indexPanelsTimer = 0;
/** 待辦、標籤、反向連結面板顯示中時重新整理（編輯中延遲一下）。 */
/** 打字後只更新待辦與標籤（`backlinks: false`）：反向連結是「其他文件連到這份」，打字不會改變它。 */
let indexBacklinks = false;
export function refreshIndexPanels(delay = 0, { backlinks = true } = {}): void {
  clearTimeout(indexPanelsTimer);
  // 排隊中的更新有要求反向連結的話，合併後仍然要更新。
  indexBacklinks ||= backlinks;
  indexPanelsTimer = window.setTimeout(() => {
    const withBacklinks = indexBacklinks;
    indexBacklinks = false;
    if (!app.outlineShown) return;
    if (app.sidePanel === "tasks") void tasksPanel.refresh();
    if (app.sidePanel === "tags") void tagsPanel.refresh();
    if (withBacklinks && (app.sidePanel === "outline" || outlineOnRight())) void renderBacklinks();
  }, delay);
}

/** 視窗夠寬時，大綱可以固定放在內文右邊（設定「大綱放在右邊」）。 */
export const wideQuery = matchMedia("(min-width: 1100px)");
export function outlinePlacedRight(): boolean {
  return app.settings.value.outlineRight && wideQuery.matches && !app.narrowQuery.matches;
}
/** 大綱在右邊、而且沒有收起來。 */
export function outlineOnRight(): boolean {
  return outlinePlacedRight() && app.rightOutlineShown;
}

/** 使用者要把 Wiki 面板放在右側（和左邊的面板同時開著）。 */
export let wikiRightWanted = storage.load("wiki-right") === "1";
/** Wiki 面板真的在右側：視窗夠寬、連線到 Azure DevOps 時才放（否則留在左邊）。 */
export function wikiPlacedRight(): boolean {
  return wikiRightWanted && !!app.ado?.account && wideQuery.matches && !app.narrowQuery.matches;
}
/** 右側欄有東西（大綱或 Wiki）而且沒有收起來。 */
export function rightColumnOn(): boolean {
  return (outlinePlacedRight() || wikiPlacedRight()) && app.rightOutlineShown;
}

/** 把 Wiki 面板移到右側或移回左邊。 */
export function setWikiRight(on: boolean): void {
  wikiRightWanted = on;
  storage.save("wiki-right", on ? "1" : "");
  if (on && !app.rightOutlineShown) setRightOutline(true);
  else app.applyLayout();
  if (on && !wikiPlacedRight()) toast(t("視窗寬一點時 Wiki 才會放在右側（現在先留在左邊）。"));
  if (!on) showPanel("wiki");
}

export function setRightOutline(shown: boolean): void {
  app.rightOutlineShown = shown;
  storage.save("outline-right", shown ? "shown" : "hidden");
  app.applyLayout();
  if (shown) {
    void renderBacklinks();
    app.updateActiveHeading();
  }
}

/** 依設定把大綱面板移到右邊或放回左邊的側邊欄。 */
export function placeOutline(): void {
  const panel = app.$("#panel-outline");
  const right = app.$("#outline-right");
  const onRight = outlinePlacedRight();
  const outlineTab = app.$<HTMLButtonElement>("#side-tab-outline");
  if (onRight && panel.parentElement !== right) {
    // 右側欄裡大綱放上面（Wiki 也在右側時排在下面）。
    right.prepend(panel);
    panel.hidden = false;
    outlineTab.hidden = true;
    if (app.sidePanel === "outline") showPanel("files", false);
    void renderBacklinks();
    app.updateActiveHeading();
  } else if (!onRight && panel.parentElement === right) {
    app.$("#panel-files").after(panel);
    outlineTab.hidden = false;
    panel.hidden = app.sidePanel !== "outline";
  }
  placeWiki(right);
  right.hidden = !rightColumnOn();
}

/** 依設定把 Wiki 面板移到右側欄或放回左邊的側邊欄。 */
function placeWiki(right: HTMLElement): void {
  const panel = app.$("#panel-wiki");
  const tab = app.$("#side-tab-wiki");
  const onRight = wikiPlacedRight();
  if (onRight && panel.parentElement !== right) {
    right.append(panel);
    panel.hidden = false;
    // 圖示列的 Wiki 圖示先藏起來（不用 hidden：連線狀態也用它）。
    tab.classList.add("placed-right");
    if (app.sidePanel === "wiki") showPanel("workitems", false);
    if (app.rightOutlineShown) wikiPanel?.shown();
  } else if (!onRight && panel.parentElement === right) {
    app.$("#panel-workitems").after(panel);
    tab.classList.remove("placed-right");
    panel.hidden = app.sidePanel !== "wiki";
  }
  const dock = document.getElementById("wiki-dock");
  if (dock) {
    const label = onRight ? t("移回左邊的側邊欄") : t("移到右側（和左邊的面板同時開著）");
    dock.title = label;
    dock.setAttribute("aria-label", label);
    dock.replaceChildren(icon(onRight ? "panel-left" : "panel-right"));
    dock.hidden = !onRight && !wideQuery.matches;
  }
}

/**
 * 要開的面板圖示還沒出現（Azure DevOps、GitHub 要等連線讀到，Git 要等狀態讀到）時先顯示檔案，
 * 記在這裡；圖示出現後再切回來（例如上次關閉時開著 Azure DevOps，下次啟動仍然回到它）。
 */
export let pendingPanel: SidePanel | null = null;

/** 面板的圖示不能用了（例如中斷連線）：先換到檔案，圖示再出現時切回來。 */
export function panelUnavailable(panel: SidePanel): void {
  // 圖示已經藏起來，showPanel 會改開檔案並記住原本要的面板。
  if (app.sidePanel === panel) showPanel(panel, false);
}

/** 面板的圖示出現了：剛才因為還不能用而沒開成，現在切過去。 */
export function panelAvailable(panel: SidePanel): void {
  if (pendingPanel === panel) showPanel(panel, false);
}

export function showPanel(panel: SidePanel, reveal = true): void {
  const requested = panel;
  if (panel === "git" && app.$("#side-tab-git").hidden) panel = "files";
  if ((panel === "workitems" || panel === "wiki") && app.$(`#side-tab-${panel}`).hidden) panel = "files";
  if (panel === "issues" && app.$("#side-tab-issues").hidden) panel = "files";
  // 不能用而改開檔案時不記住（下次啟動仍然開原本要的面板）。
  pendingPanel = panel === requested ? null : requested;
  // 大綱在右邊時一直顯示，不用切換左邊的側邊欄。
  if (panel === "outline" && outlinePlacedRight()) {
    if (!app.rightOutlineShown) setRightOutline(true);
    else app.updateActiveHeading();
    return;
  }
  // Wiki 在右側時一直顯示（右側欄收起來時打開），不用切換左邊的側邊欄。
  if (panel === "wiki" && wikiPlacedRight()) {
    if (!app.rightOutlineShown) setRightOutline(true);
    wikiPanel?.shown();
    return;
  }
  app.sidePanel = panel;
  if (!pendingPanel) storage.save("side-panel", panel);
  for (const tab of app.sideTabs) {
    const on = tab.dataset.panel === panel;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    if (tab.dataset.panel === "outline" && outlinePlacedRight()) continue;
    if (tab.dataset.panel === "wiki" && wikiPlacedRight()) continue;
    app.$(`#panel-${tab.dataset.panel}`).hidden = !on;
  }
  if (reveal && !app.outlineShown) app.setOutline(true);
  if (panel === "outline") app.updateActiveHeading();
  if (panel === "workitems") workItemsPanel?.shown();
  if (panel === "wiki") wikiPanel?.shown();
  if (panel === "issues") issuesPanel?.shown();
  if (panel === "search" && app.searchStale) {
    app.searchStale = false;
    searchPanel?.rerun();
  }
  refreshIndexPanels();
}

/** 沒有開啟資料夾時，檔案面板顯示說明、開啟按鈕與最近開啟的資料夾。 */
export async function renderFilesEmpty(): Promise<void> {
  const box = app.$("#files-empty");
  app.$("#files-head").hidden = !app.workspaceRoot;
  box.hidden = !!app.workspaceRoot;
  if (app.workspaceRoot) return;
  const p = document.createElement("p");
  if (!desktop) {
    p.textContent = t("開啟資料夾、管理檔案與搜尋整個資料夾需要桌面版（Windows，免安裝）。");
    const a = Object.assign(document.createElement("a"), {
      className: "btn",
      href: app.DOWNLOAD_URL,
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
  for (const source of app.projectUi!.repoSources()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.append(icon(source.icon), source.title.replace(/…$/, ""));
    b.addEventListener("click", () => source.run());
    actions.append(b);
  }
  if (app.features.remote) actions.append(remote, ssh);
  box.replaceChildren(p, actions);
  const [projects, conns] = await Promise.all([
    app.projectUi!.refresh(),
    app.features.remote ? desktop.davConnections().catch(() => []) : [],
  ]);
  const folders = projectSections(projects).flatMap((s) => s.items).slice(0, 10);
  if ((!folders.length && !conns.length) || app.workspaceRoot) return;
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

export const davDialog = desktop ? new WebDavDialog(desktop) : null;
export const sshDialog = desktop ? new SshDialog(desktop) : null;

/** 原生端在遠端檔案的連線沒有連上時回傳的錯誤開頭。 */
export const NOT_CONNECTED = [t("還沒有連線到遠端資料夾"), t("這個檔案屬於另一個遠端連線")];

/** 遠端檔案所屬的連線目前沒有連上：提示重新連線（不自動跳出對話框打斷）。 */
export async function suggestReconnect(path: string, message: (name: string) => string, label = t("重新連線")): Promise<boolean> {
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
export async function openRemote(c: Pick<DavConnection, "id" | "kind" | "name" | "url" | "username">): Promise<void> {
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
  await app.reloadRemoteDocs(folder.path);
}

export async function setWorkspace(folder: Folder | null): Promise<void> {
  // 換到另一個專案：分頁也換成那個專案的（關掉資料夾時分頁留著）。
  if (folder && (app.tabScope === null || !samePath(app.tabScope, folder.path))) await switchTabs(folder.path);
  app.workspaceRoot = folder;
  refreshActivityCommands();
  app.fileListCache = null;
  if (folder) storage.save("workspace", folder.path);
  else storage.remove("workspace");
  await app.renderProjectName();
  await app.fileTree?.setRoot(folder?.path ?? null, folder?.name, folder ? loadProjectView(folder.path).expanded : []);
  app.treeActive = app.fileHandle?.path ?? null;
  await app.fileTree?.setActive(app.treeActive);
  await renderFilesEmpty();
  void gitPanel?.refresh();
  void renderIssuesTab();
}

/**
 * 換成另一個專案的分頁：先記下目前的分頁（沒存的內容留在草稿裡，切回來還在），
 * 再還原那個專案上次開著的分頁。從「沒有開啟資料夾」換過去時，開著的檔案和沒存的分頁一起帶過去。
 */
async function switchTabs(scope: string): Promise<void> {
  app.flushDraft();
  if (app.diskSaveTimer) await app.autoSaveNow();
  if (app.review.active) app.review.finish();
  app.persistSession();
  const carry = app.tabScope === null ? app.docs.filter((d) => d.dirty || d.fileBacked) : [];
  if (app.tabScope === null) {
    for (const d of app.docs) if (!carry.includes(d)) dropDraft(d.id);
    storage.remove("tabs");
  }
  app.tabScope = scope;
  storage.save("tab-scope", scope);
  const saved = loadSession(scope);
  const next = app.docsFrom(saved);
  const fresh = [...next];
  for (const d of carry) {
    const path = app.docPath(d);
    if (!next.some((n) => n.id === d.id || (path && n.path && samePath(n.path, path)))) next.push(d);
  }
  if (!next.length) next.push(app.makeDoc({ name: t("未命名.md"), kind: "markdown" }));
  const target = next.find((d) => d.id === saved?.activeId) ?? (next.includes(app.active) ? app.active : next[0]);
  app.docs = next;
  if (target === app.active) {
    app.persistSession();
    app.renderTabs();
  } else {
    app.activate(target);
  }
  // 分頁收起來的期間檔案可能被改過：重新讀一次（和啟動時一樣）。
  if (app.docsLoaded) void app.reloadDocs(fresh);
}

/**
 * 關閉目前的專案：分頁收起來（和切換專案一樣記住，沒存的內容留在草稿裡，下次開啟這個專案時還原），
 * 換成一個空白分頁，檔案樹回到「開啟資料夾」的畫面。
 */
export async function closeProject(): Promise<void> {
  const folder = app.workspaceRoot;
  if (!folder || !desktop) return;
  const name = app.projectUi?.current?.label ?? folder.name;
  app.flushDraft();
  if (app.diskSaveTimer) await app.autoSaveNow();
  if (app.review.active) app.review.finish();
  app.persistSession();
  await desktop.closeFolder();
  app.tabScope = null;
  storage.remove("tab-scope");
  storage.remove("tabs");
  const blank = app.makeDoc({ name: t("未命名.md"), kind: "markdown" });
  app.docs = [blank];
  app.activate(blank);
  app.persistSession();
  app.renderTabs();
  await setWorkspace(null);
  toast(t("已關閉「{name}」。分頁都記住了，下次開啟這個專案會還原", { name }));
}

export async function openRecentFolder(path: string): Promise<void> {
  try {
    await setWorkspace(await desktop!.reopenFolder(path));
    showPanel("files");
  } catch (e) {
    reportError(e);
    await renderFilesEmpty(); // 找不到的資料夾已從清單移除
  }
}

/** 開啟（或切換到）指定路徑的檔案，可再跳到指定的行與欄。 */
export async function openPath(path: string, line?: number, column?: number): Promise<void> {
  const existing = app.tabForPath(path);
  if (existing) app.activate(existing);
  else if (desktop) app.openOpenedFile(fromDesktop(await desktop.reopenFile(path)));
  if (line) {
    if (app.view === "preview") app.setView("split");
    app.editor.reveal(line, column);
  }
  if (app.narrowQuery.matches) app.setOutline(false);
}

/** 檔案樹右鍵選單與快速鍵的動作。 */
/** 從電腦上傳檔案到遠端資料夾（SSH、WebDAV）。 */
export async function uploadFiles(dir: string, files: File[]): Promise<void> {
  if (!desktop || !app.fileTree || !files.length) return;
  const progress = toast(t("上傳中…（{n} 個檔案）", { n: files.length }), { duration: 600_000 });
  let done = 0;
  try {
    for (const f of files) {
      await desktop.davUpload(dir, f.name, await f.arrayBuffer());
      done++;
    }
  } finally {
    progress.dismiss();
    app.fileListCache = null;
    await app.fileTree.refresh([dir]);
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

export async function treeAction(action: TreeAction, entry: Entry): Promise<void> {
  const d = desktop;
  if (!d || !app.fileTree) return;
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
      let name = await app.fileTree.promptName(entry.path, isDir ? t("新資料夾") : t("未命名.md"), isDir ? "folder" : "file");
      if (!name) return;
      if (!isDir && !name.includes(".")) name += ".md";
      const path = await d.createEntry(entry.path, name, isDir);
      app.fileListCache = null;
      await app.fileTree.refresh([entry.path]);
      if (!isDir) await openPath(path);
      break;
    }
    case "rename": {
      const parent = dirname(entry.path);
      const name = await app.fileTree.promptName(parent, entry.name, "rename", entry.path);
      if (!name || name === entry.name) return;
      // 改名前記下各文件的連結，改名後才知道哪些要更新。
      const local = !isRemote(entry.path) && !!app.workspaceRoot;
      const before = local ? await indexedDocs().catch(() => []) : [];
      app.fileListCache ??= local && app.workspaceRoot ? await d.listFiles(app.workspaceRoot.path).catch(() => []) : app.fileListCache;
      const filesBefore = app.markdownFiles(app.fileListCache ?? []);
      const to = await d.renameEntry(entry.path, name);
      // 已開啟的分頁（含改名資料夾底下的檔案）改用新路徑。
      app.stash();
      for (const doc of app.docs) {
        const moved = doc.path && rebase(doc.path, entry.path, to);
        if (!moved) continue;
        doc.path = moved;
        if (doc.path === to) doc.name = basename(to);
        doc.handle = desktopHandle(moved, basename(moved));
      }
      ({ name: app.fileName, handle: app.fileHandle } = app.active);
      app.fileListCache = null;
      app.persistSession();
      app.renderSaveState();
      app.renderTabs();
      await app.fileTree.refresh([parent]);
      if (local && (entry.isDir || /\.(md|markdown)$/i.test(entry.path))) await app.updateLinksAfterRename(entry.path, to, before, filesBefore);
      break;
    }
    case "trash": {
      app.stash();
      const affected = app.docs.filter((doc) => doc.path && isInside(doc.path, entry.path));
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
      app.fileListCache = null;
      app.renderTabs();
      await app.fileTree.refresh([dirname(entry.path)]);
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
  return app.workspaceRoot && { path: app.workspaceRoot.path, name: app.workspaceRoot.name, isDir: true };
}

export function initWorkspaceUi(): void {
  window.addEventListener("focus", () => {
    if (Date.now() - indexScannedAt < 60_000) return;
    app.indexStale = true;
    refreshIndexPanels(200);
  });
  tasksPanel = new TasksPanel(app.$("#tasks-host"), {
    docs: indexedDocs,
    open: (doc, line) => openIndexed(doc, line),
    async toggle(item, done) {
      const tab = tabOfIndexed(item.doc);
      if (tab) {
        if (tab !== app.active) app.activate(tab);
        const doc = app.editor.view.state.doc;
        if (item.line > doc.lines) throw new Error(t("這一行已經不是待辦了，請重新整理"));
        const line = doc.line(item.line);
        const next = setTaskLine(line.text, done);
        if (next === null) throw new Error(t("這一行已經不是待辦了，請重新整理"));
        app.editor.view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, userEvent: "input.task" });
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
        : desktop && !app.workspaceRoot
          ? t("開啟資料夾後，這裡會列出資料夾中所有文件的待辦；目前只看已開啟的分頁。")
          : t("這裡會列出已開啟分頁中的待辦。在文件中寫「- [ ] 要做的事」就會列在這裡，可以加上 @負責人 與截止日（例如 10/25）。"),
  });
  app.$("#tasks-refresh").addEventListener("click", () => {
    app.indexStale = true;
    void tasksPanel.refresh();
  });
  tagsPanel = new TagsPanel(app.$("#tags-host"), {
    docs: indexedDocs,
    open: (doc, line) => openIndexed(doc, line),
    text: (doc) => docIndex.text(doc),
    emptyHint: () =>
      indexScope() === "folder"
        ? t("資料夾中還沒有標籤。在文件中寫 #專案A、#KR2 這樣的標籤，就能在這裡依標籤找文件。")
        : t("這裡會列出已開啟分頁中的標籤；開啟資料夾後會列出資料夾中所有文件的標籤。"),
  });
  app.$("#tags-refresh").addEventListener("click", () => {
    app.indexStale = true;
    void tagsPanel.refresh();
  });
  for (const tab of app.sideTabs) {
    tab.title ||= tab.getAttribute("aria-label") ?? "";
    // 和 VS Code 一樣：再按一次目前的圖示會收起側邊欄。
    tab.addEventListener("click", () => {
      const panel = tab.dataset.panel as SidePanel;
      if (panel === app.sidePanel && app.outlineShown) app.setOutline(false);
      else showPanel(panel);
    });
  }
  app.$(".activity-tabs").addEventListener("keydown", (e) => {
    // 依畫面上的順序（使用者可以調整），略過隱藏的圖示。
    const tabs = [...app.$(".activity-tabs").querySelectorAll<HTMLButtonElement>("[role=tab]")].filter(
      (t) => !t.hidden && !t.classList.contains("user-hidden"),
    );
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const next = tabs[(i + (e.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    showPanel(next.dataset.panel as SidePanel);
  });
  app.$("#tree-new-file").addEventListener("click", () => {
    const root = rootEntry();
    if (root) void treeAction("new-file", root).catch(reportError);
  });
  app.$("#tree-new-folder").addEventListener("click", () => {
    const root = rootEntry();
    if (root) void treeAction("new-folder", root).catch(reportError);
  });
  app.$("#tree-refresh").addEventListener("click", () => {
    app.fileListCache = null;
    void app.fileTree?.refresh().catch(reportError);
  });
  if (!desktop) {
    const p = document.createElement("p");
    p.className = "side-empty";
    // 「{keys}」換成快速鍵的 <kbd>。
    const [before, after] = t("搜尋整個資料夾的內容需要桌面版。要搜尋目前的文件，請按 {keys}。").split("{keys}");
    p.textContent = before;
    p.append(Object.assign(document.createElement("kbd"), { textContent: formatKeys("Mod-f") }), after ?? "");
    app.$("#search-host").append(p);
  }
}
