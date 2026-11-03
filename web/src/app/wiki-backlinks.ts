/**
 * 哪些 Wiki 頁面連到這一頁：讀整個 Wiki 的內文（讀過、內容沒變的頁面不再讀），找出連到這一頁的連結。
 * 從 Wiki 樹或 Wiki 頁面分頁的右鍵選單、指令面板開啟；刪除頁面前也會先提醒。
 */
import { type AdoWiki, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { findWikiPage, parseRemoteLink } from "../remote-links.ts";
import { Picker } from "../ui/picker.ts";
import { toast } from "../ui/toast.ts";
import { type Backlink, findBacklinks } from "../wiki-backlinks.ts";
import { flattenPages, pageLinkResolver, pageName } from "../wiki-text.ts";
import { wikiPageTree } from "./ado-links.ts";
import { app } from "./context.ts";

/** 讀得比這個久才顯示「讀取中」的通知（讀過的 Wiki 通常很快）。 */
const PROGRESS_DELAY = 400;

/**
 * 連到 `targets`（頁面路徑）的地方，依頁面樹的順序；`targets` 自己裡面互相連的不算。
 * `skipped` 是讀不到內文的頁面數（清單可能不完整）。
 */
export async function wikiBacklinks(wiki: AdoWiki, targets: string[]): Promise<{ links: Backlink[]; skipped: number }> {
  const [tree, sources] = await Promise.all([wikiPageTree(wiki, true), desktop!.adoWikiSources(wiki)]);
  const pages = flattenPages(tree);
  const local = pageLinkResolver(pages);
  const base = app.ado?.account?.url ?? null;
  const names = new Set([wiki.name.toLowerCase(), wiki.id.toLowerCase()]);
  // 相對、絕對路徑的連結；連到同一個 Wiki 的完整網址（`?pagePath=`、頁面編號）也算。
  const resolve = (href: string, page: string): string | null => {
    const hit = local(href, page);
    if (hit || !base) return hit;
    const link = parseRemoteLink(href, base);
    if (link?.kind !== "wiki" || !names.has(link.wiki.toLowerCase())) return null;
    return link.path ?? findWikiPage(tree, link.pageId, link.slug);
  };
  const order = new Map(pages.map((p, i) => [p.toLowerCase(), i]));
  const rank = (path: string) => order.get(path.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
  const sorted = [...sources.pages].sort((a, b) => rank(a.path) - rank(b.path));
  return {
    links: findBacklinks(
      targets,
      sorted.map((p) => ({ page: p.path, text: p.text })),
      resolve,
    ),
    skipped: sources.skipped,
  };
}

/** 讀得久時顯示 `message`，讀完收起來。 */
async function withProgress<T>(work: Promise<T>, message: string): Promise<T> {
  let note: { dismiss(): void } | null = null;
  const timer = window.setTimeout(() => (note = toast(message, { duration: 180_000 })), PROGRESS_DELAY);
  try {
    return await work;
  } finally {
    clearTimeout(timer);
    (note as { dismiss(): void } | null)?.dismiss();
  }
}

/** 上層頁面的位置（「產品 › 安裝」）；最上層的頁面是空字串。 */
function parentTrail(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -1).join(" › ");
}

let picker: Picker<Backlink> | null = null;
let shown: { wiki: AdoWiki; links: Backlink[] } | null = null;

function backlinkPicker(): Picker<Backlink> {
  picker ??= new Picker<Backlink>({
    label: t("哪些頁面連到這一頁"),
    placeholder: t("輸入頁面名稱或內文"),
    stacked: true,
    empty: t("找不到符合的連結。"),
    query(q) {
      const links = shown?.links ?? [];
      const needle = q.trim().toLowerCase();
      return needle ? links.filter((l) => `${l.page} ${l.text}`.toLowerCase().includes(needle)) : links;
    },
    render: (l) => ({
      title: pageName(l.page),
      detail: [parentTrail(l.page), t("第 {n} 行", { n: l.line }), l.text].filter(Boolean).join("・"),
      icon: "link-2",
    }),
    pick: (l) => {
      if (shown) app.showWikiPage(shown.wiki, l.page);
    },
  });
  return picker;
}

/** 列出連到 `path` 的頁面（點一下開啟那一頁）；沒有的話只提示一下。 */
export async function openWikiBacklinks(wiki: AdoWiki, path: string): Promise<void> {
  const name = pageName(path);
  const { links, skipped } = await withProgress(
    wikiBacklinks(wiki, [path]),
    t("正在找哪些頁面連到「{name}」…（第一次要讀整個 Wiki，會久一點）", { name }),
  );
  const partial = skipped ? t("有 {n} 頁讀不到，清單可能不完整。", { n: skipped }) : "";
  if (!links.length) {
    toast([t("沒有其他頁面連到「{name}」。", { name }), partial].filter(Boolean).join(" "));
    return;
  }
  shown = { wiki, links };
  backlinkPicker().open();
  if (partial) toast(partial);
}

/**
 * 刪除前的提醒：哪些頁面連到 `path` 或它的子頁面（刪除後這些連結會失效）。
 * 等太久（第一次讀整個 Wiki）或讀不到時回傳 null，不擋著刪除。
 */
export async function backlinkWarning(wiki: AdoWiki, path: string, children: string[], wait = 5000): Promise<string | null> {
  const found = wikiBacklinks(wiki, [path, ...children]).catch(() => null);
  const result = await withProgress(
    Promise.race([found, new Promise<null>((r) => setTimeout(() => r(null), wait))]),
    t("正在檢查哪些頁面連到這一頁…"),
  );
  if (!result?.links.length) return null;
  const pages = [...new Set(result.links.map((l) => l.page))];
  const names = pages.slice(0, 3).map((p) => t("「{name}」", { name: pageName(p) }));
  return pages.length > 3
    ? t("有 {n} 個頁面連到這裡（{names}等），刪除後這些連結會失效。", { n: pages.length, names: names.join(t("、")) })
    : t("有 {n} 個頁面連到這裡（{names}），刪除後這些連結會失效。", { n: pages.length, names: names.join(t("、")) });
}
