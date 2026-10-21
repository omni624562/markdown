/**
 * 匯出 Word（.docx）：把核心渲染的 HTML 轉成 Word 的段落、標題、清單、表格、連結與圖片。
 * 中文用微軟正黑體、英文用 Calibri；文件內的 #錨點 連結（例如目錄）轉成 Word 的書籤連結。
 * 這個模組只在匯出時才載入（docx 套件不小）。
 */
import { sizeImages } from "./plugins/doc-links.ts";
import {
  AlignmentType,
  Bookmark,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  InternalHyperlink,
  LevelFormat,
  Packer,
  Paragraph,
  type ParagraphChild,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

export interface DocxImage {
  data: Uint8Array;
  type: "png" | "jpg" | "gif" | "bmp";
  width: number;
  height: number;
}

export interface DocxOptions {
  title: string;
  /** 圖片網址（相對路徑要先解析）；拿不到時回傳 null，匯出時改成文字說明。 */
  image(src: string): Promise<DocxImage | null>;
}

const FONT = { ascii: "Calibri", hAnsi: "Calibri", cs: "Calibri", eastAsia: "Microsoft JhengHei" };
const MONO = { ascii: "Consolas", hAnsi: "Consolas", cs: "Consolas", eastAsia: "Microsoft JhengHei" };
/** 圖片最大寬度（像素，約等於 A4 扣掉邊界）。 */
const MAX_IMAGE_WIDTH = 600;
const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

interface Style {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  underline?: boolean;
  highlight?: boolean;
  superScript?: boolean;
  subScript?: boolean;
  code?: boolean;
  link?: boolean;
}

interface Context {
  /** 引言的層數（左邊縮排加框線）。 */
  quote: number;
  /** 清單的層數（0 表示不在清單裡）。 */
  list: number;
}

const CJK = "\\u2e80-\\u9fff\\u3000-\\u303f\\uff00-\\uffef";
/** HTML 裡的換行：中文字之間直接相連，其他情況換成空白（和瀏覽器顯示一致）。 */
export function softBreaks(text: string): string {
  return text.replace(new RegExp(`(?<=[${CJK}])\\n(?=[${CJK}])`, "g"), "").replace(/\n/g, " ");
}

/** 圖片等比縮小到最大寬度內（像素 → docx 使用的像素單位）。 */
export function fitImage(width: number, height: number, max = MAX_IMAGE_WIDTH): { width: number; height: number } {
  if (width <= max) return { width, height };
  return { width: max, height: Math.round((height * max) / width) };
}

export async function htmlToDocx(html: string, opts: DocxOptions): Promise<Blob> {
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html").body.firstElementChild! as HTMLElement;
  sizeImages(root);

  // 標題的錨點 → Word 書籤名稱（書籤名稱要以英文字母開頭，所以另外編號）。
  const anchors = new Map<string, string>();
  for (const h of root.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    if (h.id) anchors.set(h.id, `_h${anchors.size + 1}`);
  }

  const images = new Map<string, DocxImage | null>();
  await Promise.all(
    [...root.querySelectorAll("img")].map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (!images.has(src)) images.set(src, null);
      images.set(src, await opts.image(src).catch(() => null));
    }),
  );

  const out: (Paragraph | Table)[] = [];
  let orderedLists = 0;

  const run = (text: string, s: Style) =>
    new TextRun({
      text,
      bold: s.bold,
      italics: s.italics,
      strike: s.strike,
      underline: s.underline || s.link ? {} : undefined,
      highlight: s.highlight ? "yellow" : undefined,
      superScript: s.superScript,
      subScript: s.subScript,
      color: s.link ? "2F6FD6" : undefined,
      font: s.code ? MONO : undefined,
      shading: s.code ? { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" } : undefined,
    });

  const inline = (node: Node, s: Style): ParagraphChild[] => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = softBreaks(node.textContent ?? "");
      return text ? [run(text, s)] : [];
    }
    if (!(node instanceof Element)) return [];
    const kids = (style: Style) => [...node.childNodes].flatMap((c) => inline(c, style));
    switch (node.tagName.toLowerCase()) {
      case "strong":
      case "b":
        return kids({ ...s, bold: true });
      case "em":
      case "i":
        return kids({ ...s, italics: true });
      case "del":
      case "s":
        return kids({ ...s, strike: true });
      case "u":
      case "ins":
        return kids({ ...s, underline: true });
      case "mark":
        return kids({ ...s, highlight: true });
      case "sup":
        return kids({ ...s, superScript: true });
      case "sub":
        return kids({ ...s, subScript: true });
      case "code":
        return kids({ ...s, code: true });
      case "br":
        return [new TextRun({ break: 1 })];
      case "input":
        return [run((node as HTMLInputElement).hasAttribute("checked") ? "☑ " : "☐ ", s)];
      case "a": {
        if (node.classList.contains("anchor")) return [];
        const href = node.getAttribute("href") ?? "";
        const children = kids({ ...s, link: true });
        if (href.startsWith("#")) {
          let id = href.slice(1);
          try {
            id = decodeURIComponent(id);
          } catch {}
          const anchor = anchors.get(id);
          return anchor ? [new InternalHyperlink({ anchor, children })] : kids(s);
        }
        return /^(https?:|mailto:)/i.test(href) ? [new ExternalHyperlink({ link: href, children })] : kids(s);
      }
      case "img": {
        const src = node.getAttribute("src") ?? "";
        const img = images.get(src);
        if (!img) return [run(`［圖片：${node.getAttribute("alt") || src}］`, { ...s, italics: true })];
        // `![說明|400](…)` 指定的寬度（高度依比例）。
        const width = Number(node.getAttribute("width")) || img.width;
        const height = Number(node.getAttribute("height")) || Math.round((img.height * width) / img.width);
        return [new ImageRun({ type: img.type, data: img.data, transformation: fitImage(width, height) })];
      }
      default:
        // 數學公式：保留 TeX 原文（Word 的方程式格式不同）。
        if (node.hasAttribute("data-math-style")) return [run(node.textContent ?? "", { ...s, italics: true })];
        return kids(s);
    }
  };

  const quoteProps = (ctx: Context) =>
    ctx.quote
      ? {
          indent: { left: 360 * ctx.quote },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: "D0D0D0", space: 8 } },
        }
      : {};

  const isBlock = (n: Node) =>
    n instanceof Element && /^(p|ul|ol|pre|blockquote|table|h[1-6]|hr|div|section)$/i.test(n.tagName);

  const list = (el: Element, ctx: Context, ordered: boolean) => {
    const instance = ordered ? ++orderedLists : 0;
    const level = Math.min(ctx.list, 8);
    for (const li of el.children) {
      if (li.tagName.toLowerCase() !== "li") continue;
      const task = li.classList.contains("task-list-item");
      const numbering = task ? undefined : { reference: ordered ? "ordered" : "bullet", level, instance };
      const taskIndent = task ? { indent: { left: 360 * (level + 1) + 360 * ctx.quote } } : {};
      let first = true;
      let pending: ParagraphChild[] = [];
      const flush = () => {
        if (!pending.length && !first) return;
        out.push(
          new Paragraph({
            children: pending,
            ...quoteProps(ctx),
            ...(first ? { numbering } : { indent: { left: 360 * (level + 1) } }),
            ...taskIndent,
          }),
        );
        first = false;
        pending = [];
      };
      for (const child of li.childNodes) {
        if (!isBlock(child)) {
          pending.push(...inline(child, {}));
          continue;
        }
        const c = child as Element;
        const tag = c.tagName.toLowerCase();
        if (tag === "p") {
          pending.push(...inline(c, {}));
          flush();
        } else if (tag === "ul" || tag === "ol") {
          if (pending.length || first) flush();
          list(c, { ...ctx, list: ctx.list + 1 }, tag === "ol");
        } else {
          if (pending.length || first) flush();
          block(c, ctx);
        }
      }
      if (pending.length || first) flush();
    }
  };

  const table = (el: Element, ctx: Context) => {
    const rows = [...el.querySelectorAll("tr")].map((tr) => {
      const header = tr.parentElement?.tagName.toLowerCase() === "thead";
      return new TableRow({
        tableHeader: header,
        children: [...tr.children].map((cell) => {
          const align = (cell.getAttribute("style") ?? cell.getAttribute("align") ?? "").match(/(left|center|right)/)?.[1];
          return new TableCell({
            shading: header ? { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" } : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [
              new Paragraph({
                children: inline(cell, header ? { bold: true } : {}),
                alignment:
                  align === "center" ? AlignmentType.CENTER : align === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT,
                spacing: { after: 0 },
              }),
            ],
          });
        }),
      });
    });
    if (!rows.length) return;
    out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    out.push(new Paragraph({ children: [], ...quoteProps(ctx) }));
  };

  const block = (el: Element, ctx: Context): void => {
    const tag = el.tagName.toLowerCase();
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      const children = inline(el, {});
      const anchor = anchors.get(el.id);
      out.push(
        new Paragraph({
          heading: HEADINGS[Number(heading[1]) - 1],
          children: anchor ? [new Bookmark({ id: anchor, children })] : children,
        }),
      );
      return;
    }
    switch (tag) {
      case "p":
        out.push(new Paragraph({ children: inline(el, {}), ...quoteProps(ctx) }));
        return;
      case "ul":
      case "ol":
        list(el, ctx, tag === "ol");
        return;
      case "blockquote":
        for (const c of el.children) block(c, { ...ctx, quote: ctx.quote + 1 });
        return;
      case "pre": {
        const lines = (el.textContent ?? "").replace(/\n$/, "").split("\n");
        lines.forEach((line, i) =>
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line || " ", font: MONO, size: 19 })],
              shading: { type: ShadingType.CLEAR, color: "auto", fill: "F6F8FA" },
              spacing: { before: 0, after: i === lines.length - 1 ? 160 : 0, line: 260 },
              ...quoteProps(ctx),
            }),
          ),
        );
        return;
      }
      case "table":
        table(el, ctx);
        return;
      case "hr":
        out.push(
          new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BFBFBF", space: 1 } },
          }),
        );
        return;
      default:
        if (el.hasAttribute("data-math-style")) {
          out.push(
            new Paragraph({ children: [run(el.textContent ?? "", { italics: true })], alignment: AlignmentType.CENTER }),
          );
          return;
        }
        // 提示區塊（> [!NOTE]）、註腳等容器：裡面的區塊照樣處理，當成引言縮排。
        if (el.classList.contains("markdown-alert")) {
          for (const c of el.children) block(c, { ...ctx, quote: ctx.quote + 1 });
          return;
        }
        if ([...el.childNodes].some(isBlock)) {
          for (const c of el.children) block(c, ctx);
          return;
        }
        out.push(new Paragraph({ children: inline(el, {}), ...quoteProps(ctx) }));
    }
  };

  for (const el of root.children) block(el, { quote: 0, list: 0 });

  const bulletChars = ["•", "◦", "▪"];
  const levels = (ordered: boolean) =>
    Array.from({ length: 9 }, (_, i) => ({
      level: i,
      format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
      text: ordered ? `%${i + 1}.` : bulletChars[i % 3],
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 420 * (i + 1), hanging: 300 } } },
    }));
  const headingStyle = (size: number) => ({
    run: { font: FONT, size, bold: true, color: "1F1F1F" },
    paragraph: { spacing: { before: 280, after: 120 } },
  });

  const doc = new Document({
    creator: "Markdown 編輯器",
    title: opts.title,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 22, language: { value: "en-US", eastAsia: "zh-TW" } },
          paragraph: { spacing: { after: 120, line: 300 } },
        },
        heading1: headingStyle(36),
        heading2: headingStyle(30),
        heading3: headingStyle(26),
        heading4: headingStyle(24),
        heading5: headingStyle(22),
        heading6: headingStyle(22),
        hyperlink: { run: { color: "2F6FD6", underline: {} } },
      },
    },
    numbering: {
      config: [
        { reference: "bullet", levels: levels(false) },
        { reference: "ordered", levels: levels(true) },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        children: out,
      },
    ],
  });
  return Packer.toBlob(doc);
}

/** 讀取圖片：PNG、JPEG、GIF、BMP 直接使用，其他格式（WebP、SVG 等）先畫成 PNG。 */
export async function loadImage(url: string): Promise<DocxImage | null> {
  const blob = await (await fetch(url)).blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    const width = img.naturalWidth || 300;
    const height = img.naturalHeight || 200;
    const native: Record<string, DocxImage["type"]> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/bmp": "bmp",
    };
    const type = native[blob.type];
    if (type) return { data: new Uint8Array(await blob.arrayBuffer()), type, width, height };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    return png ? { data: new Uint8Array(await png.arrayBuffer()), type: "png", width, height } : null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
