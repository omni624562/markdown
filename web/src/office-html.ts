/**
 * Office 文件轉出來的 HTML（Word 經 mammoth、Excel／PowerPoint 自己組的）顯示前的白名單：
 * 只留排版用的標籤；連結只能是網址或頁內錨點，圖片只能是內嵌的 data: 圖片。
 * 文件是別人傳來的，不能讓裡面的內容執行任何東西。用 <template> 解析，不會載入圖片、不會執行指令碼。
 */
const TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "blockquote", "pre", "code",
  "strong", "b", "em", "i", "u", "s", "del", "sup", "sub", "mark", "span", "div", "small",
  "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "a", "img", "section", "header", "figure", "figcaption",
]);
const ATTRS: Record<string, readonly string[]> = {
  a: ["href", "id", "name"],
  img: ["src", "alt", "width", "height"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  ol: ["start", "type"],
  "*": ["class", "title"],
};
const SAFE_HREF = /^(https?:|mailto:|#)/i;
const SAFE_SRC = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;

/** 整理 HTML，回傳只有安全內容的片段。 */
export function cleanOfficeHtml(html: string): DocumentFragment {
  const box = document.createElement("template");
  box.innerHTML = html;
  clean(box.content);
  return box.content;
}

function clean(node: ParentNode): void {
  for (const child of [...node.children]) {
    const tag = child.tagName.toLowerCase();
    if (!TAGS.has(tag)) {
      // 不認得的標籤：script、style、iframe、object、svg、math 等整個拿掉，其他的留下內容。
      if (/^(script|style|iframe|object|embed|svg|math|link|meta|base|form|input|button|textarea|select|template|noscript)$/.test(tag)) child.remove();
      else {
        clean(child);
        child.replaceWith(...child.childNodes);
      }
      continue;
    }
    const allowed = new Set([...(ATTRS[tag] ?? []), ...ATTRS["*"]]);
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      const ok = allowed.has(name) && (name !== "href" || SAFE_HREF.test(value)) && (name !== "src" || SAFE_SRC.test(value));
      if (!ok) child.removeAttribute(attr.name);
    }
    if (tag === "a" && child.hasAttribute("href") && !child.getAttribute("href")!.startsWith("#")) child.setAttribute("rel", "noopener noreferrer");
    clean(child);
  }
}
