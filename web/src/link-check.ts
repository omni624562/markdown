/**
 * 連結檢查：找出文件裡連到不存在的文件、圖片或檔案的連結。
 * 連結來自文件索引（Rust 的 parseDoc，已經略過網址、頁內錨點與程式碼）；檔案存不存在交給桌面版後端查。
 */
import type { LinkRef } from "./doc-index.ts";
import { type FileRef, resolveWiki } from "./links.ts";
import { dirname, localImagePath } from "./paths.ts";

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
