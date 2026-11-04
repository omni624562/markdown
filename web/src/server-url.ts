/**
 * 網址是不是連到連線中的那台 Azure DevOps／TFS 伺服器。
 *
 * 文件、留言、Wiki 裡貼的網址常和連線設定的寫法不同：http／https、有沒有埠號、只寫電腦名稱（`almsrv01`）
 * 或寫完整名稱（`almsrv01.corp.local`）。主機名稱對得上、路徑在同一個集合底下就算同一台。
 * 要帶權杖去讀的網址一律改用連線設定的伺服器（`root`），權杖不會送到別的地方。
 */

/**
 * 兩個主機名稱是不是同一台伺服器：不分大小寫；一邊只寫電腦名稱、另一邊寫完整名稱也算。
 * 兩邊都是完整名稱時要完全一樣。
 */
export function sameHost(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  if (x.includes(".") === y.includes(".")) return false;
  const [short, full] = x.includes(".") ? [y, x] : [x, y];
  return full.startsWith(`${short}.`);
}

export interface ServerPath {
  /** 連線設定的集合網址（去掉結尾的 `/`）。 */
  root: string;
  /** 集合後面的路徑（`/專案/_wiki/…`，保持網址編碼）。 */
  rest: string;
  /** 查詢字串（含 `?`，沒有就是空字串）。 */
  search: string;
  params: URLSearchParams;
}

/** `href` 在 `base`（集合的網址，例如 `https://tfs/DefaultCollection`）底下的話，拆出集合後面的部分；不是就回傳 null。 */
export function underServer(href: string, base: string): ServerPath | null {
  const root = base.trim().replace(/\/+$/, "");
  let link: URL;
  let server: URL;
  try {
    link = new URL(href.trim());
    server = new URL(root);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(link.protocol) || !sameHost(link.hostname, server.hostname)) return null;
  const collection = server.pathname.replace(/\/+$/, "");
  if (link.pathname.slice(0, collection.length + 1).toLowerCase() !== `${collection.toLowerCase()}/`) return null;
  return { root, rest: link.pathname.slice(collection.length), search: link.search, params: link.searchParams };
}
