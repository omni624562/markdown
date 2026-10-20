/**
 * 連結自動完成（E9）：在 `](` 後面列出工作區的檔案（自動轉成相對路徑），
 * 在 `](#` 後面列出目前文件的標題，在 `](檔案.md#` 後面列出那份文件的標題。
 * 標題錨點直接用 md-core 產生的 id，和預覽中的一致。
 */
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { dirname, relativePath, resolvePath } from "./paths.ts";

export interface HeadingRef {
  id: string;
  text: string;
  level: number;
}

export interface LinkSources {
  /** 只有 Markdown 文件需要。 */
  enabled(): boolean;
  /** 目前文件的路徑（還沒存檔時為 null，無法算相對路徑）。 */
  docPath(): string | null;
  /** 工作區內所有文件的完整路徑。 */
  files(): Promise<string[]>;
  /** 目前文件的標題。 */
  headings(): HeadingRef[];
  /** 另一份文件的標題。 */
  fileHeadings(path: string): Promise<HeadingRef[]>;
}

/** 正在輸入的連結網址：`](` 之後、還沒遇到空白或右括號的部分。圖片 `![…](` 不處理。 */
export function linkDestination(before: string): string | null {
  const m = /(!?)\[[^\]]*\]\(([^()\s<>]*)$/.exec(before);
  if (!m || m[1]) return null;
  return m[2];
}

/** 連結網址中的空白與括號要編碼，其他字元（包含中文）保留原樣比較好讀。 */
export function encodeLinkPath(path: string): string {
  const codes: Record<string, string> = { " ": "%20", "(": "%28", ")": "%29", "<": "%3C", ">": "%3E" };
  return path.replace(/[ ()<>]/g, (c) => codes[c]);
}

function decodeLinkPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

const VALID = /^[^\s()<>#]*$/;

function headingOptions(headings: HeadingRef[]): Completion[] {
  return headings
    .filter((h) => h.id)
    .map((h, i) => ({
      label: h.id,
      displayLabel: h.text || h.id,
      detail: `H${h.level}`,
      type: "keyword",
      // 依文件中的順序排列。
      boost: -i / Math.max(headings.length, 1),
    }));
}

async function complete(ctx: CompletionContext, src: LinkSources): Promise<CompletionResult | null> {
  if (!src.enabled()) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const dest = linkDestination(line.text.slice(0, ctx.pos - line.from));
  if (dest === null) return null;

  const hash = dest.indexOf("#");
  if (hash >= 0) {
    const from = ctx.pos - (dest.length - hash - 1);
    const file = dest.slice(0, hash);
    if (!file) return { from, options: headingOptions(src.headings()), validFor: VALID };
    const doc = src.docPath();
    if (!doc) return null;
    const headings = await src.fileHeadings(resolvePath(dirname(doc), decodeLinkPath(file))).catch(() => []);
    if (ctx.aborted) return null;
    return { from, options: headingOptions(headings), validFor: VALID };
  }

  const doc = src.docPath();
  if (!doc) return null;
  const files = await src.files().catch(() => []);
  if (ctx.aborted) return null;
  const dir = dirname(doc);
  const options: Completion[] = [];
  for (const path of files) {
    if (path === doc) continue;
    const rel = relativePath(dir, path);
    if (rel) options.push({ label: encodeLinkPath(rel), type: "text", boost: rel.startsWith("..") ? -1 : 0 });
  }
  return { from: ctx.pos - dest.length, options, validFor: VALID };
}

export function linkCompletion(src: LinkSources): Extension {
  return autocompletion({
    override: [(ctx) => complete(ctx, src)],
    icons: false,
    maxRenderedOptions: 50,
  });
}
