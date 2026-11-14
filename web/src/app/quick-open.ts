/**
 * 快速開啟（Ctrl+P、標題列中間的搜尋框）與相關的挑選器：已開啟的分頁、專案裡的檔案、最近開啟的檔案，
 * 連上 Azure DevOps 時還有工作項目（`#編號`、`#關鍵字`，一般搜尋也列出標題符合的幾項）與 Wiki 頁面；
 * 開頭是其他符號時改找別的東西（`>` 指令、`?` 問助理，見 app/title-search.ts 的 `addQuickMode`）。
 * 另外是文件裡 `#123` 的自動完成、插入工作項目／Wiki 頁面連結的挑選器。
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


export interface QuickItem {
  title: string;
  detail: string;
  doc?: Doc;
  path?: string;
  /** 工作項目、Wiki 頁面、指令、問助理：選了之後執行 `open`。 */
  remote?: { icon: string; open(): void };
  /** 右邊的快速鍵（指令）。 */
  keys?: string;
  /** 分區標題（檔案、工作項目、Wiki、助理）。 */
  section?: string;
  /** 還沒輸入時：分在哪一區（已開啟、資料夾名稱、最近開啟），說明欄只寫所在的資料夾（`where`）。 */
  group?: string;
  where?: string;
}

/** 開頭是特定符號時改找別的東西（`>` 指令、`?` 問助理）。 */
export interface QuickMode {
  /** 開頭的符號；全形的也算（輸入法開著時打出來的）。第一個顯示在提示列上。 */
  prefixes: string[];
  /** 提示列上的說明（「指令」「問助理」）。 */
  tip: string;
  /** 符號後面還沒輸入、或找不到東西時的說明。 */
  empty: string;
  available(): boolean;
  query(text: string): QuickItem[];
  /** 一般搜尋（沒有符號）時接在最後的項目（例如「問助理：…」）。 */
  fallback?(text: string): QuickItem[];
}

const quickModes: QuickMode[] = [];

export function addQuickMode(mode: QuickMode): void {
  quickModes.push(mode);
}

/** 連上 Azure DevOps（`#` 找工作項目）。 */
const adoOn = () => !!desktop && !!app.ado?.account;

/** 開頭的符號（`#`（連上 Azure DevOps 時）或某個模式的符號）與後面的字；沒有符號時 `prefix` 是空字串。 */
function splitPrefix(q: string): { prefix: string; mode?: number; rest: string } {
  const text = q.trimStart();
  if (adoOn() && /^[#＃]/.test(text)) return { prefix: "#", rest: text.slice(1) };
  const modes = quickModes;
  const i = modes.findIndex((m) => m.prefixes.some((p) => text.startsWith(p)));
  if (i < 0) return { prefix: "", rest: q };
  const p = modes[i].prefixes.find((x) => text.startsWith(x))!;
  return { prefix: modes[i].prefixes[0], mode: i, rest: text.slice(p.length) };
}

let quickRemoteSeq = 0;
/** 最近一次的查詢字串（找不到東西時的說明依它而定）。 */
let lastQuery = "";

/** 工作項目的一行：標題，說明是類型、編號與狀態。 */
const workItemRow = (w: AdoWorkItem, section?: string): QuickItem => ({
  title: w.title,
  detail: [`${w.kind} ${w.id}`, w.state].join("・"),
  remote: { icon: "square-kanban", open: () => showWorkItem(w) },
  section,
});

/** 打字停一下才向伺服器查詢工作項目的標題，免得每個字都查一次；查詢字串又改了就回傳 null。 */
async function searchWorkItems(text: string): Promise<AdoWorkItem[] | null> {
  const seq = ++quickRemoteSeq;
  await new Promise((r) => setTimeout(r, 300));
  if (seq !== quickRemoteSeq || !desktop) return null;
  const found = await desktop.adoWorkItems(text, { ...DEFAULT_WORK_ITEM_FILTER, person: "", state: "all" }).catch(() => [] as AdoWorkItem[]);
  return seq === quickRemoteSeq ? found : null;
}

/**
 * Ctrl+P 裡 `#` 開頭（連上 Azure DevOps 時）：`#123` 直接開啟那個工作項目，`#文字` 搜尋工作項目的標題。
 */
export async function quickRemoteItems(q: string): Promise<QuickItem[]> {
  const text = q.trim().replace(/^＃/, "#");
  if (!desktop || !app.ado?.account || !text.startsWith("#")) return [];
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
  return ((await searchWorkItems(rest)) ?? []).slice(0, 30).map((w) => workItemRow(w));
}

/** 目前 Wiki（Wiki 面板選的那個）的所有頁面（連上 Azure DevOps 時）。清單在背景讀取，讀到之前是空的。 */
async function quickWikiPages(wait: number): Promise<QuickItem[]> {
  if (!desktop || !app.ado?.account) return [];
  if (!app.wikiListCache) {
    app.wikiListCache = desktop.adoWikis();
    app.wikiListCache.catch(() => (app.wikiListCache = null));
  }
  const wikis = await soon(app.wikiListCache, wait);
  const id = wikiPanel?.wiki?.id ?? storage.load("ado-wiki");
  const wiki = wikis?.find((w) => w.id === id) ?? wikis?.[0];
  if (!wiki) return [];
  let pages = wikiPagesCache.get(wiki.id);
  if (!pages) {
    pages = desktop.adoWikiPages(wiki);
    wikiPagesCache.set(wiki.id, pages);
    pages.catch(() => wikiPagesCache.delete(wiki.id));
  }
  const paths = flattenPages((await soon(pages, wait)) ?? []);
  return paths.map((path) => ({
    title: pageName(path),
    detail: t("Wiki・{where}", { where: [wiki.name, path.slice(1, path.lastIndexOf("/"))].filter(Boolean).join(" › ") }),
    remote: { icon: "book-open-text", open: () => showWikiPage(wiki, path) },
    section: "Wiki",
  }));
}

/** 依符合程度排序（名稱符合的比只有說明符合的前面）。 */
function ranked(q: string, items: QuickItem[], limit: number): QuickItem[] {
  return items
    .map((it) => ({ it, score: Math.max(fuzzyScore(q, it.title) * 2, fuzzyScore(q, `${it.detail}/${it.title}`)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.it);
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

/** 搜尋框下面「也可以：」那一列的符號。 */
function quickTips(): { prefix: string; label: string }[] {
  return [
    ...(adoOn() ? [{ prefix: "#", label: t("工作項目") }] : []),
    ...quickModes.filter((m) => m.available()).map((m) => ({ prefix: m.prefixes[0], label: m.tip })),
  ];
}

export const quickOpen = new Picker<QuickItem>({
  label: t("快速開啟"),
  placeholder: desktop ? t("輸入檔名、Wiki 頁面，或 #編號 開啟工作項目") : t("輸入檔名切換分頁"),
  empty: () => {
    const { prefix, mode, rest } = splitPrefix(lastQuery);
    if (mode !== undefined) return quickModes[mode].empty;
    if (prefix === "#") return rest.trim() ? t("找不到符合的工作項目") : t("輸入工作項目的編號或標題");
    return t("找不到符合的檔案");
  },
  top: true,
  detailColumn: true,
  tips: quickTips,
  async query(q, more) {
    lastQuery = q;
    const { prefix, mode, rest } = splitPrefix(q);
    if (mode !== undefined) return quickModes[mode].available() ? quickModes[mode].query(rest) : [];
    // `#…` 只找工作項目（伺服器已經依相關程度排序）。
    if (prefix === "#") return quickRemoteItems(q);
    app.stash();
    // 已開啟的分頁優先（工作項目等的分頁也算），目前分頁放最後（按 Enter 不會停在原地）。
    const current = selectedItemId();
    const openItems = itemTabs.filter((tab) => tab.id !== current);
    const opened = t("已開啟");
    const docWhere = (d: Doc) => (d.path ? displayPath(dirname(d.path)) : "");
    const items: QuickItem[] = [
      ...app.docs
        .filter((d) => d !== app.active || current)
        .map((d) => ({ title: docName(d), detail: opened, doc: d, group: opened, where: docWhere(d) })),
      ...openItems.map((tab) => ({ title: tab.name, detail: opened, remote: { icon: tab.icon, open: () => selectItem(tab.id) }, group: opened, where: "" })),
      ...(current ? [] : [{ title: docName(app.active), detail: t("目前分頁"), doc: app.active, group: opened }]),
    ];
    const seen = new Set(app.docs.map((d) => d.path).filter(Boolean));
    if (desktop) {
      if (app.workspaceRoot) {
        app.fileListCache ??= await desktop.listFiles(app.workspaceRoot.path).catch(() => []);
        for (const f of app.fileListCache) {
          if (seen.has(f.path)) continue;
          seen.add(f.path);
          const dir = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
          items.push({ title: basename(f.path), detail: dir || app.workspaceRoot.name, path: f.path, group: app.workspaceRoot.name, where: dir });
        }
      }
      const { files } = await desktop.recent().catch(() => ({ files: [] as string[] }));
      for (const path of files) {
        if (seen.has(path)) continue;
        seen.add(path);
        const where = displayPath(dirname(path));
        items.push({ title: basename(path), detail: t("最近開啟 · {dir}", { dir: where }), path, group: t("最近開啟"), where });
      }
    }
    // 還沒輸入：分成已開啟、這個資料夾、最近開啟三區，說明欄只寫所在的資料夾（不用每一行都寫「最近開啟」）。
    if (!q.trim()) return items.slice(0, 200).map((it) => ({ ...it, section: it.group, detail: it.where ?? it.detail }));
    // 有輸入時分區：檔案、工作項目、Wiki、最後是「問助理：…」這類項目。
    // 工作項目要問伺服器、Wiki 頁面清單可能還在讀：先列出檔案與已經讀到的，查到後補上（`more`）。
    const files = ranked(q, items, 200).map((it) => ({ ...it, section: t("檔案") }));
    const tail = quickModes.filter((m) => m.available() && m.fallback).flatMap((m) => m.fallback!(q));
    const wikiNow = ranked(q, await quickWikiPages(150), 50);
    if (adoOn()) {
      void Promise.all([q.trim().length >= 2 ? searchWorkItems(q.trim()) : Promise.resolve([]), quickWikiPages(5000)]).then(([found, pages]) => {
        if (found === null) return; // 查詢字串已經改了
        const work = found.slice(0, 5).map((w) => workItemRow(w, t("工作項目")));
        more([...files, ...work, ...ranked(q, pages, 50), ...tail]);
      });
    }
    return [...files, ...wikiNow, ...tail];
  },
  render: (it) => ({ title: it.title, detail: it.detail, icon: it.remote?.icon ?? (it.doc ? "file-text" : "file"), keys: it.keys, section: it.section }),
  pick: (it) => (it.remote ? it.remote.open() : it.doc ? app.activate(it.doc) : void openPath(it.path!).catch(reportError)),
});
