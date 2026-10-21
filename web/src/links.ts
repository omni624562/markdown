/**
 * 文件互連：`[[文件]]` 找出對應的檔案、列出反向連結，以及檔案改名後更新其他文件中的連結。
 * `[[週報]]` 和 Obsidian 一樣用檔名找（不分大小寫、不用寫 .md），同名時優先找同一個資料夾的。
 */
import type { LinkRef } from "./doc-index.ts";
import { basename, dirname, relativePath, resolvePath } from "./paths.ts";

export interface FileRef {
  path: string;
  /** 相對於資料夾、以 `/` 分隔的路徑。 */
  rel: string;
}

const MD = /\.(md|markdown)$/i;
const windowsPath = (p: string) => /^[a-zA-Z]:|^\\\\/.test(p) || p.includes("\\");

/** 同一個檔案（分隔符號不同、Windows 不分大小寫也算）。 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return windowsPath(p) ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/** `[[target]]` 對應的檔案路徑；找不到時回傳 null。 */
export function resolveWiki(target: string, files: readonly FileRef[], fromDir: string | null): string | null {
  let t = target.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!t) return null;
  if (!MD.test(t)) t += ".md";
  const want = t.toLowerCase();
  const stem = (rel: string) => rel.toLowerCase().replace(MD, "");
  // 寫了資料夾（[[筆記/想法]]）要完全符合；只寫檔名時找所有同名的檔案。.md 與 .markdown 都算。
  const pool = files.filter((f) =>
    want.includes("/")
      ? stem(f.rel) === stem(want)
      : stem(f.rel) === stem(want) || stem(f.rel).endsWith(`/${stem(want)}`),
  );
  if (!pool.length) return null;
  if (fromDir) {
    const near = pool.find((f) => samePath(dirname(f.path), fromDir));
    if (near) return near.path;
  }
  return [...pool].sort((a, b) => a.rel.split("/").length - b.rel.split("/").length || a.rel.length - b.rel.length)[0].path;
}

/** 連結指向的檔案（只認 Markdown 文件）。 */
export function linkTarget(link: LinkRef, docPath: string | null, files: readonly FileRef[]): string | null {
  if (link.kind === "wiki") return resolveWiki(link.target, files, docPath ? dirname(docPath) : null);
  if (!docPath || !MD.test(link.target)) return null;
  return resolvePath(dirname(docPath), link.target);
}

export interface Backlink<D> {
  doc: D;
  /** 連結所在的行（從 1 開始）。 */
  lines: number[];
}

/** 哪些文件連到 `target`。 */
export function backlinks<D extends { path: string | null; info: { links: LinkRef[] } }>(
  target: string,
  docs: readonly D[],
  files: readonly FileRef[],
): Backlink<D>[] {
  const out: Backlink<D>[] = [];
  for (const doc of docs) {
    if (doc.path && samePath(doc.path, target)) continue;
    const lines = doc.info.links.filter((l) => {
      const p = linkTarget(l, doc.path, files);
      return p !== null && samePath(p, target);
    });
    if (lines.length) out.push({ doc, lines: [...new Set(lines.map((l) => l.line))] });
  }
  return out;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const WIKI = /\[\[([^[\]|#\n]+)((?:#[^[\]|\n]*)?(?:\|[^[\]\n]*)?)\]\]/g;
const MD_LINK = /(!?\[[^\]\n]*\]\(\s*<?)([^)\s>]+)(>?(?:\s+"[^"\n]*")?\s*\))/g;

/**
 * 改寫文件中的連結目標（程式碼裡的不動）。`fn` 收到連結，回傳新的目標；回傳 null 表示不改。
 * Markdown 連結的目標是原始寫法（可能是 %XX 編碼），`[[ ]]` 的是 `#` 與 `|` 前面的部分。
 */
export function rewriteLinks(text: string, fn: (kind: LinkRef["kind"], target: string) => string | null): string {
  let fence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const f = line.match(FENCE);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
        return line;
      }
      if (f) {
        fence = f[1];
        return line;
      }
      // 行內程式碼的位置
      const code: [number, number][] = [];
      for (const m of line.matchAll(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) code.push([m.index, m.index + m[0].length]);
      const inCode = (i: number) => code.some(([a, b]) => i >= a && i < b);
      line = line.replace(WIKI, (all, target: string, rest: string, at: number) => {
        if (inCode(at)) return all;
        const next = fn("wiki", target);
        return next === null ? all : `[[${next}${rest}]]`;
      });
      return line.replace(MD_LINK, (all, head: string, href: string, tail: string, at: number) => {
        if (inCode(at) || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return all;
        const next = fn("markdown", href);
        return next === null ? all : head + next + tail;
      });
    })
    .join("\n");
}

/**
 * 檔案搬移或改名後（`moved` 回傳檔案的新路徑，沒動的回傳 null），更新 `docPath` 這份文件中指向它們的連結。
 * 沒有要改的時候回傳 null。
 */
export function renameLinks(
  text: string,
  docPath: string,
  files: readonly FileRef[],
  moved: (path: string) => string | null,
): string | null {
  const dir = dirname(docPath);
  const next = rewriteLinks(text, (kind, target) => {
    if (kind === "wiki") {
      const old = resolveWiki(target, files, dir);
      const to = old && moved(old);
      if (!to) return null;
      const name = basename(to);
      const keepExt = MD.test(target.trim());
      const label = keepExt ? name : name.replace(MD, "");
      // 原本寫了資料夾（[[筆記/想法]]）就寫新的相對路徑，否則只寫檔名。
      if (target.includes("/")) {
        const ref = files.find((f) => samePath(f.path, old));
        const rel = ref ? rebaseRel(ref.rel, old, to) : name;
        return keepExt ? rel : rel.replace(MD, "");
      }
      return label;
    }
    let decoded = target.split("#")[0];
    const hash = target.slice(decoded.length);
    const encoded = /%[0-9a-f]{2}/i.test(decoded);
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // 照原樣
    }
    if (!MD.test(decoded)) return null;
    const old = resolvePath(dir, decoded);
    const to = moved(old);
    if (!to) return null;
    const rel = relativePath(dir, to);
    if (rel === null) return null;
    const out = encoded ? encodeURI(rel) : rel;
    return (/[\s()<>]/.test(out) ? encodeURI(out) : out) + hash;
  });
  return next === text ? null : next;
}

/** 檔案的新位置相對於資料夾的路徑（資料夾根目錄 = 舊路徑去掉 `oldRel` 的部分）。 */
function rebaseRel(oldRel: string, oldPath: string, newPath: string): string {
  const rootLen = oldPath.replace(/\\/g, "/").split("/").length - oldRel.split("/").length;
  return newPath.replace(/\\/g, "/").split("/").slice(rootLen).join("/");
}
