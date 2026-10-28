/** 文件裡連到 Azure DevOps 工作項目、Wiki 頁面的網址：辨認種類、找出游標所在的連結（不碰畫面，方便測試）。 */

export type RemoteLink =
  | { kind: "workitem"; id: number }
  | {
      kind: "wiki";
      /** 網址裡的 Wiki 名稱或編號（例如 `產品.wiki`）。 */
      wiki: string;
      /** `?pagePath=` 帶的頁面路徑。 */
      path: string | null;
      /** 瀏覽器網址列上的頁面編號（`/_wiki/wikis/產品.wiki/12/安裝-說明`）。 */
      pageId: number | null;
      /** 編號後面的頁面名稱（`-` 是空白）。 */
      slug: string | null;
    };

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * `href` 是不是連線中那台伺服器（`base` 是集合的網址，例如 `https://tfs/DefaultCollection`）
 * 上的工作項目或 Wiki 頁面；不是就回傳 null。
 */
export function parseRemoteLink(href: string, base: string): RemoteLink | null {
  const root = base.trim().replace(/\/+$/, "");
  const url = href.trim();
  if (!root || url.slice(0, root.length + 1).toLowerCase() !== `${root.toLowerCase()}/`) return null;
  const rest = url.slice(root.length);
  const item = /\/_workitems\/edit\/(\d+)\/?(?:[?#]|$)/i.exec(rest);
  if (item) return { kind: "workitem", id: Number(item[1]) };
  const wiki = /\/_wiki\/wikis\/([^/?#]+)(?:\/(\d+)(?:\/([^?#]*))?)?\/?(?:\?([^#]*))?(?:#|$)/i.exec(rest);
  if (!wiki) return null;
  const query = new URLSearchParams(wiki[4] ?? "");
  const pagePath = query.get("pagePath");
  return {
    kind: "wiki",
    wiki: decode(wiki[1]),
    path: pagePath ? (pagePath.startsWith("/") ? pagePath : `/${pagePath}`) : null,
    pageId: wiki[2] ? Number(wiki[2]) : null,
    // 網址裡 `-` 代表空白、`%2D` 才是真的 `-`，所以先換再解碼。
    slug: wiki[3] ? decode(wiki[3].replace(/-/g, " ")) : null,
  };
}

/** 一行文字裡 `offset` 所在的網址：Markdown 連結 `[文字](網址)`、`(<網址>)`，或直接寫的網址。 */
export function urlAt(line: string, offset: number): { from: number; to: number; url: string } | null {
  const patterns = [/\[[^\]\n]*\]\(<([^>\n]+)>[^)\n]*\)/g, /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g, /<?(https?:\/\/[^\s<>)\]。，、；：！？「」（）]+)>?/g];
  for (const re of patterns) {
    for (const m of line.matchAll(re)) {
      const from = m.index;
      const to = from + m[0].length;
      if (offset >= from && offset <= to) return { from, to, url: m[1] };
    }
  }
  return null;
}

/** 頁面樹裡編號是 `id` 的頁面；沒有編號時依頁面名稱（`slug`）找，找不到回傳 null。 */
export function findWikiPage(
  pages: { path: string; id?: number | null; children: unknown[] }[],
  id: number | null,
  slug: string | null,
): string | null {
  type Page = { path: string; id?: number | null; children: Page[] };
  const all: Page[] = [];
  const walk = (list: Page[]) => {
    for (const p of list) {
      all.push(p);
      walk(p.children);
    }
  };
  walk(pages as Page[]);
  if (id !== null) {
    const byId = all.find((p) => p.id === id);
    if (byId) return byId.path;
  }
  if (!slug) return null;
  const name = slug.trim().toLowerCase();
  const byName = all.find((p) => (p.path.split("/").pop() ?? "").toLowerCase() === name);
  return byName?.path ?? null;
}
