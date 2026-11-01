/**
 * 連結檢查：找出文件裡連到不存在的文件、圖片或檔案的連結。
 * 連結來自文件索引（Rust 的 parseDoc，已經略過網址、頁內錨點與程式碼）；檔案存不存在交給桌面版後端查。
 */
import type { LinkRef } from "./doc-index.ts";
import { type FileRef, resolveWiki } from "./links.ts";
import { dirname, localImagePath } from "./paths.ts";
import { resolvePageLink } from "./wiki-text.ts";

/** `page`：文件（`[[文件]]` 或 .md）；`image`：圖片；`file`：其他檔案。 */
export type LinkKind = "page" | "image" | "file";

export interface LinkProblem {
  /** 第幾行（從 1 開始）。 */
  line: number;
  /** 文件裡寫的連結。 */
  target: string;
  kind: LinkKind;
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const DOC = /\.(md|markdown)$/i;

export function linkKind(link: LinkRef): LinkKind {
  if (link.kind === "wiki" || DOC.test(link.target)) return "page";
  return IMAGE.test(link.target) ? "image" : "file";
}

export interface LinkCheckPlan {
  /** 已經知道斷掉的（`[[文件]]` 在資料夾裡找不到）。 */
  broken: LinkProblem[];
  /** 要問後端存不存在的本機路徑。 */
  paths: { path: string; problem: LinkProblem }[];
  /** 檢查了幾個連結（網址、網路路徑這些不檢查的不算）。 */
  checked: number;
}

/**
 * 一份文件的連結要怎麼檢查。`files` 是資料夾裡的文件（`[[文件]]` 用檔名找）；沒有開資料夾時是 null，
 * 這時 `[[文件]]` 不檢查。網址、網站根目錄（`/…`）與網路路徑（`\\伺服器\…`）也不檢查。
 */
export function planLinkCheck(links: readonly LinkRef[], docPath: string, files: readonly FileRef[] | null): LinkCheckPlan {
  const plan: LinkCheckPlan = { broken: [], paths: [], checked: 0 };
  const dir = dirname(docPath);
  for (const link of links) {
    const problem = { line: link.line, target: link.target, kind: linkKind(link) };
    if (link.kind === "wiki") {
      if (!files) continue;
      plan.checked++;
      if (resolveWiki(link.target, files, dir) === null) plan.broken.push(problem);
      continue;
    }
    const path = localImagePath(link.target, dir);
    if (!path || path.startsWith("\\\\")) continue;
    plan.checked++;
    plan.paths.push({ path, problem });
  }
  return plan;
}

/** 不是 Wiki 頁面的連結：附件（`/.attachments/…`）、有副檔名的檔案（.png、.pdf…，.md 除外）。 */
const NOT_PAGE = /(^|\/)\.attachments\/|\.(?!md$)[a-z0-9]{1,5}$/i;

/**
 * Wiki 頁面裡連到其他頁面的連結，找不到那一頁的列出來。`current` 是這一頁的路徑，`pages` 是 Wiki 的所有頁面。
 * 附件、圖片與其他檔案不檢查（要另外向伺服器查）。
 */
export function wikiLinkProblems(links: readonly LinkRef[], current: string, pages: readonly string[]): LinkProblem[] {
  const out: LinkProblem[] = [];
  for (const link of links) {
    if (link.kind !== "markdown" || NOT_PAGE.test(link.target)) continue;
    // 文件索引的連結已經解碼過：照 Wiki 的寫法編回去（`%` 本身要先編）。
    const href = link.target.replace(/%/g, "%25");
    if (resolvePageLink(href, current, pages) === null) out.push({ line: link.line, target: link.target, kind: "page" });
  }
  return out;
}

/** 有幾個連到其他 Wiki 頁面的連結（會檢查的）。 */
export function wikiPageLinkCount(links: readonly LinkRef[]): number {
  return links.filter((l) => l.kind === "markdown" && !NOT_PAGE.test(l.target)).length;
}
