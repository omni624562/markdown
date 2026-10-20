/**
 * 智慧貼上（E4）：把從網頁、Google 文件、Word 複製的 HTML 轉成 Markdown，
 * 保留標題、清單、粗體、連結和表格。腳本、樣式、表單等內容一律丟掉。
 */
import TurndownService from "turndown";

type El = HTMLElement;

/** 不轉換、整個丟掉的元素。 */
const DROP = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "meta",
  "link",
  "title",
  "head",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "canvas",
  "video",
  "audio",
] as const;

/** HTML 裡有這些結構時才值得轉換；只有純文字時直接貼純文字，保留原本的空白與換行。 */
const STRUCTURE =
  /<(h[1-6]|ul|ol|li|table|blockquote|pre|code|img|strong|b|em|i|del|s|strike)[\s>]|<a\s[^>]*href|font-weight:\s*(bold|[6-9]00)|font-style:\s*italic/i;

export function hasStructure(html: string): boolean {
  return STRUCTURE.test(html);
}

const SAFE_LINK = /^(https?:|mailto:|#|\.{0,2}\/|[^:/?#]+(?:[/?#]|$))/i;
const SAFE_IMAGE = /^https?:/i;

function style(node: TurndownService.Node): string {
  return ((node as El).getAttribute?.("style") ?? "").toLowerCase().replace(/\s+/g, "");
}

function isBold(css: string): boolean {
  return /font-weight:(bold|bolder|[6-9]00)/.test(css);
}

/** 表格儲存格內不能換行，`|` 也要跳脫。 */
function cell(content: string): string {
  return content.trim().replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|");
}

function createService(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
  });
  td.remove([...DROP]);
  td.remove((node) => node.nodeName.toLowerCase() === "svg");

  // Google 文件把整段內容包在 <b style="font-weight:normal" id="docs-internal-guid-…"> 裡。
  td.addRule("google-docs-wrapper", {
    filter: (node) => node.nodeName === "B" && /font-weight:(normal|400)/.test(style(node)),
    replacement: (content) => content,
  });
  // Google 文件、部分網頁用 <span style="font-weight:700"> 表示粗體。
  td.addRule("styled-span", {
    filter: (node) => {
      if (node.nodeName !== "SPAN") return false;
      const css = style(node);
      return isBold(css) || css.includes("font-style:italic") || css.includes("line-through");
    },
    replacement: (content, node) => {
      if (!content.trim()) return content;
      const css = style(node);
      let out = content;
      if (css.includes("line-through")) out = `~~${out}~~`;
      if (css.includes("font-style:italic")) out = `*${out}*`;
      if (isBold(css)) out = `**${out}**`;
      return out;
    },
  });
  // Word：清單的項目符號是寫死的文字，真正的項目改用 class 判斷。
  td.addRule("word-list-marker", {
    filter: (node) => node.nodeName === "SPAN" && style(node).includes("mso-list:ignore"),
    replacement: () => "",
  });
  td.addRule("word-list-item", {
    filter: (node) => node.nodeName === "P" && /MsoListParagraph/i.test((node as El).getAttribute?.("class") ?? ""),
    replacement: (content) => `\n- ${content.trim()}\n`,
  });
  // 清單符號後面只空一格（turndown 預設空三格）；續行縮排對齊內容。
  td.addRule("list-item", {
    filter: "li",
    replacement: (content, node, options) => {
      const parent = node.parentNode as El | null;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start")) || 1;
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      const body = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
      return prefix + body + (node.nextSibling && !body.endsWith("\n") ? "\n" : "");
    },
  });
  td.addRule("strikethrough", {
    filter: ["del", "s", "strike"] as TurndownService.Filter,
    replacement: (content) => (content.trim() ? `~~${content}~~` : content),
  });
  // 危險或本機的連結只留文字。
  td.addRule("unsafe-link", {
    filter: (node) => node.nodeName === "A" && !SAFE_LINK.test(((node as El).getAttribute("href") ?? "").trim()),
    replacement: (content) => content,
  });
  // data:、file: 等圖片（例如 Word 的本機暫存圖）沒辦法帶過來，只留替代文字。
  td.addRule("unsafe-image", {
    filter: (node) => node.nodeName === "IMG" && !SAFE_IMAGE.test(((node as El).getAttribute("src") ?? "").trim()),
    replacement: (_content, node) => (node as El).getAttribute?.("alt") ?? "",
  });
  // GitHub 等網站的 <pre> 裡沒有 <code>，turndown 預設會把它當一般段落。
  td.addRule("bare-pre", {
    filter: (node) => node.nodeName === "PRE" && node.firstElementChild?.nodeName !== "CODE",
    replacement: (_content, node) => {
      const text = (node.textContent ?? "").replace(/\n$/, "");
      const fence = text.includes("```") ? "~~~" : "```";
      return `\n\n${fence}\n${text}\n${fence}\n\n`;
    },
  });

  // GFM 表格：第一列當標題列（Markdown 一定要有標題列）。
  td.addRule("table-cell", {
    filter: ["th", "td"],
    replacement: (content, node) => {
      const span = Math.max(1, Number((node as El).getAttribute?.("colspan")) || 1);
      return ` ${cell(content)} |` + " |".repeat(span - 1);
    },
  });
  td.addRule("table-row", {
    filter: "tr",
    replacement: (content, node) => {
      const row = `|${content}\n`;
      const tr = node as HTMLTableRowElement;
      const table = tr.closest?.("table");
      const first = table?.querySelector("tr") === tr;
      if (!first) return row;
      const columns = (content.match(/(?<!\\)\|/g) ?? []).length;
      return `${row}|${" --- |".repeat(Math.max(columns, 1))}\n`;
    },
  });
  td.addRule("table-section", {
    filter: ["thead", "tbody", "tfoot"],
    replacement: (content) => content,
  });
  td.addRule("table", {
    filter: "table",
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });
  // 表格標題放在表格上方當一般段落。
  td.addRule("table-caption", {
    filter: "caption",
    replacement: (content) => `${content.trim()}\n\n`,
  });
  return td;
}

let service: TurndownService | null = null;

/** 把 HTML 轉成 Markdown（已移除不安全的內容）。 */
export function htmlToMarkdown(html: string): string {
  service ??= createService();
  return service
    .turndown(html)
    .replace(/ /g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 決定貼上的內容：有值得保留的格式時回傳轉換後的 Markdown，
 * 否則回傳 null（交給編輯器照原樣貼上純文字）。
 */
export function pasteAsMarkdown(html: string, plain: string): string | null {
  if (!html || !hasStructure(html)) return null;
  const md = htmlToMarkdown(html);
  if (!md || md === plain.trim()) return null;
  return md;
}
