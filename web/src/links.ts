/**
 * 文件互連：`[[文件]]` 找出對應的檔案、列出反向連結。
 * 檔案改名後更新其他文件中的連結在 Rust（`crates/md-text`），規則和這裡的 `resolveWiki` 相同。
 * `[[週報]]` 和 Obsidian 一樣用檔名找（不分大小寫、不用寫 .md），同名時優先找同一個資料夾的。
 */
import type { LinkRef } from "./doc-index.ts";
import { dirname, resolvePath } from "./paths.ts";

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

interface WikiIndex {
  /** 完整的相對路徑（小寫、不含副檔名）→ 檔案。 */
  full: Map<string, FileRef[]>;
  /** 檔名（小寫、不含副檔名）→ 檔案。 */
  base: Map<string, FileRef[]>;
}

const stemOf = (rel: string) => rel.toLowerCase().replace(MD, "");
const indexes = new WeakMap<readonly FileRef[], WikiIndex>();

/** 依檔名建立索引（同一份清單只建一次），之後每個 `[[ ]]` 都不用掃過全部檔案。 */
function wikiIndex(files: readonly FileRef[]): WikiIndex {
  let index = indexes.get(files);
  if (index) return index;
  index = { full: new Map(), base: new Map() };
  const add = (map: Map<string, FileRef[]>, key: string, f: FileRef) => {
    const list = map.get(key);
    if (list) list.push(f);
    else map.set(key, [f]);
  };
  for (const f of files) {
    const stem = stemOf(f.rel);
    add(index.full, stem, f);
    add(index.base, stem.slice(stem.lastIndexOf("/") + 1), f);
  }
  indexes.set(files, index);
  return index;
}

/** `[[target]]` 對應的檔案路徑；找不到時回傳 null。 */
export function resolveWiki(target: string, files: readonly FileRef[], fromDir: string | null): string | null {
  let t = target.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!t) return null;
  if (!MD.test(t)) t += ".md";
  const want = stemOf(t);
  // 寫了資料夾（[[筆記/想法]]）要完全符合；只寫檔名時找所有同名的檔案。.md 與 .markdown 都算。
  const index = wikiIndex(files);
  const pool = (want.includes("/") ? index.full : index.base).get(want);
  if (!pool?.length) return null;
  if (fromDir) {
    const near = pool.find((f) => samePath(dirname(f.path), fromDir));
    if (near) return near.path;
  }
  if (pool.length === 1) return pool[0].path;
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
