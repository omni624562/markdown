/**
 * Azure DevOps 儲存庫裡的文字檔、工作項目的附件、Wiki 頁面的編輯與儲存：在 oMarker 裡閱讀。
 */
import { attachmentKind, attachmentLink } from "../attachments.ts";
import { desktop, type AdoWiki } from "../desktop.ts";
import { timeAgo } from "../history-label.ts";
import { t, currentLang } from "../i18n.ts";
import type { PreviewPlugin } from "../preview.ts";
import { resolveRepoPath, parseRepoFileLink, type RepoFileLink, repoFileUrl, isMarkdownName, fenceLanguage, isReadableFileName } from "../repo-links.ts";
import { saveDraft } from "../session.ts";
import * as storage from "../storage.ts";
import { choose, askText } from "../ui/choice.ts";
import type { IssueSource } from "../ui/issue-view.ts";
import { openLightbox } from "../ui/lightbox.ts";
import { toast } from "../ui/toast.ts";
import { recentEditor } from "../wiki-coedit.ts";
import { isWorkItemShortcut } from "../wiki-shortcuts.ts";
import { wikiPageLink, pageName, wikiTitleProblem, flattenPages, childPagePath } from "../wiki-text.ts";
import { reportError } from "./git-actions.ts";
import { insertAtCursor } from "./image-paste.ts";
import { closeItemsWhere, openItem } from "./item-tabs.ts";
import { withOfflineCopy } from "./offline-copies.ts";
import { adoMe, wikiCheckedAt, wikiNewer, renderWikiBar } from "./wiki-edit.ts";
import { wikiPanel, barShortcuts, setBarShortcuts } from "./work-items-panel.ts";
import { app } from "./context.ts";


export const repoImagesPlugin: PreviewPlugin = {
  name: "repo-images",
  prepare(content) {
    if (!app.repoFile) return;
    for (const img of content.querySelectorAll<HTMLImageElement>("img")) {
      const path = resolveRepoPath(app.repoFile.path, img.getAttribute("src") ?? "");
      if (!path) continue;
      img.dataset.repoSrc = path;
      img.removeAttribute("src");
    }
  },
  apply(_root, scope) {
    const file = app.repoFile;
    if (!file) return;
    for (const img of scope.querySelectorAll<HTMLImageElement>("img[data-repo-src]")) {
      void desktop!
        .adoRepoImage(file.project, file.repo, img.dataset.repoSrc!, file.version)
        .then((url) => (img.src = url))
        .catch((e) => (img.title = e instanceof Error ? e.message : String(e)));
    }
  },
};

/**
 * 工作項目的附件（連到連線中伺服器上的附件時回傳 true）：文字檔開成唯讀分頁，圖片放大檢視，
 * 其他檔案下載後用預設的程式開啟；會自己執行的檔案改成另存新檔。
 */
export function openAttachment(href: string): boolean {
  const base = app.ado?.account?.url;
  const link = desktop && base ? attachmentLink(href, base) : null;
  if (!link) return false;
  const kind = attachmentKind(link.name);
  if (kind === "text") {
    showRepoFile({ kind: "attachment", url: link.url, name: link.name });
  } else if (kind === "image") {
    void desktop!
      .adoImage(link.url)
      .then((src) => openLightbox(src, link.name))
      .catch(reportError);
  } else if (kind === "runnable") {
    toast(t("「{name}」是會自己執行的檔案，為了安全不直接開啟；需要的話請用「另存新檔」，確認來源可信再開啟。", { name: link.name }), {
      tone: "error",
      action: { label: t("另存新檔"), run: () => saveAttachment(href) },
    });
  } else {
    toast(t("正在下載「{name}」…", { name: link.name }));
    void desktop!.adoAttachmentOpen(link.url, link.name).catch(reportError);
  }
  return true;
}

/** 附件另存新檔。 */
export function saveAttachment(href: string): void {
  const base = app.ado?.account?.url;
  const link = desktop && base ? attachmentLink(href, base) : null;
  if (!link) return;
  void desktop!
    .adoAttachmentSave(link.url, link.name)
    .then((path) => path && toast(t("已存到 {path}", { path }), { tone: "success" }))
    .catch(reportError);
}

/** 連到連線中伺服器上、可以閱讀的儲存庫檔案或附件時，在主要區域開啟並回傳 true。 */
export function openRepoFileLink(href: string): boolean {
  const base = app.ado?.account?.url;
  const link = desktop && base ? parseRepoFileLink(href, base) : null;
  if (!link) return false;
  showRepoFile(link);
  return true;
}

/** 在主要區域閱讀儲存庫裡的文字檔或附件：Markdown 照常排版，其他文字檔當成程式碼上色。 */
function showRepoFile(link: RepoFileLink): void {
  const base = app.ado!.account!.url;
  const git = link.kind === "git" ? link : null;
  const webUrl = link.kind === "git" ? repoFileUrl(base, link) : link.url;
  const folder = git ? git.path.slice(0, git.path.lastIndexOf("/")) || "/" : "";
  void showIssue({
    key: `file:${webUrl}`,
    origin: git
      ? { kind: "repo", icon: "git-branch", text: t("Azure DevOps 儲存庫") }
      : { kind: "repo", icon: "paperclip", text: t("工作項目附件") },
    label: git ? `${git.repo}${folder === "/" ? "" : folder}${git.version ? ` @ ${git.version}` : ""}` : t("附件"),
    title: link.name,
    webUrl,
    fileName: isMarkdownName(link.name) ? link.name : `${link.name}.md`,
    load: async () => {
      const text = link.kind === "git" ? await desktop!.adoRepoText(link) : await desktop!.adoAttachmentText(link.url);
      app.repoFile = git;
      if (isMarkdownName(link.name)) return text;
      // 其他文字檔放進程式碼區塊（圍欄比內容裡最長的 ` 多一個）。
      const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      return `${fence}${fenceLanguage(link.name)}\n${text.replace(/\n$/, "")}\n${fence}`;
    },
    insertLink: () => {
      insertAtCursor(wikiPageLink(link.name, webUrl));
      toast(t("已插入「{name}」的連結", { name: link.name }));
    },
    // 檔案裡的相對連結：同一個儲存庫的文字檔在這裡切換，其他檔案用瀏覽器開。
    link: git
      ? (href) => {
          const path = resolveRepoPath(git.path, href);
          if (!path) return false;
          const name = path.slice(path.lastIndexOf("/") + 1);
          if (isReadableFileName(name)) showRepoFile({ ...git, path, name });
          else void desktop?.openExternal(repoFileUrl(base, git, path)).catch(reportError);
          return true;
        }
      : undefined,
  });
}

/** 開啟工作項目、issue、Wiki 頁面（開在分頁裡；Git 歷史開著時先關掉）。 */
export function showIssue(source: IssueSource): Promise<void> {
  return openItem(source);
}

/** 存回 Wiki 時伺服器上比較新的版本（發生衝突後，使用者選擇覆蓋時用它）。 */
export const wikiServerEtag = new Map<string, string>();

/** 在分頁裡編輯 Wiki 頁面（Ctrl+S 存回伺服器）；已經開著就切換過去。 */
export async function editWikiPage(wiki: AdoWiki, path: string): Promise<void> {
  const open = app.docs.find((d) => d.wiki?.wikiId === wiki.id && d.wiki.path === path);
  if (open) {
    app.activate(open);
    return;
  }
  const target = { projectId: wiki.projectId, wikiId: wiki.id, repositoryId: wiki.repositoryId, path };
  // 開始編輯前先看最後是誰、什麼時候改的：別人剛改過就提醒（對方可能還在編輯）。
  const [info, me] = await Promise.all([
    desktop!.adoWikiPageInfo(target).catch(() => null),
    adoMe(),
  ]);
  const recent = info && recentEditor(info, me);
  if (recent) {
    const choice = await choose(
      t("這一頁剛有人改過"),
      t("{who} {ago}改過「{name}」，可能還在編輯。兩個人同時編輯時，後存檔的人要比較差異、合併修改；可以先聯絡對方。", {
        who: recent.author,
        ago: timeAgo(recent.at),
        name: pageName(path),
      }),
      [
        { id: "edit", label: t("仍要編輯"), primary: true },
        { id: "cancel", label: t("取消") },
      ],
    );
    if (choice !== "edit") return;
  }
  const page = await desktop!.adoWikiPage(wiki, path);
  if (!page.etag) throw new Error(t("伺服器沒有提供這一頁的版本，無法確認存回時有沒有蓋掉別人的修改，所以不能在這裡編輯。"));
  // 編輯器一律用 \n 換行，先統一，免得一開就顯示成有變更。
  const content = page.content.replace(/\r\n?/g, "\n");
  const doc = app.makeDoc({
    name: `${pageName(path)}.md`,
    kind: "markdown",
    baseline: app.hash(content),
    wiki: { ...target, wikiName: wiki.name, etag: page.etag },
  });
  saveDraft(doc.id, content);
  storage.save(`wiki-base:${doc.id}`, content);
  wikiCheckedAt.set(doc.id, Date.now());
  app.addTab(doc);
  const last = info?.author && info.date && Number.isFinite(Date.parse(info.date))
    ? t("最後修改：{who}，{ago}。", { who: info.author, ago: timeAgo(Date.parse(info.date)) })
    : "";
  const hint = t("編輯完按 Ctrl+S 存回 Wiki。編輯中有人存檔時，上方會出現提示。");
  toast(last ? `${hint} ${last}` : hint, { duration: 8000 });
}

/** 新增 Wiki 頁面（`parent` 是上層頁面，null 是最上層）：問標題、建立，然後直接開始編輯。 */
export async function createWikiPage(wiki: AdoWiki, parent: string | null): Promise<void> {
  if (wiki.code) {
    toast(t("從程式碼儲存庫發佈的 Wiki 要在儲存庫裡新增 Markdown 檔（用 Git 提交）。"));
    return;
  }
  const where = parent ? t("新頁面會放在「{name}」底下。", { name: pageName(parent) }) : t("新頁面會放在 Wiki 的最上層。");
  let title = "";
  for (;;) {
    const answer = await askText(parent ? t("新增子頁面") : t("新增頁面"), where, title, t("建立"));
    if (answer === null) return;
    title = answer.trim();
    const problem = wikiTitleProblem(title);
    const existing = new Set(flattenPages(wikiPanel?.pages ?? []).map((p) => p.toLowerCase()));
    const message =
      problem === "empty"
        ? t("請輸入頁面標題。")
        : problem === "chars"
          ? t("頁面標題不能有 /、\\、#。")
          : problem === "dot"
            ? t("頁面標題不能以「.」開頭或結尾。")
            : problem === "long"
              ? t("頁面標題太長了。")
              : existing.has(childPagePath(parent, title).toLowerCase())
                ? t("已經有同名的頁面了，請換一個名稱")
                : null;
    if (!message) break;
    toast(message, { tone: "error" });
  }
  const path = childPagePath(parent, title);
  await desktop!.adoWikiCreate(wiki, path, `# ${title}\n\n`);
  toast(t("已建立 Wiki 頁面「{name}」", { name: title }), { tone: "success" });
  void wikiPanel?.refresh().then(() => wikiPanel?.select(path));
  await editWikiPage(wiki, path);
}

/** 刪除 Wiki 頁面（子頁面一起刪除，和網頁版一樣）；先確認，刪除後關閉檢視、重新讀取清單、拿掉圖示列上的捷徑。 */
export async function deleteWikiPage(wiki: AdoWiki, path: string): Promise<void> {
  const name = pageName(path);
  const inside = (p: string) => p === path || p.startsWith(`${path}/`);
  // 子頁面數：清單開著別的 Wiki 時另外讀這個 Wiki 的頁面樹（讀不到就不寫數字）。
  const pages =
    wikiPanel?.wiki?.id === wiki.id
      ? wikiPanel.pages
      : await withOfflineCopy(`wiki-pages:${wiki.id}`, () => desktop!.adoWikiPages(wiki)).catch(() => []);
  const children = flattenPages(pages).filter((p) => p.startsWith(`${path}/`)).length;
  const editing = app.docs.filter((d) => d.wiki?.wikiId === wiki.id && inside(d.wiki.path));
  const parts = [
    children
      ? t("「{name}」和底下的 {n} 個子頁面都會從伺服器刪除，大家都看不到了。", { name, n: children })
      : t("「{name}」會從伺服器刪除，大家都看不到了。", { name }),
    editing.length ? t("正在編輯這些頁面的分頁會保留內容，但不能再存回伺服器。") : "",
    t("刪除後只能從 Wiki 儲存庫的修改記錄找回。"),
  ];
  const choice = await choose(t("刪除 Wiki 頁面？"), parts.filter(Boolean).join(currentLang() === "en" ? " " : ""), [
    { id: "delete", label: children ? t("刪除這一頁和子頁面") : t("刪除這一頁"), danger: true },
    { id: "cancel", label: t("取消"), primary: true },
  ]);
  if (choice !== "delete") return;
  await desktop!.adoWikiDelete(wiki, path);
  toast(t("已刪除 Wiki 頁面「{name}」", { name }), { tone: "success" });
  // 開著的是這一頁或子頁面時關閉；圖示列上的捷徑一併拿掉。
  closeItemsWhere((key) => {
    const [kind, id, ...rest] = key.split(":");
    return kind === "wiki" && id === wiki.id && inside(rest.join(":"));
  });
  const left = barShortcuts.filter((s) => isWorkItemShortcut(s) || !(s.wiki === wiki.id && inside(s.path)));
  if (left.length !== barShortcuts.length) setBarShortcuts(left);
  void wikiPanel?.refresh();
}

/** 把分頁的內容存回 Wiki 頁面；伺服器上的版本被別人改過時回傳那個版本（交給衝突處理）。 */
export async function saveWikiPage(text: string, force: boolean): Promise<{ name: string; diskText: string } | void> {
  const doc = app.active;
  const target = doc.wiki!;
  const etag = (force && wikiServerEtag.get(doc.id)) || target.etag;
  const out = await desktop!.adoWikiSave(target, text, etag);
  if (out.status === "conflict") {
    if (out.etag) wikiServerEtag.set(doc.id, out.etag);
    return { name: doc.name, diskText: out.content.replace(/\r\n?/g, "\n") };
  }
  wikiServerEtag.delete(doc.id);
  wikiNewer.delete(doc.id);
  doc.wiki = { ...target, etag: out.etag ?? target.etag };
  storage.save(`wiki-base:${doc.id}`, text);
  app.setBaseline(text, true);
  app.persistSession();
  app.renderTabs();
  renderWikiBar();
  toast(t("已存回 Wiki 頁面「{name}」", { name: pageName(target.path) }), { tone: "success" });
}
