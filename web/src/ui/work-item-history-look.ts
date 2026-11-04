/**
 * 工作項目修改紀錄的樣子（work-item-history.ts 產生的 Markdown 畫好之後調整）：
 * - 最上面的大標題換成精簡的標頭：類型標籤與編號、標題，下面一行淡色的「共幾次修改」。
 * - 每一天的標題是淡色的小字，右邊一條細線（捲動時停在最上面）。
 * - 每一項修改排成時間軸：左邊是頭像（同一天的頭像用細線連起來），右邊上面是誰、幾點，
 *   下面的欄位排成兩欄（欄位名稱、原本 → 之後），留言放在淡色的圓角框裡。
 *
 * 內容還是同一份 Markdown（「複製成 Markdown 文件」不受影響）；欄位名稱與值之間的「：」留在畫面外，
 * 複製文字、在內容中尋找時還是「狀態：New → Active」。
 * 換掉了頂層節點（標題、每一天包成一段），預覽下次更新時會整個重建，所以每次都是從原本的結構開始。
 */
import { t } from "../i18n.ts";
import { shortcutHue, shortcutInitial } from "../wiki-shortcuts.ts";
import { kindKey } from "../work-item-colors.ts";
import { splitWorkItemTitle } from "./work-item-look.ts";

function span(className: string, text?: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = className;
  if (text !== undefined) s.textContent = text;
  return s;
}

/** 參數位置的記號：取出翻譯裡參數以外的部分，例如「{field}：{value}」→ ["", "：", ""]（英文是 ["", ": ", ""]）。 */
const MARK = "\u0000";
const pieces = (translated: string) => translated.split(MARK);

export function decorateHistory(body: HTMLElement): void {
  if (body.querySelector(":scope > .wih-head")) return;
  header(body);
  for (const h2 of [...body.querySelectorAll<HTMLElement>(":scope > h2")]) day(h2);
}

/** 標頭：「修改紀錄：Feature 123：標題」拆成類型標籤、編號與標題，「共幾次修改」放在下面。 */
function header(body: HTMLElement): void {
  const h1 = body.querySelector<HTMLElement>(":scope > h1");
  if (!h1) return;
  const head = document.createElement("header");
  head.className = "wih-head";
  h1.before(head);
  const text = (h1.textContent ?? "").trim();
  const prefix = pieces(t("修改紀錄：{label}", { label: MARK }))[0];
  const parts = text.startsWith(prefix) ? splitWorkItemTitle(text.slice(prefix.length)) : null;
  if (parts) {
    const row = document.createElement("div");
    row.className = "wih-kind";
    const badge = span("ado-kind-badge", parts.kind);
    badge.dataset.wiKind = kindKey(parts.kind);
    row.append(badge, span("wih-id", parts.id));
    head.append(row);
    h1.textContent = parts.title;
  }
  head.append(h1);
  const summary = head.nextElementSibling;
  if (summary?.tagName === "P") {
    summary.classList.add("wih-summary");
    head.append(summary);
  }
}

/** 一天：標題和底下的修改包成一段（標題捲動時停在這一段的最上面）。 */
function day(h2: HTMLElement): void {
  const section = document.createElement("section");
  section.className = "wih-day";
  const list = h2.nextElementSibling;
  h2.before(section);
  section.append(h2);
  if (list?.tagName !== "UL") return;
  list.classList.add("wih-timeline");
  section.append(list);
  for (const li of list.querySelectorAll<HTMLLIElement>(":scope > li")) entry(li);
}

const BLOCK = /^(?:UL|OL|BLOCKQUOTE|P|PRE|TABLE|DIV)$/;

/** 一項修改：「名字・時間」換成頭像與名字、時間，下面是欄位與留言。 */
function entry(li: HTMLLIElement): void {
  li.classList.add("wih-entry");
  // 第一行是「名字・時間」（清單有空行時包在 <p> 裡）。
  const lead: Node[] = [];
  for (const n of [...li.childNodes]) {
    if (n instanceof Element && BLOCK.test(n.tagName)) {
      if (n.tagName === "P" && !lead.some((x) => x.textContent?.trim())) {
        lead.push(...n.childNodes);
        n.remove();
      }
      break;
    }
    lead.push(n);
  }
  const strong = lead.find((n): n is HTMLElement => n instanceof HTMLElement && n.tagName === "STRONG");
  const name = strong?.textContent?.trim() ?? "";
  const sep = t("・");
  let time = lead
    .filter((n) => n !== strong)
    .map((n) => n.textContent ?? "")
    .join("")
    .trim();
  if (time.startsWith(sep.trim())) time = time.slice(sep.trim().length).trim();
  for (const n of lead) if (n.parentNode === li) li.removeChild(n);

  const avatar = span("wih-avatar", shortcutInitial(name));
  avatar.style.setProperty("--hue", String(shortcutHue(name)));
  avatar.setAttribute("aria-hidden", "true");
  const who = document.createElement("div");
  who.className = "wih-who";
  who.append(span("wih-name", name));
  if (time) who.append(span("wih-sep", sep), span("wih-time", time));
  const main = document.createElement("div");
  main.className = "wih-main";
  main.append(who, ...li.childNodes);
  li.replaceChildren(avatar, main);
  for (const ul of main.querySelectorAll<HTMLElement>(":scope > ul")) changes(ul);
  for (const q of main.querySelectorAll<HTMLElement>(":scope > blockquote")) comment(q);
}

/** 欄位：名稱（淡色）一欄、值一欄；沒有欄位名稱的（調整 Backlog 順序、加入或移除關聯）佔滿一行。 */
function changes(ul: HTMLElement): void {
  ul.classList.add("wih-changes");
  const [, fieldSep] = pieces(t("{field}：{value}", { field: MARK, value: MARK }));
  for (const li of ul.querySelectorAll<HTMLLIElement>(":scope > li")) {
    const first = [...li.childNodes].find((n) => !(n instanceof Text && !n.data.trim()));
    if (!(first instanceof HTMLElement && first.tagName === "STRONG")) {
      li.classList.add("wih-note");
      if (li.textContent?.trim() === t("調整 Backlog 順序")) li.classList.add("wih-muted");
      continue;
    }
    const label = first.textContent?.trim() ?? "";
    first.remove();
    const field = span("wih-field", label);
    const hiddenSep = span("wih-sep", fieldSep);
    // 值前面的「：」（英文是「: 」）搬到看不到的 `.wih-sep`。
    const head = li.firstChild;
    const sep = fieldSep.trim();
    if (head instanceof Text && head.data.trimStart().startsWith(sep)) head.data = head.data.trimStart().slice(sep.length).trimStart();
    const value = span("wih-value");
    value.append(...li.childNodes);
    styleValue(value, label === t("狀態"));
    li.replaceChildren(field, hiddenSep, value);
  }
}

/** 值：「原本 → 之後」的原本是淡色，之後是粗體；狀態後面的原因淡色；「內容有修改」「（空白）」淡色。 */
function styleValue(value: HTMLElement, isState: boolean): void {
  // 有連結或其他格式：照原樣。
  if (value.children.length) return;
  const text = value.textContent ?? "";
  if (text.trim() === t("內容有修改") || text.trim() === t("（空白）")) {
    value.classList.add("wih-muted");
    return;
  }
  const [, arrow] = pieces(t("{old} → {new}", { old: MARK, new: MARK }));
  const at = text.indexOf(arrow);
  const old = at >= 0 ? text.slice(0, at) : null;
  let now = at >= 0 ? text.slice(at + arrow.length) : text;
  let reason = "";
  if (isState) {
    const [, open, close] = pieces(t("{value}（{reason}）", { value: MARK, reason: MARK }));
    const start = now.lastIndexOf(open);
    if (close && now.endsWith(close) && start > 0) {
      reason = now.slice(start);
      now = now.slice(0, start);
    }
  }
  if (old === null && !reason) return;
  const out: Node[] = [];
  if (old !== null) out.push(span("wih-old", old), span("wih-arrow", arrow));
  out.push(span(now.trim() === t("（空白）") ? "wih-muted" : old !== null ? "wih-new" : "wih-now", now));
  if (reason) out.push(span("wih-reason", reason));
  value.replaceChildren(...out);
}

/** 留言：淡色的圓角框，「留言：」淡色。 */
function comment(q: HTMLElement): void {
  q.classList.add("wih-comment");
  const label = t("留言：").trim();
  for (const p of q.querySelectorAll<HTMLElement>(":scope > p")) {
    const first = p.firstChild;
    if (!(first instanceof Text) || !first.data.startsWith(label)) continue;
    first.data = first.data.slice(label.length).replace(/^\s+/, "");
    p.prepend(span("wih-comment-label", label));
    if (!first.data) first.remove();
  }
}
