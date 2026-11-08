/**
 * 快速開啟（Ctrl+P）與相關的挑選器：已開啟的分頁、專案裡的檔案、最近開啟的檔案，連上 Azure DevOps 時還有
 * 工作項目（`#編號`、`#關鍵字`）與 Wiki 頁面；另外是文件裡 `#123` 的自動完成、插入工作項目／Wiki 頁面連結的挑選器。
 * 從 main.ts 拆出來，透過 `app` 取用目前的分頁與快取。
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { workItemLink } from "../ado-text.ts";
import { fuzzyScore } from "../commands.ts";
import { type AdoWorkItem, desktop, displayPath } from "../desktop.ts";
import { t } from "../i18n.ts";
import { type RemotePage, encodeLinkPath } from "../link-complete.ts";
import type { Doc } from "../main.ts";
import { basename, dirname } from "../paths.ts";
import * as storage from "../storage.ts";
import { Picker } from "../ui/picker.ts";
import { toast } from "../ui/toast.ts";
import { flattenPages, pageName, wikiPageLink, wikiPageUrl } from "../wiki-text.ts";
import { DEFAULT_WORK_ITEM_FILTER } from "../work-item-filter.ts";
import { insertIssueLink, peekWorkItem, wikiPagesCache } from "./ado-links.ts";
import { app } from "./context.ts";
import { docName } from "./doc-names.ts";
import { reportError } from "./git-actions.ts";
import { insertAtCursor } from "./image-paste.ts";
import { itemTabs, selectItem, selectedItemId } from "./item-tabs.ts";
import { showWikiPage } from "./wiki-edit.ts";
import { showWorkItem } from "./work-item-actions.ts";
import { wikiPanel } from "./work-items-panel.ts";
import { openPath } from "./workspace-ui.ts";


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
export async function quickRemoteItems(q: string): Promise<QuickItem[]> {
  const text = q.trim();
  if (!desktop || !app.ado?.account || !text) return [];
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
  if (!app.wikiListCache) {
    app.wikiListCache = desktop.adoWikis();
    app.wikiListCache.catch(() => (app.wikiListCache = null));
  }
  const wikis = await soon(app.wikiListCache);
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
export async function wikiLinkPages(wait = 150): Promise<RemotePage[]> {
  if (!desktop || !app.ado?.account) return [];
  if (!app.wikiListCache) {
    app.wikiListCache = desktop.adoWikis();
    app.wikiListCache.catch(() => (app.wikiListCache = null));
  }
  const wikis = await soon(app.wikiListCache, wait);
  const target = app.active.wiki;
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
export async function workItemIdCompletion(ctx: CompletionContext): Promise<CompletionResult | null> {
  if (!desktop || !app.ado?.account) return null;
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
export const workItemLinkPicker = new Picker<AdoWorkItem>({
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
export const wikiLinkPicker = new Picker<RemotePage>({
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
export function soon<T>(p: Promise<T>, ms = 150): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** 依編號開啟工作項目（讀不到時提示）。 */
export async function openWorkItemById(id: number): Promise<void> {
  try {
    showWorkItem(await peekWorkItem(id));
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

export const quickOpen = new Picker<QuickItem>({
  label: t("快速開啟"),
  placeholder: desktop ? t("輸入檔名、Wiki 頁面，或 #編號 開啟工作項目") : t("輸入檔名切換分頁"),
  empty: t("找不到符合的檔案"),
  async query(q) {
    app.stash();
    // 已開啟的分頁優先（工作項目等的分頁也算），目前分頁放最後（按 Enter 不會停在原地）。
    const current = selectedItemId();
    const openItems = itemTabs.filter((tab) => tab.id !== current);
    const items: QuickItem[] = [
      ...app.docs.filter((d) => d !== app.active || current).map((d) => ({ title: docName(d), detail: t("已開啟"), doc: d })),
      ...openItems.map((tab) => ({ title: tab.name, detail: t("已開啟"), remote: { icon: tab.icon, open: () => selectItem(tab.id) } })),
      ...(current ? [] : [{ title: docName(app.active), detail: t("目前分頁"), doc: app.active }]),
    ];
    const seen = new Set(app.docs.map((d) => d.path).filter(Boolean));
    if (desktop) {
      if (app.workspaceRoot) {
        app.fileListCache ??= await desktop.listFiles(app.workspaceRoot.path).catch(() => []);
        for (const f of app.fileListCache) {
          if (seen.has(f.path)) continue;
          seen.add(f.path);
          const dir = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
          items.push({ title: basename(f.path), detail: dir || app.workspaceRoot.name, path: f.path });
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
  pick: (it) => (it.remote ? it.remote.open() : it.doc ? app.activate(it.doc) : void openPath(it.path!).catch(reportError)),
});
