/**
 * 列印／匯出 PDF（E11）：匯出前選選項，桌面版直接存成 PDF，網頁版用列印對話框。
 */
import { desktop, isRemote } from "../desktop.ts";
import { isoDate } from "../doc-index.ts";
import { stem } from "../files.ts";
import { t } from "../i18n.ts";
import { basename, dirname, localImagePath } from "../paths.ts";
import { type PdfOptions, PAPERS, pageLayout, shadowCss, PRINT_ROOT_CSS, coverHtml, pageCss } from "../pdf-print.ts";
import { blockRemoteImages } from "../remote-images.ts";
import * as storage from "../storage.ts";
import { askPdfOptions } from "../ui/pdf-dialog.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";


/**
 * 用和「匯出 HTML」相同的內容（公式、流程圖都已轉好）放進主視窗看不見的列印區（Shadow DOM）來列印，
 * 在列印對話框中選「另存為 PDF」就能存成 PDF。一律用淺色主題列印。
 */
const PDF_DEFAULTS: Omit<PdfOptions, "header"> = { pageNumbers: true, cover: false, subtitle: "", paper: "A4" };

/** 上次匯出 PDF 的選項（頁首文字每份文件不同，不記）。 */
function savedPdfOptions(): Omit<PdfOptions, "header"> {
  try {
    const raw = JSON.parse(storage.load("pdf-options") ?? "{}") as Partial<PdfOptions>;
    return {
      pageNumbers: typeof raw.pageNumbers === "boolean" ? raw.pageNumbers : PDF_DEFAULTS.pageNumbers,
      cover: typeof raw.cover === "boolean" ? raw.cover : PDF_DEFAULTS.cover,
      subtitle: typeof raw.subtitle === "string" ? raw.subtitle.slice(0, 200) : "",
      paper: raw.paper && raw.paper in PAPERS ? raw.paper : PDF_DEFAULTS.paper,
    };
  } catch {
    return { ...PDF_DEFAULTS };
  }
}

/** 文件標題：第一個一級標題，沒有的話用檔名。 */
function documentTitle(): string {
  return app.preview.result?.headings.find((h) => h.level === 1)?.text.trim() || stem(app.fileName);
}

/**
 * 匯出 PDF：桌面版選好位置後直接存成 PDF（不經過列印對話框），網頁版開啟列印對話框。
 * `printer` 為 true 時（桌面版的「列印…」）一律開列印對話框。
 */
export async function exportPdf(printer = false): Promise<void> {
  if (app.preview.result?.error) {
    toast(t("文件有格式錯誤，修正後才能列印。"), { tone: "error" });
    return;
  }
  const title = documentTitle();
  const direct = !!desktop && !printer;
  const opts = await askPdfOptions({ header: title, ...savedPdfOptions() }, direct);
  if (!opts) return;
  const { header: _header, ...remember } = opts;
  storage.save("pdf-options", JSON.stringify(remember));
  if (direct) {
    const path = await desktop!.pickPdfPath(`${stem(app.fileName)}.pdf`);
    if (!path) return;
    const cleanup = await preparePrint(opts, title);
    try {
      await desktop!.printToPdf(path, pageLayout(opts));
      toast(t("已匯出「{name}」", { name: basename(path) }), { tone: "success" });
      return;
    } catch (e) {
      // 不支援直接匯出或匯出失敗：改用列印對話框（選「另存為 PDF」）。
      toast(t("無法直接匯出 PDF（{error}），改用列印對話框，請選「另存為 PDF」。", { error: e instanceof Error ? e.message : String(e) }), {
        tone: "error",
        duration: 10000,
      });
    } finally {
      cleanup();
    }
  }
  const cleanup = await preparePrint(opts, title);
  window.addEventListener("afterprint", () => setTimeout(cleanup, 0), { once: true });
  window.print();
}

/**
 * 把要列印的內容（和「匯出 HTML」相同，公式與流程圖都已轉好）放進主視窗的列印區：
 * Shadow DOM 隔開介面的樣式，畫面上看不到，只在列印時顯示。回傳清除列印區的函式。
 */
async function preparePrint(opts: PdfOptions, title: string): Promise<() => void> {
  const html = await app.preview.exportDocument(app.editor.text, app.kind, title);
  const doc = new DOMParser().parseFromString(html, "text/html");
  await resolvePrintImages(doc);
  if (app.blockRemote()) blockRemoteImages(doc);
  document.getElementById("print-root")?.remove();
  document.getElementById("print-page")?.remove();
  const host = document.createElement("div");
  host.id = "print-root";
  const shadow = host.attachShadow({ mode: "open" });
  const css = [...doc.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
  // 設定的內文字型與行距（CSS 變數會從主視窗繼承進 Shadow DOM）。
  const docStyle = "article.markdown-body { font-family: var(--font-doc); line-height: var(--doc-line-height, 1.8); }";
  shadow.innerHTML = `<style>${shadowCss(css)}\n${PRINT_ROOT_CSS}\n${docStyle}</style>${opts.cover ? coverHtml(opts, title, isoDate(new Date())) : ""}`;
  const article = doc.querySelector("article.markdown-body");
  if (article) shadow.append(document.importNode(article, true));
  const page = document.createElement("style");
  page.id = "print-page";
  page.textContent = `@media print { ${pageCss(opts)} }`;
  document.head.append(page);
  document.body.append(host);
  document.documentElement.classList.add("printing");
  const images = [...shadow.querySelectorAll("img")].filter((img) => !img.complete);
  await Promise.all(
    images.map(
      (img) =>
        new Promise((resolve) => {
          img.addEventListener("load", resolve);
          img.addEventListener("error", resolve);
        }),
    ),
  );
  await document.fonts?.ready;
  return () => {
    host.remove();
    page.remove();
    document.documentElement.classList.remove("printing");
  };
}

/** 文件中以相對路徑引用的圖片，換成列印區能載入的網址。 */
async function resolvePrintImages(doc: Document): Promise<void> {
  const docPath = app.fileHandle?.path;
  if (!desktop || !docPath) return;
  const dir = dirname(docPath);
  await Promise.all(
    [...doc.querySelectorAll<HTMLImageElement>("img[src]")].map(async (img) => {
      const path = localImagePath(img.getAttribute("src")!, dir);
      if (!path) return;
      try {
        img.setAttribute("src", isRemote(path) ? await desktop!.davImage(path) : desktop!.fileUrl(path));
      } catch {
        img.alt = t("{alt}（無法載入）", { alt: img.alt || t("圖片") });
      }
    }),
  );
}
