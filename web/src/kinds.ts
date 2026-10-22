import type { DocKind } from "../pkg/md_wasm.js";

export type { DocKind };

export interface KindInfo {
  label: string;
  ext: string;
  mime: string;
  accept: Record<string, string[]>;
}

export const KINDS: Record<DocKind, KindInfo> = {
  markdown: {
    label: "Markdown",
    ext: ".md",
    mime: "text/markdown",
    accept: { "text/markdown": [".md", ".markdown"] },
  },
  text: { label: "純文字", ext: ".txt", mime: "text/plain", accept: { "text/plain": [".txt", ".text", ".log"] } },
  json: { label: "JSON", ext: ".json", mime: "application/json", accept: { "application/json": [".json"] } },
};

/** 可以開啟的文字檔副檔名（和桌面版 desktop/src/workspace.rs 的 DOC_EXTENSIONS 一致）。 */
export const TEXT_EXTENSIONS: readonly string[] = [
  // 文件
  "md", "markdown", "mdown", "mkd", "txt", "text", "log",
  // 資料與設定
  "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env", "csv", "tsv", "xml",
  // 網頁
  "html", "htm", "css", "scss", "sass", "less", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte",
  // 程式碼
  "py", "rb", "php", "java", "kt", "kts", "scala", "groovy", "gradle", "go", "rs", "c", "h", "cpp", "cc", "cxx",
  "hpp", "hh", "cs", "fs", "vb", "swift", "m", "mm", "dart", "lua", "pl", "r", "jl", "sql", "graphql",
  "proto", "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "tex", "bib",
];

/** 檔名的副檔名是否在 {@link TEXT_EXTENSIONS} 裡。 */
export function isTextFileName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && TEXT_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/** 開檔對話框可選的所有類型。 */
export const OPEN_ACCEPT = {
  description: "文件與程式碼",
  accept: { "text/plain": TEXT_EXTENSIONS.map((e) => `.${e}`) },
};

/** 檔案內容看起來不是文字時回傳原因（接在檔名後面顯示）；是文字時回傳 `null`。 */
export function notTextReason(text: string): string | null {
  // 和 Git 一樣：開頭一段裡有 NUL 字元就當成二進位檔（UTF-16 的文字檔也會有 NUL）。
  if (text.startsWith("%PDF-") || text.slice(0, 8192).includes("\0")) {
    return "不是文字檔（可能是圖片、PDF、壓縮檔或執行檔，也可能是 UTF-16 編碼），無法開啟";
  }
  return null;
}

export function isKind(v: unknown): v is DocKind {
  return v === "markdown" || v === "text" || v === "json";
}
