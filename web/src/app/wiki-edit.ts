/**
 * Wiki 共同編輯：編輯中定期檢查有沒有人改過；載入最新版時保留自己的修改。也負責在主要區域顯示 Wiki 頁面與工作項目。
 */
import { desktop, type AdoWiki } from "../desktop.ts";
import { timeAgo } from "../history-label.ts";
import { t } from "../i18n.ts";
import { issueFileName } from "../issue-doc.ts";
import { highlightPlugin } from "../plugins/highlight.ts";
import { mathPlugin } from "../plugins/math.ts";
import { mermaidPlugin } from "../plugins/mermaid.ts";
import { tablesPlugin } from "../plugins/tables.ts";
import { Preview } from "../preview.ts";
import { blockRemoteImages } from "../remote-images.ts";
import { saveDraft } from "../session.ts";
import * as storage from "../storage.ts";
import { choose } from "../ui/choice.ts";
import { icon } from "../ui/icons.ts";
import { IssueView } from "../ui/issue-view.ts";
import { toast } from "../ui/toast.ts";
import { type WikiPageInfo, myChanges } from "../wiki-coedit.ts";
import { isWorkItemShortcut } from "../wiki-shortcuts.ts";
import { pageName, wikiMarkdown, wikiPageLink, resolvePageLink, flattenPages } from "../wiki-text.ts";
import { openDiagram, copyDiagram } from "./activity-bar.ts";
import { reportError } from "./git-actions.ts";
import { insertAtCursor } from "./image-paste.ts";
import { offlineRefs, issueOffline } from "./offline-copies.ts";
import { openWikiHistory } from "./wiki-history.ts";
import { workItemOpened } from "./work-item-updates.ts";
import { barShortcuts, toggleWikiShortcut, wikiPanel, workItemsPanel, issuesPanel, markBarShortcuts } from "./work-items-panel.ts";
import type { Doc } from "../main.ts";
import { app } from "./context.ts";


// 在 init 時建立。
let wikiBar: HTMLElement;
// 在 init 時建立。
let wikiMine: HTMLElement;
/** 編輯中多久檢查一次伺服器上的版本。 */
const WIKI_CHECK_MS = 90_000;
/** 切回視窗、切換分頁時，距離上次檢查至少多久才再檢查。 */
const WIKI_RECHECK_MS = 20_000;
/** 伺服器上比開始編輯（或上次存回）時新的版本；按「稍後」後，同一個版本不再提示。 */
export const wikiNewer = new Map<string, { info: WikiPageInfo; dismissed: boolean }>();
export const wikiCheckedAt = new Map<string, number>();
/** 「我的修改」面板收合起來的分頁。 */
const wikiMineCollapsed = new Set<string>();
let adoMeName: Promise<string | null> | null = null;

/** 目前連線的使用者名稱（判斷最後修改的是不是自己）。 */
export function adoMe(): Promise<string | null> {
  adoMeName ??= desktop!
    .adoAccount()
    .then((a) => a?.name ?? null)
    .catch(() => null);
  return adoMeName;
}

/** 檢查 Wiki 分頁對應的頁面有沒有被別人改過（網路錯誤時不提示，下次再查）。 */
export async function checkWikiNewer(doc: Doc, force = false): Promise<void> {
  const target = doc.wiki;
  if (!target || !desktop) return;
  const last = wikiCheckedAt.get(doc.id) ?? 0;
  if (!force && Date.now() - last < WIKI_RECHECK_MS) return;
  wikiCheckedAt.set(doc.id, Date.now());
  const [info, me] = await Promise.all([desktop.adoWikiPageInfo(target).catch(() => null), adoMe()]);
  // 檢查期間存回了或分頁關掉了：以目前的版本為準。
  if (!info?.etag || !app.docs.includes(doc) || !doc.wiki) return;
  const newer = info.etag !== doc.wiki.etag && !(info.author && me && sameUser(info.author, me));
  if (!newer) wikiNewer.delete(doc.id);
  else if (wikiNewer.get(doc.id)?.info.etag !== info.etag) wikiNewer.set(doc.id, { info, dismissed: false });
  if (doc === app.active) renderWikiBar();
}

function sameUser(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** 編輯中的 Wiki 頁面有新版本時，上方的提示列。 */
export function renderWikiBar(): void {
  const newer = app.active.wiki ? wikiNewer.get(app.active.id) : undefined;
  wikiBar.hidden = !newer || newer.dismissed;
  if (!newer || newer.dismissed) return;
  const { author, date } = newer.info;
  const at = date ? Date.parse(date) : NaN;
  const msg = document.createElement("p");
  msg.append(
    icon("users"),
    Object.assign(document.createElement("strong"), { textContent: t("這一頁有新版本") }),
    Object.assign(document.createElement("span"), {
      textContent:
        author && Number.isFinite(at)
          ? t("{who} {ago}存了新的內容（在你開始編輯之後）。", { who: author, ago: timeAgo(at) })
          : t("有人在你開始編輯之後存了新的內容。"),
    }),
  );
  const actions = document.createElement("div");
  actions.className = "wiki-bar-actions";
  const button = (label: string, run: () => Promise<void> | void, primary = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn${primary ? " btn-primary" : ""}`;
    b.textContent = label;
    b.addEventListener("click", () => void Promise.resolve(run()).catch(reportError));
    return b;
  };
  const doc = app.active;
  const dirty = app.hash(app.editor.text) !== app.baseline;
  if (dirty) {
    actions.append(
      button(t("比較差異"), () => compareWikiLatest(doc), true),
      button(t("載入最新版，保留我的修改"), () => loadWikiLatest(doc)),
    );
  } else {
    actions.append(button(t("載入最新版"), () => loadWikiLatest(doc), true));
  }
  actions.append(
    button(t("稍後"), () => {
      newer.dismissed = true;
      renderWikiBar();
    }),
  );
  wikiBar.replaceChildren(msg, actions);
}

/** 讀伺服器上最新的內容與版本。 */
async function fetchWikiLatest(doc: Doc): Promise<{ content: string; etag: string | null }> {
  const target = doc.wiki!;
  const wiki = { id: target.wikiId, projectId: target.projectId, code: false, version: null } as AdoWiki;
  const page = await desktop!.adoWikiPage(wiki, target.path);
  return { content: page.content.replace(/\r\n?/g, "\n"), etag: page.etag };
}

/** 和伺服器上的最新版逐段比較（和存檔時發生衝突一樣，全部處理完會存回）。 */
async function compareWikiLatest(doc: Doc): Promise<void> {
  if (doc !== app.active) return;
  const latest = await fetchWikiLatest(doc);
  if (latest.etag) app.wikiServerEtag.set(doc.id, latest.etag);
  wikiNewer.delete(doc.id);
  renderWikiBar();
  const started = app.review.start(latest.content, {
    title: t("與 Wiki 上的版本比較"),
    hint: t("逐段選擇要採用哪個版本，全部處理完會自動存檔。"),
    acceptLabel: t("採用伺服器版本"),
    rejectLabel: t("保留我的版本"),
    onFinish: () => void app.save(false, true).catch(reportError),
  });
  if (!started) toast(t("你的內容和 Wiki 上的最新版相同。"));
}

/**
 * 換成伺服器上的最新版；自己還沒存回的修改另外保留在「我的修改」面板，可以一段一段複製、插入回去
 * （也可以按 Ctrl+Z 回到換之前的內容）。`latest` 是已經讀到的最新版（存檔衝突時）。
 */
export async function loadWikiLatest(doc: Doc, latest?: { content: string; etag: string | null }): Promise<void> {
  if (doc !== app.active) return;
  // 比較差異還沒處理完：結束比較會存檔，先讓使用者處理完。
  if (app.review.active) {
    toast(t("請先處理完目前的比較差異。"));
    return;
  }
  latest ??= await fetchWikiLatest(doc);
  if (!latest.etag) throw new Error(t("伺服器沒有提供這一頁的版本，無法確認存回時有沒有蓋掉別人的修改，所以不能在這裡編輯。"));
  const mine = app.editor.text;
  const base = storage.load(`wiki-base:${doc.id}`);
  const kept = app.hash(mine) !== app.baseline && mine !== latest.content;
  if (kept) {
    storage.save(`wiki-mine:${doc.id}`, JSON.stringify({ text: mine, base, at: Date.now() }));
    wikiMineCollapsed.delete(doc.id);
  }
  app.editor.replaceAll(latest.content, { userEvent: "input.reload", isolate: true });
  app.wikiServerEtag.delete(doc.id);
  wikiNewer.delete(doc.id);
  doc.wiki = { ...doc.wiki!, etag: latest.etag };
  storage.save(`wiki-base:${doc.id}`, latest.content);
  app.setBaseline(latest.content, true);
  app.renderSaveState();
  app.renderTabs();
  renderWikiBar();
  renderWikiMine();
  toast(
    kept
      ? t("已載入 Wiki 上的最新版。你的修改保留在上方的「我的修改」，可以複製或插入回去；按 Ctrl+Z 可以回到你原本的內容。")
      : t("已載入 Wiki 上的最新版。"),
    { tone: "success", duration: kept ? 10000 : 4000 },
  );
}

interface WikiMine {
  text: string;
  base: string | null;
  at: number;
}

function loadWikiMine(id: string): WikiMine | null {
  try {
    const v = JSON.parse(storage.load(`wiki-mine:${id}`) ?? "null") as WikiMine | null;
    return v && typeof v.text === "string" ? v : null;
  } catch {
    return null;
  }
}

/** 「我的修改」面板：載入最新版之前自己改的內容，一段一段可以複製、插入到游標處、找到原本的位置。 */
export function renderWikiMine(): void {
  const mine = app.active.wiki ? loadWikiMine(app.active.id) : null;
  wikiMine.hidden = !mine;
  if (!mine) {
    wikiMine.replaceChildren();
    return;
  }
  const doc = app.active;
  const changes = mine.base === null ? [{ before: "", after: mine.text }] : myChanges(mine.base, mine.text);
  const collapsed = wikiMineCollapsed.has(doc.id);
  wikiMine.classList.toggle("collapsed", collapsed);

  const btn = (label: string, iconName: string, run: () => void | Promise<void>, cls = "btn") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.append(icon(iconName), Object.assign(document.createElement("span"), { textContent: label }));
    b.addEventListener("click", () => void Promise.resolve(run()).catch(reportError));
    return b;
  };
  const copy = async (text: string, item?: HTMLElement) => {
    await navigator.clipboard.writeText(text);
    item?.classList.add("used");
    toast(t("已複製"), { tone: "success", duration: 1500 });
  };

  const head = document.createElement("header");
  const title = document.createElement("p");
  title.append(
    icon("history"),
    Object.assign(document.createElement("strong"), { textContent: t("我的修改（{n} 段）", { n: changes.length }) }),
    Object.assign(document.createElement("span"), {
      textContent: t("{time}載入最新版前保留的。把需要的段落複製或插入回去，再按 Ctrl+S 存回。", { time: timeAgo(mine.at) }),
    }),
  );
  const tools = document.createElement("div");
  tools.className = "wiki-mine-tools";
  tools.append(
    btn(t("複製我的完整版本"), "copy", () => copy(mine.text)),
    btn(t("在新分頁開啟"), "file-plus", () => {
      const copyDoc = app.makeDoc({ name: t("{name}（我的版本）.md", { name: pageName(doc.wiki!.path) }), kind: "markdown", baseline: app.hash("") });
      saveDraft(copyDoc.id, mine.text);
      app.addTab(copyDoc);
    }),
    btn(collapsed ? t("展開") : t("收合"), collapsed ? "chevron-down" : "chevron-up", () => {
      if (collapsed) wikiMineCollapsed.delete(doc.id);
      else wikiMineCollapsed.add(doc.id);
      renderWikiMine();
    }),
    btn(t("關閉"), "x", async () => {
      const choice = await choose(t("關閉「我的修改」？"), t("關閉後就不再保留這份修改（還沒貼回去的內容會不見）。"), [
        { id: "close", label: t("關閉"), danger: true },
        { id: "cancel", label: t("取消"), primary: true },
      ]);
      if (choice !== "close") return;
      storage.remove(`wiki-mine:${doc.id}`);
      renderWikiMine();
    }),
  );
  head.append(title, tools);

  const list = document.createElement("ol");
  list.className = "wiki-mine-list";
  for (const change of changes) {
    const item = document.createElement("li");
    if (change.before) {
      const label = change.after ? t("原本") : t("你刪除了");
      item.append(
        Object.assign(document.createElement("div"), { className: "wiki-mine-label", textContent: label }),
        Object.assign(document.createElement("pre"), { className: "wiki-mine-before", textContent: change.before }),
      );
    }
    if (change.after) {
      item.append(
        Object.assign(document.createElement("div"), {
          className: "wiki-mine-label",
          textContent: change.before ? t("改成") : t("你新增了"),
        }),
        Object.assign(document.createElement("pre"), { className: "wiki-mine-after", textContent: change.after }),
      );
    }
    const actions = document.createElement("div");
    actions.className = "wiki-mine-actions";
    if (change.before && change.after) {
      actions.append(
        btn(t("取代原本這段"), "replace", () => {
          const view = app.editor.view;
          const at = view.state.doc.toString().indexOf(change.before);
          if (at < 0) {
            toast(t("最新版裡找不到原本這段（可能已經被別人改掉了），請改用「複製」或「插入到游標處」。"));
            return;
          }
          view.dispatch({
            changes: { from: at, to: at + change.before.length, insert: change.after },
            selection: { anchor: at + change.after.length },
            scrollIntoView: true,
            userEvent: "input.paste",
          });
          view.focus();
          item.classList.add("used");
        }, "btn btn-small"),
      );
    }
    if (change.after) {
      actions.append(
        btn(t("複製"), "copy", () => copy(change.after, item), "btn btn-small"),
        btn(t("插入到游標處"), "corner-down-left", () => {
          const view = app.editor.view;
          const sel = view.state.selection.main;
          const line = view.state.doc.lineAt(sel.from);
          // 游標在一段文字的結尾或開頭時，插入成獨立的一段。
          let text = change.after;
          if (sel.empty && line.text.trim()) {
            if (sel.from === line.to) text = `\n\n${text}`;
            else if (sel.from === line.from) text = `${text}\n\n`;
          }
          view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.paste" });
          view.focus();
          item.classList.add("used");
        }, "btn btn-small"),
      );
    }
    if (change.before) {
      actions.append(
        btn(t("找到原本的位置"), "search", () => {
          const view = app.editor.view;
          const at = view.state.doc.toString().indexOf(change.before);
          if (at < 0) {
            toast(t("最新版裡找不到原本這段（可能已經被別人改掉了）。"));
            return;
          }
          view.dispatch({ selection: { anchor: at, head: at + change.before.length }, scrollIntoView: true });
          view.focus();
        }, "btn btn-small"),
      );
    }
    item.append(actions);
    list.append(item);
  }
  wikiMine.replaceChildren(head, list);
}

/** 在主要區域開啟 Wiki 頁面；內容裡連到其他頁面的連結直接在這裡切換。 */
export function showWikiPage(wiki: AdoWiki, path: string): void {
  let webUrl = wiki.webUrl ?? "";
  const title = pageName(path);
  offlineRefs.set(`wiki:${wiki.id}:${path}`, { type: "wiki", wiki, path });
  void app.showIssue({
    key: `wiki:${wiki.id}:${path}`,
    origin: { kind: "wiki", icon: "book-open-text", text: "Azure DevOps Wiki" },
    label: wiki.name,
    title,
    get webUrl() {
      return webUrl;
    },
    fileName: issueFileName(wiki.name, title),
    // 程式碼 Wiki 的內容在 Git 儲存庫裡，要用 Git 改；專案 Wiki 可以直接編輯、存回。
    edit: wiki.code ? undefined : () => void app.editWikiPage(wiki, path).catch(reportError),
    history: wiki.code
      ? undefined
      : () => openWikiHistory({ projectId: wiki.projectId, wikiId: wiki.id, repositoryId: wiki.repositoryId, path }, wiki),
    addChild: wiki.code ? undefined : () => void app.createWikiPage(wiki, path).catch(reportError),
    remove: wiki.code ? undefined : () => void app.deleteWikiPage(wiki, path).catch(reportError),
    shortcut: {
      has: () => barShortcuts.some((s) => !isWorkItemShortcut(s) && s.wiki === wiki.id && s.path === path),
      toggle: () => toggleWikiShortcut(wiki, path),
    },
    // 標頭顯示所在位置：Wiki 名稱 › 上層頁面…（點上層頁面切換過去）。
    crumbs: [
      { label: wiki.name },
      ...path
        .split("/")
        .filter(Boolean)
        .slice(0, -1)
        .map((name, i, parts) => {
          const parent = `/${parts.slice(0, i + 1).join("/")}`;
          return { label: name, open: () => showWikiPage(wiki, parent) };
        }),
    ],
    load: async () => {
      // 先設定：讀不到、改顯示離線副本時，圖片的相對路徑也以這一頁為準。
      app.wikiPage = { wiki, path };
      const page = await desktop!.adoWikiPage(wiki, path);
      webUrl = page.webUrl ?? webUrl;
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
export function rerenderIssue(): void {
  issuePreview?.clear();
  issueView.rerender();
}
/** 工作項目、Wiki、Issue 和編輯區並排顯示（不蓋住正在寫的文件）；記住上次的選擇。 */
export let issueSide = storage.load("issue-side") === "1";

export // 在 init 時建立。
let issueView: IssueView;

export function initWikiEdit(): void {
  wikiBar = app.$("#wiki-bar");
  wikiMine = app.$("#wiki-mine");
  wikiMine.setAttribute("aria-label", t("我的修改"));
  window.setInterval(() => {
    if (!document.hidden && app.active.wiki) void checkWikiNewer(app.active, true);
  }, WIKI_CHECK_MS);
  window.addEventListener("focus", () => {
    if (app.active.wiki) void checkWikiNewer(app.active);
  });
  issueView = new IssueView(app.$(".workspace"), {
    render(markdown, into) {
      issuePreview ??= new Preview(into, [
        highlightPlugin(),
        app.workItemChipsPlugin,
        // Wiki 常用流程圖與數學式：和本機預覽一樣畫出來（依同樣的設定）。
        mathPlugin(() => app.settings.value.math),
        mermaidPlugin(() => app.settings.value.mermaid, { open: (svg) => openDiagram(svg), copy: (svg) => void copyDiagram(svg) }),
        tablesPlugin(),
        app.adoImagesPlugin,
        app.wikiImagesPlugin,
        app.repoImagesPlugin,
        {
          name: "remote-images",
          apply() {},
          prepare(content) {
            if (app.settings.value.blockRemoteImages) blockRemoteImages(content);
          },
        },
      ]);
      const result = issuePreview.update(markdown, "markdown");
      // 大綱改列這一頁的標題；捲動內容時標示目前讀到的段落。
      if (app.outlineView) {
        app.outlineView = { ...app.outlineView, headings: result.headings, body: into };
        app.renderOutline(result.headings);
        app.updateActiveHeading();
      }
      if (!into.dataset.outlineScroll) {
        into.dataset.outlineScroll = "1";
        into.parentElement?.addEventListener("scroll", () => app.outlineView && app.updateActiveHeading(), { passive: true });
      }
    },
    open: (url) => void desktop?.openExternal(url).catch(reportError),
    follow: (href) => app.openRepoFileLink(href),
    copyAsDocument(name, markdown) {
      issueView.close();
      const doc = app.makeDoc({ name, kind: "markdown", baseline: app.hash("") });
      saveDraft(doc.id, markdown);
      app.addTab(doc);
      toast(t("已複製成新的 Markdown 分頁，修改不會回寫到伺服器"));
    },
    offline: issueOffline,
    facts: (list) => app.setIssueFacts(list),
    opened(source) {
      app.issueKey = source.key;
      app.outlineView = { key: source.key, headings: [], body: null };
      app.renderOutline([]);
      // Wiki 頁面、儲存庫檔案讀到內容時才設定（圖片的相對路徑以它為準）。
      app.wikiPage = null;
      app.repoFile = null;
      const [kind, id, ...rest] = source.key.split(":");
      if (kind === "ado") workItemOpened(Number(id));
      workItemsPanel?.select(kind === "ado" ? Number(id) : null);
      issuesPanel?.select(kind === "github" ? Number(id) : null);
      wikiPanel?.select(kind === "wiki" && wikiPanel.wiki?.id === id ? rest.join(":") : null);
      markBarShortcuts();
    },
    toggleSide() {
      issueSide = !issueSide;
      storage.save("issue-side", issueSide ? "1" : "");
      issueView.setSide(issueSide);
      app.applyLayout();
      toast(issueSide ? t("已改成和編輯區並排顯示") : t("已改回蓋住編輯區顯示"));
    },
    closed() {
      app.issueKey = null;
      markBarShortcuts();
      app.wikiPage = null;
      app.outlineView = null;
      app.renderOutline(app.docHeadings);
      app.updateActiveHeading();
      workItemsPanel?.select(null);
      issuesPanel?.select(null);
      wikiPanel?.select(null);
    },
  });
}
