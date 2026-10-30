/**
 * 文件裡連到 Azure DevOps 的連結：滑鼠移上去顯示摘要，點一下在 oMarker 開啟。
 */
import { workItemLink } from "../ado-text.ts";
import { setBounded } from "../bounded.ts";
import { desktop, type AdoWorkItemDetail, type AdoWiki, type AdoWikiPage } from "../desktop.ts";
import { t } from "../i18n.ts";
import { type RemoteLink, parseRemoteLink, findWikiPage } from "../remote-links.ts";
import { icon } from "../ui/icons.ts";
import { shortDate, type IssueSummary } from "../ui/issues-panel.ts";
import { toast } from "../ui/toast.ts";
import { pageName } from "../wiki-text.ts";
import { insertAtCursor } from "./image-paste.ts";
import { app } from "./context.ts";


/** `href` 是連線中那台伺服器上的工作項目或 Wiki 頁面嗎。 */
export function remoteLinkOf(href: string): RemoteLink | null {
  const base = app.ado?.account?.url;
  return desktop && base ? parseRemoteLink(href, base) : null;
}

/** 讀過的工作項目（摘要卡片、開啟共用；一分鐘內不重新讀取）。 */
const workItemPeek = new Map<number, { at: number; item: Promise<AdoWorkItemDetail> }>();
export function peekWorkItem(id: number): Promise<AdoWorkItemDetail> {
  const hit = workItemPeek.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.item;
  const item = desktop!.adoWorkItem(id);
  setBounded(workItemPeek, id, { at: Date.now(), item }, 200);
  item.catch(() => workItemPeek.delete(id));
  return item;
}

export const wikiPagesCache = new Map<string, Promise<AdoWikiPage[]>>();

/** Wiki 網址指到哪個 Wiki 的哪一頁（依 `?pagePath=`、頁面編號或名稱）；找不到回傳 null。 */
async function resolveWikiLink(link: Extract<RemoteLink, { kind: "wiki" }>): Promise<{ wiki: AdoWiki; path: string } | null> {
  if (!app.wikiListCache) {
    app.wikiListCache = desktop!.adoWikis();
    app.wikiListCache.catch(() => (app.wikiListCache = null));
  }
  const name = link.wiki.toLowerCase();
  const wiki = (await app.wikiListCache).find((w) => w.name.toLowerCase() === name || w.id.toLowerCase() === name);
  if (!wiki) return null;
  if (link.path) return { wiki, path: link.path };
  let pages = wikiPagesCache.get(wiki.id);
  if (!pages) {
    pages = desktop!.adoWikiPages(wiki);
    wikiPagesCache.set(wiki.id, pages);
    pages.catch(() => wikiPagesCache.delete(wiki.id));
  }
  const path = findWikiPage(await pages, link.pageId, link.slug);
  return path ? { wiki, path } : null;
}

/** 在 oMarker 裡開啟連到工作項目、Wiki 頁面的連結；不是這類連結或讀不到時回傳 false（交給瀏覽器）。 */
export async function openRemoteLink(href: string): Promise<boolean> {
  const link = remoteLinkOf(href);
  if (!link) return false;
  try {
    if (link.kind === "workitem") {
      app.showWorkItem(await peekWorkItem(link.id));
      return true;
    }
    const target = await resolveWikiLink(link);
    if (!target) return false;
    app.showWikiPage(target.wiki, target.path);
    return true;
  } catch {
    return false;
  }
}

/** 連結的摘要卡片：工作項目的類型、標題、狀態、指派給誰；Wiki 頁面的名稱與位置。 */
export function remoteCard(link: RemoteLink, hint: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "remote-card";
  card.dataset.source = link.kind === "workitem" ? "ado" : "wiki";
  const source = document.createElement("div");
  source.className = "remote-card-source";
  const title = document.createElement("div");
  title.className = "remote-card-title";
  const meta = document.createElement("div");
  meta.className = "remote-card-meta";
  const tip = document.createElement("div");
  tip.className = "remote-card-hint";
  tip.textContent = hint;
  card.append(source, title, meta, tip);
  const failed = (e: unknown) => {
    meta.textContent = e instanceof Error ? e.message : String(e);
    meta.classList.add("remote-card-error");
  };
  if (link.kind === "workitem") {
    source.append(icon("square-kanban"), t("Azure DevOps 工作項目"));
    title.textContent = t("讀取中…");
    peekWorkItem(link.id)
      .then((d) => {
        source.replaceChildren(icon("square-kanban"), `${d.kind} ${d.id}`);
        title.textContent = d.title;
        meta.textContent = [d.state, d.assignedTo ?? t("沒有指派"), shortDate(d.changed)].filter(Boolean).join("・");
      })
      .catch(failed);
  } else {
    source.append(icon("book-open-text"), link.wiki);
    title.textContent = link.path ? pageName(link.path) : (link.slug ?? link.wiki);
    resolveWikiLink(link)
      .then((target) => {
        if (!target) return failed(t("在這個 Wiki 裡找不到這一頁"));
        source.replaceChildren(icon("book-open-text"), target.wiki.name);
        title.textContent = pageName(target.path);
        meta.textContent = target.path;
      })
      .catch(failed);
  }
  return card;
}

// 預覽裡的連結也一樣：滑鼠停一下顯示摘要卡片。
let previewCard: { link: HTMLAnchorElement; card: HTMLElement | null; timer: number } | null = null;
function hidePreviewCard(): void {
  if (!previewCard) return;
  clearTimeout(previewCard.timer);
  previewCard.card?.remove();
  previewCard = null;
}

/** 插入 `[#123 標題](網址)` 到游標位置。 */
export function insertIssueLink(item: Pick<IssueSummary, "id" | "title" | "webUrl">): void {
  insertAtCursor(workItemLink(item));
  toast(t("已插入「#{id}」的連結", { id: item.id }));
}

export function initAdoLinks(): void {
  app.previewEl.addEventListener("mouseover", (e) => {
    const a = (e.target as Element).closest?.<HTMLAnchorElement>("a[href]");
    if (a === previewCard?.link) return;
    hidePreviewCard();
    const link = a && remoteLinkOf(a.getAttribute("href") ?? "");
    if (!a || !link) return;
    const state: { link: HTMLAnchorElement; card: HTMLElement | null; timer: number } = { link: a, card: null, timer: 0 };
    state.timer = window.setTimeout(() => {
      if (!a.isConnected) return;
      const card = remoteCard(link, t("點一下在 oMarker 開啟"));
      card.classList.add("remote-card-floating");
      document.body.append(card);
      const r = a.getBoundingClientRect();
      const h = card.offsetHeight;
      const top = r.top - h - 6 >= 0 ? r.top - h - 6 : r.bottom + 6;
      card.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - card.offsetWidth - 8))}px`;
      card.style.top = `${top}px`;
      state.card = card;
    }, 400);
    previewCard = state;
  });
  app.previewEl.addEventListener("mouseleave", hidePreviewCard);
  app.previewEl.addEventListener("scroll", hidePreviewCard, { passive: true });
  app.previewEl.addEventListener("click", hidePreviewCard);
}
