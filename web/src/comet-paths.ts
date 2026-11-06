/**
 * COMET 專案裡由 COMET 管理的檔案（`comet setup` 建立的），分成三種：
 *
 * - `config`：`.comet.json` 與 `.comet/` 裡的設定（例如 Sprint 的資料），由 comet 指令維護。
 * - `generated`：`AGENTS.md`，comet 產生的；重新設定時（例如規則改了）可能被覆蓋。
 * - `spec`：`docs/spec/` 裡的規格文件，人和 AI 都會寫、會改。
 *
 * 路徑一律相對於專案資料夾、用 `/` 分隔；比對不分大小寫（Windows 的檔名不分大小寫）。
 */

export type CometKind = "config" | "generated" | "spec";

/** COMET 建立的項目。資料夾以 `/` 結尾。 */
export const COMET_ITEMS: readonly { path: string; kind: CometKind }[] = [
  { path: ".comet.json", kind: "config" },
  { path: ".comet/", kind: "config" },
  { path: "AGENTS.md", kind: "generated" },
  { path: "docs/spec/", kind: "spec" },
];

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** `path` 相對於資料夾 `root` 的路徑（`/` 分隔）；不在 `root` 裡面（或就是 `root`）時回傳 null。 */
export function relativePath(root: string, path: string): string | null {
  const r = norm(root);
  const p = norm(path);
  if (p.length <= r.length + 1 || p[r.length] !== "/" || p.slice(0, r.length).toLowerCase() !== r.toLowerCase()) return null;
  return p.slice(r.length + 1);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const inside = (rel: string, dir: string) => rel.toLowerCase().startsWith(dir.toLowerCase());

/** 這個檔案或資料夾本身是 COMET 的項目（檔案面板上標「C」的）時回傳種類。 */
export function cometItemKind(rel: string): CometKind | null {
  const p = norm(rel);
  return COMET_ITEMS.find((i) => same(norm(i.path), p))?.kind ?? null;
}

/** 這個檔案或資料夾是 COMET 的項目、或在 COMET 的資料夾裡面時回傳種類。 */
export function cometKind(rel: string): CometKind | null {
  const p = norm(rel);
  return COMET_ITEMS.find((i) => same(norm(i.path), p) || (i.path.endsWith("/") && inside(p, i.path)))?.kind ?? null;
}

/**
 * 刪除或改名 `rel` 會動到的 COMET 項目：它本身是（或在 COMET 的資料夾裡）時就是它自己；
 * 是裝著 COMET 項目的資料夾（例如 `docs`）時是裡面的那些項目。沒有時是空陣列。
 */
export function cometAffected(rel: string): string[] {
  const p = norm(rel);
  if (cometKind(p)) return [p];
  return COMET_ITEMS.filter((i) => inside(i.path, `${p}/`)).map((i) => norm(i.path));
}
