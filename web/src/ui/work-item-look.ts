/**
 * 工作項目檢視比照 TFS 網頁，把 TFS 的內容一塊一塊分開：
 * - 標題上面是類型標籤與編號；最常看的欄位（狀態、指派給、優先順序、反覆項目、更新時間）是一排小標籤，
 *   其他欄位收在「詳細欄位」裡（展開是完整的欄位表）。
 * - 每個段落（說明、重現步驟、相關項目、留言…）是一張可以收合的卡片，記住收合了哪些段落。
 * - 留言是對話卡片：頭像、名字、「幾天前」、上次看過之後的新留言標「新」；
 *   預設只展開最新的幾則，很長的先顯示前面一段；可以切換最新的在上面或下面。
 *
 * 內容還是同一份 Markdown（「複製成 Markdown 文件」不受影響），畫好之後才在這裡把節點包成卡片。
 * 包起來之後頂層節點的數量變了，預覽下次更新時會整個重建，所以每次都是從原本的結構開始。
 * 樣式只套用在 `.issue-pane[data-source="ado"]` 裡。
 */
import { timeAgo } from "../history-label.ts";
import { t } from "../i18n.ts";
import { stateTone } from "../issue-doc.ts";
import { shortcutHue, shortcutInitial } from "../wiki-shortcuts.ts";
import { icon } from "./icons.ts";

export type SectionKind = "desc" | "details" | "sysinfo" | "relations" | "attachments" | "comments" | "other";

export interface WorkItemLookOptions {
  /** 上次看過這個項目時的最後更新時間（毫秒）：之後的留言標「新」。沒看過是 null。 */
  seenAt: number | null;
  /** 收起來的段落。 */
  folded: ReadonlySet<SectionKind>;
  /** 使用者收合或展開了某種段落（記住，下次開別的項目也一樣）。 */
  onFold(kind: SectionKind, folded: boolean): void;
  /** 留言最新的在上面（和 TFS 網頁一樣）。 */
  newestFirst: boolean;
  onOrder(newestFirst: boolean): void;
}

/** 最新的幾則留言預設展開，比較舊的收成一行。 */
const OPEN_COMMENTS = 3;
/** 留言超過這個高度（px）先只顯示前面一段。 */
const LONG_COMMENT = 320;

const SECTION_ICONS: Record<SectionKind, string> = {
  desc: "file-text",
  details: "list-checks",
  sysinfo: "monitor",
  relations: "link",
  attachments: "paperclip",
  comments: "message-square",
  other: "file-text",
};

/** 「留言（{n}）」這類有數字的標題：任何數字都算（單複數的翻譯也都比對）。 */
function countPattern(title: (n: number) => string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forms = [1, 2].map((n) => escape(title(987650 + n)).replace(String(987650 + n), "\\d+"));
  return new RegExp(`^(?:${forms.join("|")})$`);
}

export function sectionKind(title: string): SectionKind {
  const text = title.trim();
  if (text === t("工作項目說明")) return "desc";
  if (text === t("重現步驟") || text === t("驗收條件")) return "details";
  if (text === t("系統資訊")) return "sysinfo";
  if (countPattern((n) => t("相關工作項目（{n}）", { n })).test(text)) return "relations";
  if (countPattern((n) => t("附件（{n}）", { n })).test(text)) return "attachments";
  if (countPattern((n) => t("留言（{n}）", { n })).test(text)) return "comments";
  return "other";
}

/** 留言標題「名字・2026-10-05 14:38」：名字與時間（本地時間；讀不出來是 null）。 */
export function parseCommentHeading(text: string): { name: string; at: number | null } {
  const sep = text.lastIndexOf("・");
  const tail = sep >= 0 ? text.slice(sep + 1).trim() : "";
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(tail);
  if (!m) return { name: text.trim(), at: null };
  const [, y, mo, d, h, mi] = m.map(Number);
  return { name: text.slice(0, sep).trim(), at: new Date(y, mo - 1, d, h, mi).getTime() };
}

/** 工作項目的標題「Bug 123：標題」拆成類型、編號、標題；不是這個格式時回傳 null。 */
export function splitWorkItemTitle(text: string): { kind: string; id: string; title: string } | null {
  const m = /^(.+?) (\d+)\s*[：:]\s*([\s\S]*)$/.exec(text.trim());
  return m ? { kind: m[1], id: m[2], title: m[3] } : null;
}

/** 欄位表裡的時間「2026-10-29 03:00」（本地時間）；讀不出來是 null。 */
export function parseFieldTime(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime();
}

/** 路徑的最後一段（區域、反覆項目：`專案\Sprint 102` → `Sprint 102`）。 */
export function lastSegment(path: string): string {
  const parts = path.split("\\").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 附件收起來時的摘要：檔名，同名的合併成「檔名 ×3」。 */
export function attachmentSummary(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
}

/** 收起來時標題後面顯示的摘要（第一段文字）。 */
function peekText(nodes: Element[]): string {
  const text = nodes
    .map((n) => n.textContent ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** 附件段落收起來時：檔名（附件方塊裡的檔名，沒有方塊時是清單的文字）。 */
function attachmentNames(nodes: Element[]): string {
  const names = nodes.flatMap((n) => [...n.querySelectorAll(".ado-att-name")].map((a) => a.textContent ?? ""));
  if (!names.length) return peekText(nodes);
  const text = attachmentSummary(names);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function chevron(): HTMLElement {
  const span = document.createElement("span");
  span.className = "ado-chevron";
  span.append(icon("chevron-right"));
  return span;
}

/** 從 `start` 開始、到下一個 `stop` 標籤之前的兄弟節點。 */
function takeUntil(start: Element | null, stop: string): Element[] {
  const out: Element[] = [];
  for (let el = start; el && el.tagName !== stop; el = el.nextElementSibling) out.push(el);
  return out;
}

export function decorateWorkItem(body: HTMLElement, opts: WorkItemLookOptions): void {
  if (body.querySelector(":scope > .ado-sec")) return;
  decorateFields(body);
  const sections: HTMLDetailsElement[] = [];
  for (let h2 = body.querySelector<HTMLElement>(":scope > h2"); h2; ) {
    const content = takeUntil(h2.nextElementSibling, "H2");
    const next = content.length ? content[content.length - 1].nextElementSibling : h2.nextElementSibling;
    const kind = sectionKind(h2.textContent ?? "");
    const sec = section(h2, content, kind, opts);
    sections.push(sec);
    h2 = next as HTMLElement | null;
  }
  if (sections.length > 1) sections[0].before(foldAllBar(sections));
}

function decorateFields(body: HTMLElement): void {
  const h1 = body.querySelector<HTMLElement>(":scope > h1");
  const table = body.querySelector<HTMLTableElement>(":scope > h1 + table");
  if (!h1 || !table || h1.closest(".ado-hero")) return;
  table.classList.add("ado-fields");
  const fields = new Map<string, HTMLTableCellElement>();
  for (const row of table.tBodies[0]?.rows ?? []) {
    const [label, value] = row.cells;
    if (label && value) fields.set(label.textContent?.trim() ?? "", value);
  }
  const text = (label: string) => fields.get(label)?.textContent?.trim() ?? "";
  const state = text(t("狀態"));
  const stateCell = fields.get(t("狀態"));
  if (stateCell && !stateCell.querySelector(".ado-state-dot")) stateCell.prepend(stateDot(state));

  const hero = document.createElement("header");
  hero.className = "ado-hero";
  h1.before(hero);
  // 標題：上面是類型標籤與編號，標題本身小一點。
  const parts = splitWorkItemTitle(h1.textContent ?? "");
  if (parts) {
    const kindRow = document.createElement("div");
    kindRow.className = "ado-hero-kind";
    const badge = document.createElement("span");
    badge.className = "ado-kind-badge";
    badge.dataset.kind = parts.kind.toLowerCase().replace(/\s+/g, "-");
    badge.textContent = parts.kind;
    const id = document.createElement("span");
    id.textContent = parts.id;
    kindRow.append(badge, id);
    hero.append(kindRow);
    h1.textContent = parts.title;
  }
  hero.append(h1);

  // 最常看的欄位：一排小標籤（滑鼠提示是欄位名稱）。
  const facts = document.createElement("div");
  facts.className = "ado-facts";
  const fact = (label: string, ...content: (Node | string)[]) => {
    const chip = document.createElement("span");
    chip.className = "ado-fact";
    chip.title = label;
    chip.append(...content);
    facts.append(chip);
    return chip;
  };
  if (state) {
    const name = document.createElement("b");
    name.textContent = state;
    const reason = text(t("原因"));
    const chip = fact(t("狀態"), stateDot(state), name);
    if (reason) {
      const r = document.createElement("span");
      r.className = "ado-fact-muted";
      r.textContent = `· ${reason}`;
      chip.append(r);
      chip.title = t("狀態") + " · " + t("原因");
    }
  }
  const assignee = text(t("指派給"));
  if (assignee) {
    const avatar = document.createElement("span");
    avatar.className = "ado-fact-avatar";
    avatar.textContent = shortcutInitial(assignee);
    avatar.style.setProperty("--hue", String(shortcutHue(assignee)));
    fact(t("指派給"), avatar, assignee);
  }
  const priority = text(t("優先順序"));
  if (priority) fact(t("優先順序"), `P${priority}`);
  const iteration = text(t("反覆項目"));
  if (iteration) fact(t("反覆項目") + "\n" + iteration, icon("calendar"), lastSegment(iteration));
  const changed = parseFieldTime(text(t("最後更新")));
  if (changed !== null) {
    const chip = fact(t("最後更新") + "\n" + text(t("最後更新")), t("更新於 {ago}", { ago: timeAgo(changed) }));
    chip.classList.add("ado-fact-muted");
  }
  hero.append(facts);

  // 其他欄位收起來：摘要是專案、區域、建立者與標籤，展開是完整的欄位表。
  const more = document.createElement("details");
  more.className = "ado-more-fields";
  const summary = document.createElement("summary");
  const brief = [text(t("專案")), text(t("區域")) && lastSegment(text(t("區域"))), text(t("建立者")) && t("建立者 {name}", { name: text(t("建立者")) })]
    .filter(Boolean)
    .join("・");
  const label = document.createElement("span");
  label.textContent = t("詳細欄位");
  const briefEl = document.createElement("span");
  briefEl.className = "ado-more-brief";
  briefEl.textContent = brief;
  summary.append(icon("chevron-right"), label, briefEl);
  for (const tag of text(t("標籤")).split(/[、,]\s*/).filter(Boolean)) {
    const chip = document.createElement("span");
    chip.className = "ado-field-tag";
    chip.textContent = tag;
    summary.append(chip);
  }
  more.append(summary, table);
  hero.append(more);
  // 「在瀏覽器開啟」：頂端列已經有同樣的按鈕，畫面上不重複（複製成 Markdown 文件時還在）。
  const web = hero.nextElementSibling;
  // （連結後面可能多了狀態標籤，所以只看第一個連結。）
  if (web?.tagName === "P" && web.querySelector(":scope > a")?.textContent?.trim() === t("在瀏覽器開啟")) web.remove();
}

function stateDot(state: string): HTMLElement {
  const dot = document.createElement("span");
  dot.className = `ado-state-dot ${stateTone(state)}`;
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

/** 一個段落包成卡片：標題列（圖示、標題、收起來時的摘要），內容在下面。 */
function section(h2: HTMLElement, content: Element[], kind: SectionKind, opts: WorkItemLookOptions): HTMLDetailsElement {
  const sec = document.createElement("details");
  sec.className = "ado-sec";
  sec.dataset.kind = kind;
  h2.before(sec);
  const head = document.createElement("summary");
  head.className = "ado-sec-head";
  const ico = document.createElement("span");
  ico.className = "ado-sec-icon";
  ico.append(icon(SECTION_ICONS[kind]));
  const peek = document.createElement("span");
  peek.className = "ado-peek";
  peek.textContent = kind === "comments" ? "" : kind === "attachments" ? attachmentNames(content) : peekText(content);
  head.append(chevron(), ico, h2, peek);
  const box = document.createElement("div");
  box.className = "ado-sec-body";
  box.append(...content);
  sec.append(head, box);
  if (kind === "comments") comments(sec, head, box, opts);
  sec.open = !opts.folded.has(kind);
  sec.addEventListener("toggle", () => {
    opts.onFold(kind, !sec.open);
    if (sec.open) clampLong(sec);
  });
  return sec;
}

/** 「全部收合／全部展開」：放在第一張卡片前面。 */
function foldAllBar(sections: HTMLDetailsElement[]): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "ado-tools";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-small ado-fold-all";
  const label = () => {
    const anyOpen = sections.some((s) => s.open);
    b.replaceChildren(icon(anyOpen ? "chevrons-down-up" : "chevrons-up-down"), anyOpen ? t("全部收合") : t("全部展開"));
  };
  b.addEventListener("click", () => {
    const open = !sections.some((s) => s.open);
    for (const s of sections) s.open = open;
    label();
  });
  for (const s of sections) s.addEventListener("toggle", label);
  label();
  bar.append(b);
  return bar;
}

/** 留言段落：每則一張對話卡片，標題列加上「最新的在上面／下面」。 */
function comments(sec: HTMLDetailsElement, head: HTMLElement, box: HTMLElement, opts: WorkItemLookOptions): void {
  const cards: HTMLElement[] = [];
  for (let h3 = box.querySelector<HTMLElement>(":scope > h3"); h3; ) {
    const content = takeUntil(h3.nextElementSibling, "H3");
    const next = content.length ? content[content.length - 1].nextElementSibling : h3.nextElementSibling;
    cards.push(comment(h3, content, opts));
    h3 = next as HTMLElement | null;
  }
  if (!cards.length) return;
  // Markdown 裡是舊到新：最新的幾則（和新留言）展開，其他收成一行。
  cards.forEach((c, i) => {
    const card = c.querySelector<HTMLDetailsElement>(".ado-card")!;
    card.open = i >= cards.length - OPEN_COMMENTS || card.dataset.new === "1";
  });
  const list = document.createElement("div");
  list.className = "ado-comments";
  list.append(...(opts.newestFirst ? [...cards].reverse() : cards));
  box.replaceChildren(list);

  const sort = document.createElement("button");
  sort.type = "button";
  sort.className = "ado-sort";
  let newestFirst = opts.newestFirst;
  const label = () => sort.replaceChildren(icon("arrow-down-up"), newestFirst ? t("最新的在上面") : t("最舊的在上面"));
  label();
  sort.title = t("切換留言的排列順序");
  sort.addEventListener("click", (e) => {
    // 按鈕在 <summary> 裡：不要順便收合整個段落。
    e.preventDefault();
    e.stopPropagation();
    newestFirst = !newestFirst;
    list.append(...[...list.children].reverse());
    label();
    opts.onOrder(newestFirst);
  });
  head.append(sort);
  requestAnimationFrame(() => clampLong(sec));
}

function comment(h3: HTMLElement, content: Element[], opts: WorkItemLookOptions): HTMLElement {
  const { name, at } = parseCommentHeading(h3.textContent ?? "");
  const wrap = document.createElement("div");
  wrap.className = "ado-comment";
  const avatar = document.createElement("span");
  avatar.className = "ado-avatar";
  avatar.textContent = shortcutInitial(name);
  avatar.style.setProperty("--hue", String(shortcutHue(name)));
  avatar.setAttribute("aria-hidden", "true");
  const card = document.createElement("details");
  card.className = "ado-card";
  const head = document.createElement("summary");
  head.className = "ado-card-head";
  // 標題：名字（粗體）＋「幾天前」（滑鼠移上去看完整時間）。
  const time = document.createElement("span");
  time.className = "ado-comment-time";
  if (at !== null) {
    time.textContent = timeAgo(at);
    time.title = new Date(at).toLocaleString();
  }
  const who = document.createElement("span");
  who.className = "ado-comment-name";
  who.textContent = name;
  h3.replaceChildren(who, time);
  const peek = document.createElement("span");
  peek.className = "ado-peek";
  peek.textContent = peekText(content);
  head.append(chevron(), h3);
  if (at !== null && opts.seenAt !== null && at > opts.seenAt) {
    card.dataset.new = "1";
    const badge = document.createElement("span");
    badge.className = "ado-new";
    badge.textContent = t("新");
    badge.title = t("上次看過之後的新留言");
    head.append(badge);
  }
  head.append(peek);
  const body = document.createElement("div");
  body.className = "ado-card-body";
  body.append(...content);
  card.append(head, body);
  card.addEventListener("toggle", () => {
    if (card.open) clampLong(card);
  });
  wrap.append(avatar, card);
  return wrap;
}

/** 很長的留言先只顯示前面一段，下面一個「顯示全部」。 */
function clampLong(root: Element): void {
  for (const body of root.querySelectorAll<HTMLElement>("details[open] > .ado-card-body:not([data-measured])")) {
    if (!body.isConnected || !body.offsetParent) continue;
    body.dataset.measured = "1";
    if (body.scrollHeight <= LONG_COMMENT + 80) continue;
    body.classList.add("clamped");
    const more = document.createElement("button");
    more.type = "button";
    more.className = "clamp-more";
    more.textContent = t("顯示全部");
    more.addEventListener("click", () => {
      body.classList.remove("clamped");
      more.remove();
    });
    body.after(more);
  }
}
