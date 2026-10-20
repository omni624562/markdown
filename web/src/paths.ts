/**
 * 處理桌面版傳來的檔案路徑。Windows 用 `\`、其他系統用 `/`，這裡兩種都接受，
 * 並沿用路徑原本的分隔符號。
 */

function separator(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

/** 路徑所在的資料夾；沒有上層時回傳空字串。 */
export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return "";
  // 保留根目錄本身的分隔符號（`/`、`C:\`）。
  return i === 0 || (i === 2 && path[1] === ":") ? path.slice(0, i + 1) : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** `path` 是 `dir` 本身或位於其中。 */
export function isInside(path: string, dir: string): boolean {
  if (path === dir) return true;
  const sep = separator(dir);
  return path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** 把 `path` 開頭的 `from` 換成 `to`（資料夾改名後更新底下檔案的路徑）。 */
export function rebase(path: string, from: string, to: string): string | null {
  return isInside(path, from) ? to + path.slice(from.length) : null;
}

/** 以 `dir` 為起點解析相對路徑（可含 `./`、`../`，分隔符號可用 `/` 或 `\`）。 */
export function resolvePath(dir: string, relative: string): string {
  const sep = separator(dir);
  const parts = dir.split(/[\\/]/);
  if (parts.length > 1 && parts.at(-1) === "") parts.pop();
  for (const seg of relative.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // 不要退到根目錄（`/` 或 `C:`）之外。
      if (parts.length > 1) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  const joined = parts.join(sep);
  return parts.length === 1 ? joined + sep : joined;
}

/** 本機絕對路徑（`C:\…`、`\\nas\…`、`/home/…`）。 */
export function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

/**
 * 預覽中的圖片網址若是相對於文件的路徑，回傳解析後的本機路徑；
 * 網址（http:、data: 等）、頁內錨點則回傳 null。
 */
export function localImagePath(src: string, docDir: string): string | null {
  if (!src || src.startsWith("#") || src.startsWith("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURI(src);
  } catch {
    decoded = src;
  }
  if (/^[a-zA-Z]:[\\/]/.test(decoded) || decoded.startsWith("\\\\")) return decoded;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return null;
  if (decoded.startsWith("/")) return null; // 網站根目錄的路徑，對本機文件沒有意義
  // 去掉查詢字串與錨點。
  return resolvePath(docDir, decoded.replace(/[?#].*$/, ""));
}

/** Markdown 連結網址：含空白或括號時用 `<…>` 包起來。 */
export function markdownUrl(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url;
}
