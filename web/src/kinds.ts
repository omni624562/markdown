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

/** 開檔對話框可選的所有類型。 */
export const OPEN_ACCEPT = {
  description: "Markdown、純文字、JSON",
  accept: { "text/plain": [".md", ".markdown", ".txt", ".text", ".log", ".json"] },
};

export function isKind(v: unknown): v is DocKind {
  return v === "markdown" || v === "text" || v === "json";
}
