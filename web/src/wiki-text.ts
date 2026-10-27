/** Azure DevOps Wiki 的文字處理：頁面連結、圖片路徑與 Wiki 特有的語法（不碰畫面，方便測試）。 */

/** 頁面名稱（路徑最後一段）。 */
export function pageName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "/";
}

/** 依 `.`、`..` 整理路徑（結果以 `/` 開頭，不以 `/` 結尾）。 */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

/** 不是 Wiki 裡的連結（網址、mailto:、data: 等）。 */
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Wiki 內文的連結指到哪一頁：連結裡的 `-` 代表空白、`%2D` 才是真的 `-`，可以省略或加上 `.md`；
 * 相對路徑以目前頁面所在的資料夾為準。找不到這一頁（或不是頁面連結）時回傳 null。
 */
export function resolvePageLink(href: string, current: string, pages: Iterable<string>): string | null {
  const raw = href.trim().split(/[?#]/)[0];
  if (!raw || EXTERNAL.test(raw)) return null;
  const byLower = new Map<string, string>();
  for (const p of pages) byLower.set(p.toLowerCase(), p);
  // 先照 Wiki 的規則（`-` 是空白），找不到再照字面（有人手寫 `a-b`）。
  for (const text of [raw.replace(/-/g, " "), raw]) {
    let path: string;
    try {
      path = decodeURIComponent(text).replace(/\.md$/i, "");
    } catch {
      return null;
    }
    const target = normalize(path.startsWith("/") ? path : `${parentOf(current)}/${path}`);
    const found = byLower.get(target.toLowerCase());
    if (found) return found;
  }
  return null;
}

/** 頁面路徑在 Git 儲存庫裡的資料夾名稱：`-` 寫成 `%2D`、空白寫成 `-`。 */
function gitSegment(name: string): string {
  return name.replace(/-/g, "%2D").replace(/ /g, "-");
}

/** 把 `/a/b` 接到 `base` 後面。 */
function join(base: string, path: string): string {
  return normalize(`${base}/${path}`);
}

/**
 * 內文裡的圖片在 Wiki 儲存庫裡的路徑（`/.attachments/…` 或相對於頁面的路徑）；網址、data: 等回傳 null。
 * `mappedPath` 是程式碼 Wiki 在儲存庫裡的資料夾（專案 Wiki 是 `/`）。
 */
export function imageRepoPath(src: string, page: string, mappedPath: string): string | null {
  const raw = src.trim().split(/[?#]/)[0];
  if (!raw || EXTERNAL.test(raw)) return null;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (path.startsWith("/")) return join(mappedPath, path);
  const folder = parentOf(page).split("/").filter(Boolean).map(gitSegment).join("/");
  return join(join(mappedPath, folder), path);
}

/**
 * 把 Wiki 特有的語法改成一般的 Markdown：
 * 拿掉 `[[_TOC_]]`、`[[_TOSP_]]`；`::: mermaid` 改成程式碼區塊；圖片的 ` =300x200` 改成說明文字結尾的 `|300`。
 */
export function wikiMarkdown(text: string): string {
  return text
    .replace(/^[ \t]*\[\[_(TOC|TOSP)_\]\][ \t]*$/gim, "")
    .replace(/^:::[ \t]*mermaid[ \t]*\n([\s\S]*?)^:::[ \t]*$/gim, "```mermaid\n$1```")
    .replace(/!\[([^\]\n]*)\]\(([^)\s]+)[ \t]+=(\d{1,4})?x?(\d{1,4})?\)/g, (_m, alt: string, url: string, w?: string, h?: string) =>
      w ? `![${alt}|${w}${h ? `x${h}` : ""}](${url})` : `![${alt}](${url})`,
    );
}

/** 把頁面樹攤平成所有頁面的路徑。 */
export function flattenPages(pages: { path: string; children: { path: string; children: unknown[] }[] }[]): string[] {
  const out: string[] = [];
  const walk = (list: typeof pages) => {
    for (const p of list) {
      out.push(p.path);
      walk(p.children as typeof pages);
    }
  };
  walk(pages);
  return out;
}

/** 插入文件用的頁面連結：`[頁面名稱](網址)`。 */
export function wikiPageLink(title: string, url: string): string {
  const text = title.replace(/[\\[\]]/g, "\\$&").replace(/\s+/g, " ").trim();
  const href = url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return `[${text}](${href})`;
}
