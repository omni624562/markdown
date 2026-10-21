/**
 * 複製成格式文字：把渲染後的 HTML 加上行內樣式，貼到 Word、Outlook、Teams 時保留標題、粗體、表格框線、
 * 程式碼與引言的外觀（這些程式不讀外部 CSS）。
 */

const FONT = "'Microsoft JhengHei','PingFang TC','Noto Sans TC',sans-serif";
const MONO = "Consolas,'Cascadia Mono','Courier New',monospace";

const STYLES: Record<string, string> = {
  table: "border-collapse:collapse;margin:6px 0",
  th: "border:1px solid #bfbfbf;padding:4px 8px;background:#f2f2f2;font-weight:bold;text-align:left",
  td: "border:1px solid #bfbfbf;padding:4px 8px",
  pre: `background:#f6f8fa;padding:8px 10px;border-radius:4px;font-family:${MONO};font-size:10pt;white-space:pre-wrap`,
  blockquote: "margin:6px 0 6px 2px;padding:0 0 0 10px;border-left:3px solid #d0d0d0;color:#555555",
  mark: "background:#fff3a3",
  hr: "border:0;border-top:1px solid #d0d0d0",
};

/**
 * `html` 是核心渲染的 HTML 片段；`imageUrl` 把相對路徑的圖片換成貼上的程式讀得到的網址
 * （桌面版用 file:///…），回傳 null 時保留原樣。
 */
export function richHtml(html: string, imageUrl: (src: string) => string | null = () => null): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild as HTMLElement;
  for (const el of root.querySelectorAll<HTMLElement>("[data-sourcepos]")) el.removeAttribute("data-sourcepos");
  for (const [tag, style] of Object.entries(STYLES)) {
    for (const el of root.querySelectorAll<HTMLElement>(tag)) el.setAttribute("style", style);
  }
  // 行內程式碼（程式碼區塊裡的 <code> 跟著 <pre>）
  for (const el of root.querySelectorAll<HTMLElement>("code")) {
    if (!el.closest("pre")) el.setAttribute("style", `font-family:${MONO};background:#f2f2f2;padding:0 3px`);
  }
  // 待辦清單的勾選框：Word 不顯示 <input>，換成符號。
  for (const box of root.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
    box.replaceWith(doc.createTextNode(box.hasAttribute("checked") ? "☑ " : "☐ "));
  }
  for (const li of root.querySelectorAll<HTMLElement>("li.task-list-item")) li.style.listStyleType = "none";
  // 提示區塊（> [!NOTE]）
  for (const el of root.querySelectorAll<HTMLElement>(".markdown-alert")) {
    el.setAttribute("style", "margin:6px 0;padding:4px 10px;border-left:3px solid #2f6fd6;background:#f3f7fd");
  }
  for (const img of root.querySelectorAll<HTMLImageElement>("img")) {
    const src = img.getAttribute("src") ?? "";
    const url = imageUrl(src);
    if (url) img.setAttribute("src", url);
    img.style.maxWidth = "100%";
  }
  // 標題前面的錨點（#）
  for (const a of root.querySelectorAll<HTMLElement>("a.anchor")) a.remove();
  root.setAttribute("style", `font-family:${FONT};font-size:11pt;line-height:1.6`);
  return root.outerHTML;
}

/** 本機絕對路徑轉成 file:/// 網址（Windows 的 \ 換成 /）。 */
export function fileUrl(path: string): string {
  const p = path.replace(/\\/g, "/");
  return `file:///${encodeURI(p.replace(/^\/+/, ""))}`;
}
