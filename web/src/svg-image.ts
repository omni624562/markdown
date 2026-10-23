/**
 * 把畫面上的 SVG（例如流程圖）變成獨立的圖片：放大檢視、複製成圖片時用。
 * 畫面上的 SVG 寬度跟著版面、字型繼承自頁面，單獨顯示時要補上實際大小、字型與背景色。
 */

import { t } from "./i18n.ts";

export interface SvgImageOptions {
  /** 取代 `font-family: inherit` 的字型。 */
  font: string;
  /** 背景色（深色主題的流程圖文字是淺色，不能用透明背景）。 */
  background: string;
}

/** 圖片的原始大小（取自 viewBox）。 */
export function viewBoxSize(viewBox: string | null): { width: number; height: number } | null {
  const parts = (viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) return null;
  return { width: parts[2], height: parts[3] };
}

/** 補上大小、字型、背景色，輸出成合法的 XML（可以當成圖片載入）。 */
export function standaloneSvg(markup: string, opts: SvgImageOptions): { svg: string; width: number; height: number } | null {
  const doc = new DOMParser().parseFromString(markup, "text/html");
  const svg = doc.querySelector("svg");
  if (!svg) return null;
  const size = viewBoxSize(svg.getAttribute("viewBox")) ?? { width: 800, height: 600 };
  const width = Math.ceil(size.width);
  const height = Math.ceil(size.height);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.style.maxWidth = "";
  svg.style.backgroundColor = opts.background;
  const inherit = /font-family:\s*inherit/g;
  for (const style of svg.querySelectorAll("style")) style.textContent = (style.textContent ?? "").replace(inherit, `font-family:${opts.font}`);
  for (const el of svg.querySelectorAll<SVGElement | HTMLElement>("[style*='inherit']")) {
    el.setAttribute("style", (el.getAttribute("style") ?? "").replace(inherit, `font-family:${opts.font}`));
  }
  return { svg: new XMLSerializer().serializeToString(svg), width, height };
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** SVG 轉成 PNG（預設兩倍解析度，貼到文件裡放大也清楚）。 */
export async function svgToPng(markup: string, opts: SvgImageOptions, scale = 2): Promise<Blob> {
  const image = standaloneSvg(markup, opts);
  if (!image) throw new Error(t("沒有圖片"));
  const img = new Image();
  img.src = svgDataUrl(image.svg);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = opts.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error(t("無法轉成圖片"));
  return blob;
}
