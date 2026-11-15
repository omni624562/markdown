/**
 * 助理回答的出處（畫面）：回答裡的 `[1]` 變成可以按的標記，按了就在編輯區選取那一段原文並捲過去；
 * 滑鼠停在上面看得到原文。PDF 的出處沒有地方可以跳，提示在第幾頁。
 * 編號與找原文的規則在 assistant-cites.ts。
 */
import { type Cite, citeList, citeSnippet, findCited } from "../assistant-cites.ts";
import { t } from "../i18n.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";

/** 出處清單裡的一行：文件的原文，或 PDF 的頁碼與原文。 */
function label(c: Cite): string {
  const quote = t("「{text}」", { text: citeSnippet(c.text) });
  if (c.page) return t("PDF 第 {n} 頁：{quote}", { n: c.page, quote });
  return quote;
}

/** 回答最後的「出處」清單（跟著回答一起複製、插入、存成筆記）。 */
export function citesMarkdown(list: readonly Cite[]): string {
  return citeList(list, t("出處"), label);
}

/** 在編輯區選取這個出處的原文並捲到畫面上。 */
function jump(c: Cite): void {
  if (c.page) {
    toast(t("這一段在附上的 PDF 第 {n} 頁", { n: c.page }));
    return;
  }
  const view = app.editor.view;
  const range = findCited(view.state.doc.toString(), c);
  if (!range) {
    toast(t("目前的文件裡找不到這一段原文（文件改過，或已經換到別份文件）"));
    return;
  }
  // 只顯示預覽時看不到編輯區：先切回編輯。
  if (app.view === "preview") app.setView(app.cur.kind === "markdown" ? "live" : "editor");
  view.dispatch({ selection: { anchor: range.from, head: range.to }, scrollIntoView: true });
  view.focus();
}

/** 把回答裡的 `[n]`（n 是已知的出處）換成可以按的標記；程式碼裡的不動。 */
export function linkCites(body: HTMLElement, list: readonly Cite[]): void {
  if (!list.length) return;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("pre, code, a, button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const parts = (node.nodeValue ?? "").split(/(\[\d+\])/);
    if (parts.length < 2) continue;
    const out: (string | HTMLElement)[] = [];
    for (const part of parts) {
      const n = /^\[(\d+)\]$/.exec(part);
      const c = n ? list[Number(n[1]) - 1] : undefined;
      if (!c) {
        out.push(part);
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "assistant-cite";
      b.textContent = n![1];
      b.title = c.page ? label(c) : t("{quote}（按一下跳到這一段）", { quote: label(c) });
      b.setAttribute("aria-label", t("出處 {n}：{quote}", { n: n![1], quote: label(c) }));
      b.addEventListener("click", () => jump(c));
      out.push(b);
    }
    node.replaceWith(...out);
  }
}
