/**
 * 列印與匯出 PDF 的版面：紙張、頁首、頁碼、封面。
 * 內容放進主視窗的列印區（Shadow DOM，介面的樣式影響不到），只在列印時顯示；
 * 桌面版接著請 WebView 直接存成 PDF，網頁版開啟列印對話框。
 */

import { t } from "./i18n.ts";

export type Paper = "A4" | "A5" | "Letter";

export interface PdfOptions {
  /** 每一頁上方的文字；空白就不顯示。 */
  header: string;
  pageNumbers: boolean;
  cover: boolean;
  /** 封面標題下的文字（例如部門、報告人）。 */
  subtitle: string;
  paper: Paper;
}

export const PAPERS: Record<Paper, { label: string; width: number; height: number }> = {
  A4: { label: "A4", width: 210, height: 297 },
  A5: { label: "A5", width: 148, height: 210 },
  Letter: { label: t("Letter（美規）"), width: 215.9, height: 279.4 },
};

export interface PageLayout {
  widthMm: number;
  heightMm: number;
  marginTopMm: number;
  marginBottomMm: number;
  marginSideMm: number;
}

export function pageLayout(o: PdfOptions): PageLayout {
  const paper = PAPERS[o.paper];
  const small = o.paper === "A5";
  return {
    widthMm: paper.width,
    heightMm: paper.height,
    marginTopMm: small ? 14 : 20,
    marginBottomMm: small ? 14 : 20,
    marginSideMm: small ? 12 : 18,
  };
}

/** CSS 字串（content: "…"）要跳脫的字元。 */
export function cssString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

/** `@page`：紙張、邊界、頁首（左上）與頁碼（下方置中）。 */
export function pageCss(o: PdfOptions): string {
  const l = pageLayout(o);
  const box = "font: 9pt -apple-system, 'Segoe UI', 'Microsoft JhengHei', 'Noto Sans TC', sans-serif; color: #888;";
  const header = o.header.trim() ? `@top-left { content: ${cssString(o.header.trim())}; ${box} }` : "";
  // CSS 的 content：頁碼的文字依介面語言。
  const pageOf = t('"第 " counter(page) " 頁，共 " counter(pages) " 頁"');
  const numbers = o.pageNumbers ? `@bottom-center { content: ${pageOf}; ${box} }` : "";
  const first = o.cover ? "@page :first { @top-left { content: none; } @bottom-center { content: none; } }" : "";
  return `@page { size: ${l.widthMm}mm ${l.heightMm}mm; margin: ${l.marginTopMm}mm ${l.marginSideMm}mm ${l.marginBottomMm}mm; ${header} ${numbers} }\n${first}`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** 封面：標題、副標題與日期，獨立一頁。 */
export function coverHtml(o: PdfOptions, title: string, date: string): string {
  const l = pageLayout(o);
  // 留一些餘裕：剛好等於可列印的高度時，有的瀏覽器會多出一頁空白。
  const height = Math.round((l.heightMm - l.marginTopMm - l.marginBottomMm) * 0.85);
  return `<section class="pdf-cover" style="height:${height}mm">
  <h1>${escapeHtml(title)}</h1>
  ${o.subtitle.trim() ? `<p class="pdf-subtitle">${escapeHtml(o.subtitle.trim())}</p>` : ""}
  <p class="pdf-date">${escapeHtml(date)}</p>
</section>`;
}

/** 匯出 HTML 的樣式改成在 Shadow DOM 裡也有效：`:root` 換成 `:host`，並固定用淺色。 */
export function shadowCss(css: string): string {
  return css
    .replace(/:root\[data-theme="dark"\]/g, ":host(.never-dark)")
    .replace(/:root\[data-theme="light"\]/g, ":host")
    .replace(/:root/g, ":host");
}

/** 列印區用到的樣式（放在 Shadow DOM 裡）。 */
export const PRINT_ROOT_CSS = `
:host { display: block; color-scheme: light; background: #fff; }
.pdf-cover { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center;
  break-after: page; font-family: -apple-system, "Segoe UI", "Microsoft JhengHei", "Noto Sans TC", sans-serif; color: #1f2328; }
.pdf-cover h1 { margin: 0 0 0.6em; font-size: 28pt; line-height: 1.3; border: 0; }
.pdf-subtitle { margin: 0 0 0.4em; font-size: 14pt; color: #444; }
.pdf-date { margin: 0; font-size: 11pt; color: #888; }
`;
