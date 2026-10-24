/**
 * Git 歷史（主要區域的分頁）：左邊是線圖與提交清單，右邊是選取的提交內容與差異。
 *
 * - 線圖：每條分支一個顏色，合併處用曲線；目前的位置（HEAD）外圈標示；還沒提交的變更是最上面的虛線圓點。
 *   滑鼠移到某一列時，同一條線亮起來、其他的淡掉。
 * - 只畫看得到的那幾列（上萬個提交也順），捲到底再載入下一批。
 * - 操作：右鍵選單、拖曳分支標記到目前的分支（合併）、拖曳提交到目前的分支（挑選提交）；
 *   會改變目前位置的操作完成後，通知上有「復原」。
 */
import { getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { formatKeys } from "../commands.ts";
import type { ChangedFile, ChangeList, CommitDetail, Desktop, GitConflict, GitOpResult, GitRef, GitStatus, LogCommit } from "../desktop.ts";
import { GraphBuilder, type GraphRow, type Segment } from "../git-graph.ts";
import { activity, colorIndex, commitWebUrl, initials, level } from "../git-history-text.ts";
import { timeAgo, versionTitle } from "../history-label.ts";
import { t } from "../i18n.ts";
import { askText, choose } from "./choice.ts";
import { icon } from "./icons.ts";
import { placeMenu } from "./menu-place.ts";
import * as storage from "../storage.ts";
import { toast } from "./toast.ts";

const ROW = 32;
const LANE = 14;
const PAGE = 300;
const WORKTREE = "__worktree__";
const DRAG_TYPE = "application/x-omarker-git";
const SVG = "http://www.w3.org/2000/svg";

export interface HistoryHooks {
  status(): GitStatus | null;
  /** 有分頁還沒存檔（會動到檔案的操作先請使用者存檔）。 */
  hasUnsaved(): boolean;
  openFile(absPath: string): Promise<void>;
  /** 在編輯器開啟檔案，和這個版本逐段比較（可以採用這一版的內容）。 */
  compareWithCurrent(absPath: string, commit: { id: string; short: string; summary: string }): Promise<void>;
  openUrl(url: string): void;
  /** 合併有衝突時，交給原始碼控制面板逐段處理。 */
  resolveConflicts(conflicts: GitConflict[]): void;
  /** 儲存庫改變了（更新原始碼控制面板、檔案樹）。 */
  changed(): Promise<void>;
  pull(): Promise<void>;
  push(): Promise<void>;
  commit(): void;
  closed(): void;
}

type Item = { kind: "worktree"; count: number } | { kind: "commit"; c: LogCommit };

interface MenuItem {
  label: string;
  icon: string;
  run(): void;
  danger?: boolean;
  disabled?: boolean;
}

const short = (id: string) => id.slice(0, 7);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function iconButton(label: string, iconName: string, run: () => void, keys?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn icon-only";
  b.title = keys ? t("{label}（{keys}）", { label, keys: formatKeys(keys) }) : label;
  b.setAttribute("aria-label", label);
  b.append(icon(iconName));
  b.addEventListener("click", run);
  return b;
}

function textButton(label: string, iconName: string, run: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn btn-small${primary ? " btn-primary" : ""}`;
  b.append(icon(iconName), label);
  b.addEventListener("click", run);
  return b;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 線圖上一段線的路徑（同一條線是直線，換線時是平滑的曲線）。 */
function segmentPath(s: Segment, y1: number, y2: number): string {
  const x1 = LANE / 2 + 4 + s.from * LANE;
  const x2 = LANE / 2 + 4 + s.to * LANE;
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const k = (y2 - y1) * 0.55;
  return `M${x1} ${y1}C${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}`;
}

function avatar(name: string, email: string): HTMLElement {
  const a = el("span", `gh-avatar gh-a${colorIndex(email || name)}`, initials(name));
  a.setAttribute("aria-hidden", "true");
  return a;
}

const STATUS_MARK: Record<ChangedFile["status"], string> = { added: "A", deleted: "D", modified: "M", renamed: "R" };

export class GitHistory {
  #d: Desktop;
  #h: HistoryHooks;
  #workspace: HTMLElement;
  #pane: HTMLElement;
  #list: HTMLElement;
  #inner: HTMLElement;
  #detail: HTMLElement;
  #statsBox: HTMLElement;
  #scope: HTMLSelectElement;
  #search: HTMLInputElement;
  #pathChip: HTMLElement;
  #branchLabel: HTMLElement;

  #items: Item[] = [];
  #rows: GraphRow[] = [];
  #builder = new GraphBuilder();
  #head: string | null = null;
  #more = false;
  #loading = false;
  #skip = 0;
  #seq = 0;
  #detailSeq = 0;
  #selected = 0;
  /** Ctrl＋點選的第二個提交（比較兩個版本）。 */
  #second: number | null = null;
  #path: string | null = null;
  #searchTimer = 0;
  #menu: HTMLElement | null = null;
  #diffViews: EditorView[] = [];

  constructor(workspace: HTMLElement, d: Desktop, hooks: HistoryHooks) {
    this.#workspace = workspace;
    this.#d = d;
    this.#h = hooks;
    const pane = el("section", "pane issue-pane history-pane");
    pane.hidden = true;
    pane.setAttribute("aria-label", t("Git 歷史"));
    pane.tabIndex = -1;

    const head = el("header", "issue-head gh-head");
    const heading = el("div", "issue-heading");
    this.#branchLabel = el("span", "issue-label");
    heading.append(this.#branchLabel, el("h2", "issue-title", t("Git 歷史")));
    this.#scope = el("select", "gh-scope");
    this.#scope.setAttribute("aria-label", t("顯示哪些分支"));
    this.#scope.append(new Option(t("所有分支"), "all"), new Option(t("目前的分支"), "head"));
    this.#scope.addEventListener("change", () => void this.reload());
    this.#search = el("input", "gh-search");
    this.#search.type = "search";
    this.#search.placeholder = t("搜尋說明、作者、提交編號…");
    this.#search.setAttribute("aria-label", t("搜尋提交"));
    this.#search.addEventListener("input", () => {
      clearTimeout(this.#searchTimer);
      this.#searchTimer = window.setTimeout(() => void this.reload(), 250);
    });
    this.#pathChip = el("span", "gh-chip");
    this.#pathChip.hidden = true;
    const actions = el("div", "issue-actions");
    // 活動統計：按鈕下方的浮動卡片（點外面或按 Esc 關閉），不會把提交清單往下推。
    const statsButton = iconButton(t("活動統計"), "chart-column", () => {});
    this.#statsBox = el("div", "gh-stats");
    this.#statsBox.popover = "auto";
    this.#statsBox.setAttribute("role", "dialog");
    this.#statsBox.setAttribute("aria-label", t("活動統計"));
    statsButton.popoverTargetElement = this.#statsBox;
    this.#statsBox.addEventListener("toggle", (e) => {
      const open = (e as ToggleEvent).newState === "open";
      statsButton.setAttribute("aria-expanded", String(open));
      if (open) void this.#showStats(statsButton);
    });
    actions.append(
      this.#scope,
      this.#search,
      this.#pathChip,
      statsButton,
      iconButton(t("拉取"), "arrow-down", () => void this.#h.pull().then(() => this.reload())),
      iconButton(t("推送"), "arrow-up", () => void this.#h.push().then(() => this.reload())),
      iconButton(t("重新整理"), "refresh-cw", () => void this.reload()),
      iconButton(t("關閉"), "x", () => this.close(), "Escape"),
    );
    head.append(heading, actions);


    const body = el("div", "gh-body");
    this.#list = el("div", "gh-list");
    this.#list.tabIndex = 0;
    this.#list.setAttribute("role", "listbox");
    this.#list.setAttribute("aria-label", t("提交清單"));
    this.#inner = el("div", "gh-inner");
    this.#list.append(this.#inner);
    this.#list.addEventListener("scroll", () => this.#paint());
    this.#list.addEventListener("keydown", (e) => this.#keydown(e));
    this.#list.addEventListener("click", (e) => this.#click(e));
    this.#list.addEventListener("contextmenu", (e) => this.#contextMenu(e));
    this.#list.addEventListener("dblclick", (e) => {
      const ref = (e.target as HTMLElement).closest<HTMLElement>(".gh-ref");
      if (ref?.dataset.kind === "branch" || ref?.dataset.kind === "remote") void this.#checkout(ref.dataset.name!, ref.dataset.kind);
    });
    this.#list.addEventListener("mouseover", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".gh-row");
      if (row?.dataset.color) this.#list.dataset.hl = row.dataset.color;
    });
    this.#list.addEventListener("mouseleave", () => delete this.#list.dataset.hl);
    this.#setupDrag();
    this.#detail = el("div", "gh-detail");
    body.append(this.#list, this.#detail);
    this.#setupResize(body);
    pane.append(head, this.#statsBox, body);
    pane.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement) && !e.defaultPrevented) {
        e.preventDefault();
        // 統計卡片開著時，Esc 只關卡片。
        if (this.#statsBox.matches(":popover-open")) this.#statsBox.hidePopover();
        else this.close();
      }
    });
    new ResizeObserver(() => this.#paint()).observe(this.#list);
    workspace.querySelector(".outline-right")?.before(pane) ?? workspace.append(pane);
    this.#pane = pane;
  }

  get isOpen(): boolean {
    return !this.#pane.hidden;
  }

  /** 開啟；`path` 是檔案的絕對路徑時，只列出改過這個檔案的提交。 */
  async open(opts: { path?: string | null } = {}): Promise<void> {
    this.#path = opts.path ?? null;
    this.#pathChip.hidden = !this.#path;
    if (this.#path) {
      const name = this.#path.slice(Math.max(this.#path.lastIndexOf("/"), this.#path.lastIndexOf("\\")) + 1);
      this.#pathChip.replaceChildren(icon("file-text"), el("span", undefined, name));
      this.#pathChip.title = t("只列出改過這個檔案的提交");
      const clear = iconButton(t("顯示所有提交"), "x", () => void this.open());
      this.#pathChip.append(clear);
    }
    this.#pane.hidden = false;
    this.#workspace.classList.add("history-open");
    await this.reload();
    this.#list.focus();
  }

  /**
   * 右邊詳細內容的寬度：拖曳中間的分隔線調整（方向鍵也可以），雙擊恢復預設；寬度會記住。
   * 左邊的提交清單至少留 320px。
   */
  #setupResize(body: HTMLElement): void {
    const KEY = "git-history-detail-width";
    const MIN = 280;
    const handle = el("div", "gh-resizer");
    handle.role = "separator";
    handle.tabIndex = 0;
    handle.title = t("拖曳調整寬度（雙擊恢復）");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", t("調整詳細內容的寬度（方向鍵調整，雙擊恢復）"));
    const clamp = (px: number) => Math.round(Math.max(MIN, Math.min(px, body.clientWidth - 320)));
    const apply = (px: number | null, save = true) => {
      if (px === null) {
        body.style.removeProperty("--gh-detail-width");
        if (save) storage.remove(KEY);
        return;
      }
      const w = clamp(px);
      body.style.setProperty("--gh-detail-width", `${w}px`);
      handle.setAttribute("aria-valuenow", String(w));
      if (save) storage.save(KEY, String(w));
    };
    const saved = Number(storage.load(KEY));
    if (saved > 0) body.style.setProperty("--gh-detail-width", `${saved}px`);
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing");
      const startX = e.clientX;
      const startWidth = this.#detail.getBoundingClientRect().width;
      // 往左拖是變寬。
      const move = (ev: PointerEvent) => apply(startWidth - (ev.clientX - startX), false);
      const up = () => {
        handle.removeEventListener("pointermove", move);
        document.body.classList.remove("resizing");
        apply(this.#detail.getBoundingClientRect().width);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
      handle.addEventListener("pointercancel", up, { once: true });
    });
    handle.addEventListener("dblclick", () => apply(null));
    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 64 : 16;
      const w = this.#detail.getBoundingClientRect().width;
      if (e.key === "ArrowLeft") apply(w + step);
      else if (e.key === "ArrowRight") apply(w - step);
      else return;
      e.preventDefault();
    });
    body.append(handle);
  }

  close(): void {
    if (this.#statsBox.matches(":popover-open")) this.#statsBox.hidePopover();
    if (!this.isOpen) return;
    this.#seq++;
    this.#closeMenu();
    this.#disposeDiffs();
    this.#pane.hidden = true;
    this.#workspace.classList.remove("history-open");
    this.#h.closed();
  }

  /** 儲存庫改變了（提交、拉取、切換分支）：開著時重新載入。 */
  refresh(): void {
    if (this.isOpen && !this.#loading) void this.reload(true);
  }

  // ---- 載入 ---------------------------------------------------------------

  get #filtered(): boolean {
    return !!this.#search.value.trim() || !!this.#path;
  }

  async reload(keepSelection = false): Promise<void> {
    const seq = ++this.#seq;
    const keep = keepSelection ? this.#idAt(this.#selected) : null;
    this.#items = [];
    this.#rows = [];
    this.#builder = new GraphBuilder();
    this.#skip = 0;
    this.#more = false;
    this.#second = null;
    const status = this.#h.status();
    this.#branchLabel.textContent = status?.branch ? t("目前在「{branch}」", { branch: status.branch.name }) : "";
    const changes = status?.changes.length ?? 0;
    this.#inner.replaceChildren(el("div", "gh-loading", t("讀取中…")));
    await this.#loadMore(seq, changes);
    if (seq !== this.#seq) return;
    const index = keep ? this.#items.findIndex((it) => this.#itemId(it) === keep) : -1;
    this.#select(index >= 0 ? index : 0, true);
  }

  async #loadMore(seq = this.#seq, worktreeChanges = 0): Promise<void> {
    if (this.#loading && seq === this.#seq) return;
    this.#loading = true;
    try {
      const page = await this.#d.gitLog(
        this.#skip,
        PAGE,
        this.#scope.value === "all",
        this.#path,
        this.#search.value.trim() || null,
      );
      if (seq !== this.#seq) return;
      if (!this.#skip) {
        this.#head = page.head;
        if (worktreeChanges && !this.#filtered && page.head) {
          this.#items.push({ kind: "worktree", count: worktreeChanges });
          this.#rows.push(this.#builder.add({ id: WORKTREE, parents: [page.head] }));
        }
      }
      for (const c of page.commits) {
        this.#items.push({ kind: "commit", c });
        this.#rows.push(this.#builder.add(c));
      }
      this.#skip += page.commits.length;
      this.#more = page.more;
      if (!this.#items.length) {
        this.#inner.replaceChildren(el("div", "gh-loading", this.#filtered ? t("找不到符合的提交") : t("還沒有任何提交")));
        this.#detail.replaceChildren();
        return;
      }
      this.#paint(true);
    } catch (e) {
      if (seq === this.#seq) this.#inner.replaceChildren(el("div", "gh-loading gh-error", errorText(e)));
    } finally {
      if (seq === this.#seq) this.#loading = false;
    }
  }

  #itemId(it: Item | undefined): string | null {
    if (!it) return null;
    return it.kind === "worktree" ? WORKTREE : it.c.id;
  }

  #idAt(i: number): string | null {
    return this.#itemId(this.#items[i]);
  }

  // ---- 畫清單 -------------------------------------------------------------

  #graphWidth(): number {
    return this.#filtered ? LANE + 8 : Math.min(this.#builder.width, 16) * LANE + 8;
  }

  #paint(force = false): void {
    if (!this.isOpen || !this.#items.length) return;
    const n = this.#items.length;
    this.#inner.style.height = `${n * ROW}px`;
    const top = this.#list.scrollTop;
    const height = this.#list.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW) - 10);
    const last = Math.min(n, Math.ceil((top + height) / ROW) + 10);
    if (!force && this.#inner.dataset.range === `${first}-${last}`) return;
    this.#inner.dataset.range = `${first}-${last}`;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.append(this.#row(i));
    this.#inner.replaceChildren(frag);
    // 捲到接近底部時載入下一批。
    if (this.#more && !this.#loading && last >= n - 30) void this.#loadMore();
  }

  #row(i: number): HTMLElement {
    const it = this.#items[i];
    const g = this.#rows[i];
    const row = el("div", "gh-row");
    row.style.transform = `translateY(${i * ROW}px)`;
    row.dataset.i = String(i);
    row.id = `gh-row-${i}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === this.#selected));
    if (i === this.#second) row.classList.add("gh-second");
    row.dataset.color = String(g.color);
    row.append(this.#graph(it, g));
    if (it.kind === "worktree") {
      row.classList.add("gh-worktree");
      const label = t("還沒提交的變更（{n} 個檔案）", { n: it.count });
      row.append(el("span", "gh-summary", label));
      row.setAttribute("aria-label", label);
      return row;
    }
    const c = it.c;
    row.draggable = true;
    const refs = el("span", "gh-refs");
    for (const r of c.refs) refs.append(this.#refPill(r));
    const summary = el("span", "gh-summary", c.summary || t("（沒有說明）"));
    const marks = el("span", "gh-marks");
    if (c.unpushed) marks.append(Object.assign(el("span", "gh-mark gh-up", "↑"), { title: t("還沒推送") }));
    if (c.unpulled) marks.append(Object.assign(el("span", "gh-mark gh-down", "↓"), { title: t("遠端有、還沒拉取") }));
    const when = el("time", "gh-time", timeAgo(c.time * 1000));
    when.title = versionTitle(c.time * 1000);
    row.append(refs, summary, marks, avatar(c.author, c.email), el("span", "gh-author", c.author), when);
    if (c.id === this.#head) row.classList.add("gh-current");
    const refText = c.refs.map((r) => r.name).join(t("、"));
    row.setAttribute(
      "aria-label",
      [c.summary, refText && t("在 {refs}", { refs: refText }), c.author, timeAgo(c.time * 1000)].filter(Boolean).join(t("，")),
    );
    return row;
  }

  #graph(it: Item, g: GraphRow): SVGSVGElement {
    const w = this.#graphWidth();
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "gh-graph");
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(ROW));
    svg.setAttribute("aria-hidden", "true");
    const mid = ROW / 2;
    const path = (d: string, color: number) => {
      const p = document.createElementNS(SVG, "path");
      p.setAttribute("d", d);
      p.setAttribute("class", `c${color}`);
      svg.append(p);
    };
    if (!this.#filtered) {
      for (const s of g.top) path(segmentPath(s, 0, mid), s.color);
      for (const s of g.bottom) path(segmentPath(s, mid, ROW), s.color);
    }
    const cx = this.#filtered ? LANE / 2 + 4 : LANE / 2 + 4 + g.lane * LANE;
    const dot = document.createElementNS(SVG, "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(mid));
    if (it.kind === "worktree") {
      dot.setAttribute("r", "5");
      dot.setAttribute("class", `c${g.color} gh-dot-worktree`);
    } else {
      const merge = it.c.parents.length > 1;
      dot.setAttribute("r", merge ? "3.5" : "5");
      dot.setAttribute("class", `c${g.color} gh-dot`);
      if (it.c.id === this.#head) {
        const ring = document.createElementNS(SVG, "circle");
        ring.setAttribute("cx", String(cx));
        ring.setAttribute("cy", String(mid));
        ring.setAttribute("r", "8.5");
        ring.setAttribute("class", `c${g.color} gh-ring`);
        svg.append(ring);
      }
    }
    svg.append(dot);
    return svg;
  }

  #refPill(r: GitRef): HTMLElement {
    const pill = el("span", `gh-ref gh-ref-${r.kind}`);
    pill.dataset.name = r.name;
    pill.dataset.kind = r.kind;
    pill.append(icon(r.kind === "tag" ? "tag" : r.kind === "remote" ? "cloud" : "git-branch"), el("span", undefined, r.name));
    pill.title =
      r.kind === "head"
        ? t("目前的分支：把其他分支或提交拖到這裡，合併或套用進來")
        : r.kind === "branch"
          ? t("分支：按兩下切換；拖到目前的分支上就是合併")
          : r.kind === "remote"
            ? t("遠端的分支：按兩下切換；拖到目前的分支上就是合併")
            : t("標籤");
    if (r.kind === "branch" || r.kind === "remote") pill.draggable = true;
    return pill;
  }

  // ---- 選取 ---------------------------------------------------------------

  #select(i: number, scroll = false): void {
    if (!this.#items.length) return;
    i = Math.max(0, Math.min(this.#items.length - 1, i));
    this.#selected = i;
    this.#list.setAttribute("aria-activedescendant", `gh-row-${i}`);
    if (scroll) {
      const top = i * ROW;
      if (top < this.#list.scrollTop) this.#list.scrollTop = top;
      else if (top + ROW > this.#list.scrollTop + this.#list.clientHeight) this.#list.scrollTop = top + ROW - this.#list.clientHeight;
    }
    this.#paint(true);
    void this.#showDetail();
  }

  #click(e: MouseEvent): void {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".gh-row");
    if (!row) return;
    const i = Number(row.dataset.i);
    if ((e.ctrlKey || e.metaKey) && this.#items[i]?.kind === "commit" && i !== this.#selected) {
      this.#second = this.#second === i ? null : i;
      this.#paint(true);
      void this.#showDetail();
      return;
    }
    this.#second = null;
    this.#select(i);
  }

  #keydown(e: KeyboardEvent): void {
    const page = Math.max(1, Math.floor(this.#list.clientHeight / ROW) - 1);
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    if (e.key in moves) {
      e.preventDefault();
      this.#second = null;
      this.#select(this.#selected + moves[e.key], true);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      this.#select(e.key === "Home" ? 0 : this.#items.length - 1, true);
    } else if (e.key === " ") {
      // 空白鍵：把下一個提交當成比較的對象（再按一次取消）。
      e.preventDefault();
      const next = this.#selected + 1;
      if (this.#items[next]?.kind === "commit") {
        this.#second = this.#second === next ? null : next;
        this.#paint(true);
        void this.#showDetail();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.#detail.querySelector<HTMLElement>("button, [tabindex]")?.focus();
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const row = this.#inner.querySelector<HTMLElement>(`[data-i="${this.#selected}"]`);
      const box = row?.getBoundingClientRect();
      if (box) this.#openRowMenu(this.#selected, box.left + 40, box.bottom);
    }
  }

  // ---- 右邊的內容 -----------------------------------------------------------

  #disposeDiffs(): void {
    for (const v of this.#diffViews) v.destroy();
    this.#diffViews = [];
  }

  async #showDetail(): Promise<void> {
    const seq = ++this.#detailSeq;
    this.#disposeDiffs();
    const it = this.#items[this.#selected];
    if (!it) return;
    const loading = el("p", "gh-loading", t("讀取中…"));
    this.#detail.replaceChildren(loading);
    try {
      if (it.kind === "worktree") {
        const changes = await this.#d.gitWorktreeChanges();
        if (seq !== this.#detailSeq) return;
        this.#renderWorktree(changes);
        return;
      }
      const other = this.#second !== null ? this.#items[this.#second] : null;
      if (other?.kind === "commit") {
        // 清單上越下面越舊：從舊的比到新的。
        const [older, newer] = this.#second! > this.#selected ? [other.c, it.c] : [it.c, other.c];
        const changes = await this.#d.gitCompare(older.id, newer.id);
        if (seq !== this.#detailSeq) return;
        this.#renderCompare(older, newer, changes);
        return;
      }
      const detail = await this.#d.gitCommitDetail(it.c.id);
      if (seq !== this.#detailSeq) return;
      this.#renderCommit(it.c, detail);
    } catch (e) {
      if (seq !== this.#detailSeq) return;
      loading.textContent = errorText(e);
      loading.classList.add("gh-error");
    }
  }

  #renderWorktree(changes: ChangeList): void {
    const box = el("div", "gh-detail-inner");
    box.append(
      el("h3", "gh-detail-title", t("還沒提交的變更")),
      el("p", "gh-detail-meta", t("這些修改還在電腦上，提交之後才會出現在歷史裡。")),
    );
    const actions = el("div", "gh-actions");
    actions.append(textButton(t("到原始碼控制提交"), "git-commit-horizontal", () => this.#h.commit(), true));
    box.append(actions, this.#fileList(changes, null, null));
    this.#detail.replaceChildren(box);
  }

  #renderCompare(older: LogCommit, newer: LogCommit, changes: ChangeList): void {
    const box = el("div", "gh-detail-inner");
    box.append(
      el("h3", "gh-detail-title", t("比較兩個版本")),
      el(
        "p",
        "gh-detail-meta",
        t("從 {a}（{as}）到 {b}（{bs}）", { a: short(older.id), as: older.summary, b: short(newer.id), bs: newer.summary }),
      ),
      el("p", "gh-hint", t("按住 Ctrl 再點一次可以取消比較。")),
      this.#fileList(changes, older.id, newer.id),
    );
    this.#detail.replaceChildren(box);
  }

  #renderCommit(c: LogCommit, d: CommitDetail): void {
    const box = el("div", "gh-detail-inner");
    const [title, ...rest] = d.message.split("\n");
    box.append(el("h3", "gh-detail-title", title || t("（沒有說明）")));
    const body = rest.join("\n").trim();
    if (body) box.append(el("p", "gh-message", body));
    if (c.refs.length) {
      const refs = el("div", "gh-refs gh-detail-refs");
      for (const r of c.refs) refs.append(this.#refPill(r));
      box.append(refs);
    }
    const meta = el("div", "gh-detail-meta");
    const who = el("span", "gh-who");
    who.append(avatar(d.author, d.email), el("strong", undefined, d.author));
    if (d.email) who.append(el("span", "gh-email", `<${d.email}>`));
    meta.append(who, el("span", undefined, versionTitle(d.time * 1000)));
    if (d.committer && d.committer !== d.author) meta.append(el("span", undefined, t("由 {name} 提交", { name: d.committer })));
    box.append(meta);

    const ids = el("div", "gh-ids");
    const copy = el("button", "gh-id", short(d.id));
    copy.type = "button";
    copy.title = t("複製提交編號");
    copy.addEventListener("click", () => void this.#copy(d.id));
    ids.append(el("span", undefined, t("提交")), copy);
    if (d.parents.length) {
      ids.append(el("span", undefined, d.parents.length > 1 ? t("合併自") : t("上一個")));
      for (const p of d.parents) {
        const b = el("button", "gh-id", short(p));
        b.type = "button";
        b.title = t("跳到這個提交");
        b.addEventListener("click", () => this.#jumpTo(p));
        ids.append(b);
      }
    }
    if (c.unpushed) ids.append(el("span", "gh-mark gh-up", t("↑ 還沒推送")));
    if (c.unpulled) ids.append(el("span", "gh-mark gh-down", t("↓ 還沒拉取")));
    box.append(ids);

    const actions = el("div", "gh-actions");
    actions.append(
      textButton(t("建立分支…"), "git-branch", () => void this.#branchFrom(c)),
      textButton(t("加上標籤…"), "tag", () => void this.#tag(c)),
    );
    const more = textButton(t("更多"), "ellipsis", () => {
      const r = more.getBoundingClientRect();
      this.#openRowMenu(this.#selected, r.left, r.bottom);
    });
    actions.append(more);
    box.append(actions, this.#fileList(d.changes, null, d.id, c));
    this.#detail.replaceChildren(box);
  }

  #jumpTo(id: string): void {
    const i = this.#items.findIndex((it) => it.kind === "commit" && it.c.id === id);
    if (i >= 0) {
      this.#second = null;
      this.#select(i, true);
    } else toast(t("這個提交在清單的更下面，請往下捲動載入。"));
  }

  /** 改了哪些檔案；按一下展開差異。`to` 是 null 時是工作目錄。 */
  #fileList(changes: ChangeList, from: string | null, to: string | null, commit?: LogCommit): HTMLElement {
    const wrap = el("div", "gh-files");
    const add = changes.files.reduce((n, f) => n + f.additions, 0);
    const del = changes.files.reduce((n, f) => n + f.deletions, 0);
    const summary = el("div", "gh-files-summary");
    summary.append(
      el("span", undefined, t("改了 {n} 個檔案", { n: changes.files.length })),
      el("span", "gh-add", `+${add}`),
      el("span", "gh-del", `−${del}`),
    );
    wrap.append(summary);
    if (!changes.files.length) wrap.append(el("p", "gh-hint", t("沒有檔案內容的變更。")));
    for (const f of changes.files) {
      const item = el("div", "gh-file");
      const head = el("button", "gh-file-head");
      head.type = "button";
      head.setAttribute("aria-expanded", "false");
      const name = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
      head.append(
        icon("chevron-right"),
        el("span", `gh-status gh-status-${f.status}`, STATUS_MARK[f.status]),
        el("span", "gh-file-name", name),
        el("span", "gh-add", f.binary ? "" : `+${f.additions}`),
        el("span", "gh-del", f.binary ? t("二進位檔") : `−${f.deletions}`),
      );
      head.title = name;
      const diff = el("div", "gh-diff");
      diff.hidden = true;
      head.addEventListener("click", () => {
        const open = diff.hidden;
        diff.hidden = !open;
        head.setAttribute("aria-expanded", String(open));
        if (open && !diff.childElementCount) void this.#loadDiff(diff, f, from, to);
      });
      const tools = el("div", "gh-file-tools");
      if (f.status !== "deleted") {
        tools.append(iconButton(t("開啟檔案"), "file-text", () => void this.#openFile(f.path)));
        if (commit && to) {
          tools.append(
            iconButton(t("和目前的檔案比較（可以採用這一版）"), "git-compare", () =>
              void this.#compareCurrent(f.path, commit).catch((e) => toast(errorText(e), { tone: "error" })),
            ),
          );
        }
      }
      const line = el("div", "gh-file-line");
      line.append(head, tools);
      item.append(line, diff);
      wrap.append(item);
    }
    if (changes.truncated) wrap.append(el("p", "gh-hint", t("檔案太多，只列出前面一部分。")));
    return wrap;
  }

  async #loadDiff(box: HTMLElement, f: ChangedFile, from: string | null, to: string | null): Promise<void> {
    if (f.binary) {
      box.append(el("p", "gh-hint", t("二進位檔（例如圖片），不顯示內容的差異。")));
      return;
    }
    box.append(el("p", "gh-hint", t("讀取中…")));
    try {
      const pair = await this.#d.gitFilePair(from, to, f.path, f.oldPath);
      box.replaceChildren();
      if (pair.note) {
        box.append(el("p", "gh-hint", pair.note));
        return;
      }
      const view = new EditorView({
        parent: box,
        state: EditorState.create({
          doc: pair.after ?? "",
          extensions: [
            EditorView.editable.of(false),
            EditorState.readOnly.of(true),
            EditorView.lineWrapping,
            unifiedMergeView({
              original: pair.before ?? "",
              mergeControls: false,
              gutter: true,
              collapseUnchanged: { margin: 3, minSize: 6 },
            }),
          ],
        }),
      });
      // 沒有差異（例如只改了權限）時說明一下。
      if (getOriginalDoc(view.state).toString() === view.state.doc.toString()) box.prepend(el("p", "gh-hint", t("內容沒有變更。")));
      this.#diffViews.push(view);
    } catch (e) {
      box.replaceChildren(el("p", "gh-hint gh-error", errorText(e)));
    }
  }

  async #openFile(rel: string): Promise<void> {
    try {
      await this.#h.openFile(await this.#d.gitAbsPath(rel));
    } catch (e) {
      toast(errorText(e), { tone: "error" });
    }
  }

  async #compareCurrent(rel: string, c: LogCommit): Promise<void> {
    const abs = await this.#d.gitAbsPath(rel);
    this.close();
    await this.#h.compareWithCurrent(abs, { id: c.id, short: short(c.id), summary: c.summary });
  }

  async #copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast(t("已複製"));
    } catch {
      toast(t("無法複製到剪貼簿"), { tone: "error" });
    }
  }

  // ---- 選單 ---------------------------------------------------------------

  #menuCleanup: (() => void) | null = null;

  #closeMenu(): void {
    this.#menuCleanup?.();
    this.#menuCleanup = null;
    this.#menu?.remove();
    this.#menu = null;
  }

  #showMenu(x: number, y: number, items: (MenuItem | "-")[]): void {
    this.#closeMenu();
    const menu = el("div", "menu gh-menu");
    // 自己處理「點外面關閉」：Linux 上按下右鍵時就會觸發 contextmenu，
    // 用瀏覽器的自動關閉會在放開按鍵時馬上把選單關掉。
    menu.popover = "manual";
    menu.setAttribute("role", "menu");
    for (const it of items) {
      if (it === "-") {
        menu.append(Object.assign(el("div", "menu-sep"), { role: "separator" }));
        continue;
      }
      const b = el("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.disabled = !!it.disabled;
      if (it.danger) b.classList.add("gh-danger");
      b.append(icon(it.icon), el("span", undefined, it.label));
      b.addEventListener("click", () => {
        this.#closeMenu();
        it.run();
      });
      menu.append(b);
    }
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        this.#closeMenu();
        this.#list.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    });
    (this.#pane.closest("dialog") ?? document.body).append(menu);
    menu.showPopover();
    const size = menu.getBoundingClientRect();
    const p = placeMenu({ left: x, top: y, right: x, bottom: y }, size, { width: innerWidth, height: innerHeight });
    Object.assign(menu.style, { left: `${p.left}px`, top: `${p.top}px`, maxHeight: `${p.maxHeight}px` });
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    this.#menu = menu;
    const outside = (e: Event) => {
      if (!menu.contains(e.target as Node)) this.#closeMenu();
    };
    const close = () => this.#closeMenu();
    // 等這次按鍵結束後才開始聽，免得同一次點擊就把選單關掉。
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      window.addEventListener("blur", close);
      this.#list.addEventListener("scroll", close);
    });
    this.#menuCleanup = () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", close);
      this.#list.removeEventListener("scroll", close);
    };
  }

  #contextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>(".gh-row");
    if (!row) return;
    e.preventDefault();
    const ref = target.closest<HTMLElement>(".gh-ref");
    if (ref) {
      this.#openRefMenu(ref.dataset.name!, ref.dataset.kind as GitRef["kind"], Number(row.dataset.i), e.clientX, e.clientY);
      return;
    }
    const i = Number(row.dataset.i);
    if (i !== this.#selected && i !== this.#second) {
      this.#second = null;
      this.#select(i);
    }
    this.#openRowMenu(i, e.clientX, e.clientY);
  }

  #openRowMenu(i: number, x: number, y: number): void {
    const it = this.#items[i];
    if (!it) return;
    if (it.kind === "worktree") {
      this.#showMenu(x, y, [{ label: t("到原始碼控制提交"), icon: "git-commit-horizontal", run: () => this.#h.commit() }]);
      return;
    }
    const c = it.c;
    const isHead = c.id === this.#head;
    const web = commitWebUrl(this.#h.status()?.remote, c.id);
    const second = this.#second !== null ? this.#items[this.#second] : null;
    const items: (MenuItem | "-")[] = [];
    if (this.#selected !== i && this.#items[this.#selected]?.kind === "commit") {
      items.push({ label: t("和選取的提交比較"), icon: "git-compare", run: () => this.#compareWith(i) }, "-");
    } else if (second?.kind === "commit") {
      items.push({ label: t("取消比較"), icon: "x", run: () => this.#compareWith(null) }, "-");
    }
    items.push(
      { label: t("從這裡建立分支…"), icon: "git-branch", run: () => void this.#branchFrom(c) },
      { label: t("加上標籤…"), icon: "tag", run: () => void this.#tag(c) },
      "-",
      { label: t("撤銷這個提交（建立反向的提交）"), icon: "rotate-ccw", run: () => void this.#revert(c) },
      { label: t("挑選到目前的分支（cherry-pick）"), icon: "git-pull-request", run: () => void this.#cherryPick(c), disabled: isHead },
      { label: t("退回到這個版本（保留檔案內容）…"), icon: "history", run: () => void this.#reset(c), disabled: isHead, danger: true },
    );
    if (isHead) items.push({ label: t("修改提交說明…"), icon: "pencil", run: () => void this.#amend(c), disabled: !c.unpushed });
    items.push("-", { label: t("複製提交編號"), icon: "copy", run: () => void this.#copy(c.id) });
    if (web) items.push({ label: t("在網頁上開啟"), icon: "external-link", run: () => this.#h.openUrl(web) });
    this.#showMenu(x, y, items);
  }

  #compareWith(i: number | null): void {
    this.#second = i;
    this.#paint(true);
    void this.#showDetail();
  }

  #openRefMenu(name: string, kind: GitRef["kind"], i: number, x: number, y: number): void {
    const it = this.#items[i];
    const commit = it?.kind === "commit" ? it.c : null;
    const items: (MenuItem | "-")[] = [];
    if (kind === "branch" || kind === "remote") {
      items.push(
        { label: t("切換到這個分支"), icon: "git-branch", run: () => void this.#checkout(name, kind) },
        { label: t("合併進目前的分支…"), icon: "git-merge", run: () => void this.#merge(name) },
      );
      if (kind === "branch" && commit) {
        items.push("-", { label: t("刪除分支…"), icon: "x", danger: true, run: () => void this.#deleteBranch(name, commit) });
      }
    } else if (kind === "tag" && commit) {
      items.push({ label: t("刪除標籤…"), icon: "x", danger: true, run: () => void this.#deleteTag(name, commit) });
    } else {
      items.push({ label: t("這是目前的分支"), icon: "git-branch", run: () => {}, disabled: true });
    }
    this.#showMenu(x, y, items);
  }

  // ---- 拖曳 ---------------------------------------------------------------

  #setupDrag(): void {
    this.#list.addEventListener("dragstart", (e) => {
      const target = e.target as HTMLElement;
      const ref = target.closest<HTMLElement>(".gh-ref");
      const row = target.closest<HTMLElement>(".gh-row");
      let payload: string | null = null;
      let label = "";
      if (ref && (ref.dataset.kind === "branch" || ref.dataset.kind === "remote")) {
        payload = `branch:${ref.dataset.name}`;
        label = ref.dataset.name!;
      } else if (row) {
        const it = this.#items[Number(row.dataset.i)];
        if (it?.kind === "commit") {
          payload = `commit:${it.c.id}`;
          label = it.c.summary;
        }
      }
      if (!payload || !e.dataTransfer) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData(DRAG_TYPE, payload);
      e.dataTransfer.setData("text/plain", label);
      e.dataTransfer.effectAllowed = "copy";
      this.#list.classList.add("gh-dragging");
    });
    const dropTarget = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return null;
      const target = e.target as HTMLElement;
      return target.closest<HTMLElement>(".gh-ref-head") ?? target.closest<HTMLElement>(".gh-row.gh-current");
    };
    this.#list.addEventListener("dragover", (e) => {
      const target = dropTarget(e);
      this.#list.querySelectorAll(".gh-drop").forEach((n) => n.classList.remove("gh-drop"));
      if (!target) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
      target.classList.add("gh-drop");
    });
    const end = () => {
      this.#list.classList.remove("gh-dragging");
      this.#list.querySelectorAll(".gh-drop").forEach((n) => n.classList.remove("gh-drop"));
    };
    this.#list.addEventListener("dragend", end);
    this.#list.addEventListener("drop", (e) => {
      const target = dropTarget(e);
      const data = e.dataTransfer?.getData(DRAG_TYPE) ?? "";
      end();
      if (!target || !data) return;
      e.preventDefault();
      const [kind, value] = [data.slice(0, data.indexOf(":")), data.slice(data.indexOf(":") + 1)];
      if (kind === "branch") void this.#merge(value);
      else {
        const it = this.#items.find((x) => x.kind === "commit" && x.c.id === value);
        if (it?.kind === "commit") void this.#cherryPick(it.c);
      }
    });
  }

  // ---- 操作 ---------------------------------------------------------------

  /** 會動到磁碟上檔案的操作：先確認沒有還沒存檔的分頁。 */
  #canTouchFiles(): boolean {
    if (this.#h.hasUnsaved()) {
      toast(t("有分頁還沒存檔，請先存檔。"), { tone: "error" });
      return false;
    }
    return true;
  }

  #current(): string {
    return this.#h.status()?.branch?.name ?? "HEAD";
  }

  /** 執行操作；完成後重新整理，`undo` 有值時通知上提供「復原」。 */
  async #run(task: () => Promise<{ message: string; undo?: () => Promise<string> } | null>): Promise<void> {
    let result: Awaited<ReturnType<typeof task>>;
    try {
      result = await task();
    } catch (e) {
      toast(errorText(e), { tone: "error", duration: 12000 });
      return;
    }
    if (!result) return;
    await this.#h.changed();
    await this.reload(true);
    const undo = result.undo;
    toast(result.message, {
      tone: "success",
      duration: undo ? 12000 : undefined,
      action: undo
        ? {
            label: t("復原"),
            run: () =>
              void undo()
                .then(async (m) => {
                  await this.#h.changed();
                  await this.reload(true);
                  toast(m, { tone: "success" });
                })
                .catch((e) => toast(errorText(e), { tone: "error", duration: 12000 })),
          }
        : undefined,
    });
  }

  /** 操作改變了目前的提交：復原時回到操作前，並確認之後沒有再變。 */
  #undoTo(r: GitOpResult, keepFiles = false): (() => Promise<string>) | undefined {
    const before = r.before;
    if (!before) return undefined;
    return async () => {
      const page = await this.#d.gitLog(0, 1, false, null, null);
      return this.#d.gitUndo(before, page.head ?? "", keepFiles);
    };
  }

  async #checkout(name: string, kind: string | undefined): Promise<void> {
    if (!this.#canTouchFiles()) return;
    const branch = kind === "remote" ? name.replace(/^[^/]+\//, "") : name;
    await this.#run(async () => ({ message: await this.#d.gitCheckout(branch) }));
  }

  async #branchFrom(c: LogCommit): Promise<void> {
    const name = await askText(
      t("從這裡建立分支"),
      t("從「{summary}」建立新分支並切換過去（例如 draft、fix-typo，不能有空白）：", { summary: c.summary }),
      "",
      t("建立並切換"),
    );
    if (!name) return;
    if (!this.#canTouchFiles()) return;
    await this.#run(async () => {
      const r = await this.#d.gitBranchAt(c.id, name, true);
      const prev = r.before;
      const created = r.after;
      return {
        message: r.message,
        undo:
          prev && created
            ? async () => {
                await this.#d.gitCheckout(prev);
                await this.#d.gitDeleteBranch(created);
                return t("已切回「{name}」並刪除剛才建立的分支", { name: prev });
              }
            : undefined,
      };
    });
  }

  async #tag(c: LogCommit): Promise<void> {
    const name = await askText(t("加上標籤"), t("標籤名稱（例如 v1.0、初稿）："), "", t("加上標籤"));
    if (!name) return;
    await this.#run(async () => ({
      message: await this.#d.gitTag(c.id, name, ""),
      undo: () => this.#d.gitDeleteTag(name),
    }));
  }

  async #deleteBranch(name: string, c: LogCommit): Promise<void> {
    const ok = await choose(
      t("刪除分支"),
      t("刪除分支「{name}」？只在這個分支上的提交會從清單上消失（刪除後可以馬上按「復原」）。", { name }),
      [
        { id: "cancel", label: t("取消") },
        { id: "delete", label: t("刪除"), danger: true },
      ],
      { focus: "cancel" },
    );
    if (ok !== "delete") return;
    await this.#run(async () => ({
      message: await this.#d.gitDeleteBranch(name),
      undo: async () => (await this.#d.gitBranchAt(c.id, name, false)).message,
    }));
  }

  async #deleteTag(name: string, c: LogCommit): Promise<void> {
    const ok = await choose(t("刪除標籤"), t("刪除標籤「{name}」？", { name }), [
      { id: "cancel", label: t("取消") },
      { id: "delete", label: t("刪除"), danger: true },
    ]);
    if (ok !== "delete") return;
    await this.#run(async () => ({
      message: await this.#d.gitDeleteTag(name),
      undo: () => this.#d.gitTag(c.id, name, ""),
    }));
  }

  async #merge(name: string): Promise<void> {
    const current = this.#current();
    if (name === current) return;
    const ok = await choose(
      t("合併分支"),
      t("把「{name}」的提交合併進目前的分支「{current}」？兩邊改到同一個地方時，會讓你逐段選擇。", { name, current }),
      [
        { id: "cancel", label: t("取消") },
        { id: "merge", label: t("合併"), primary: true },
      ],
    );
    if (ok !== "merge" || !this.#canTouchFiles()) return;
    await this.#run(async () => {
      const r = await this.#d.gitMergeBranch(name);
      if (r.conflicts.length) {
        this.close();
        this.#h.resolveConflicts(r.conflicts);
        return { message: r.message };
      }
      return { message: r.message, undo: this.#undoTo({ message: r.message, before: r.before, after: null }) };
    });
  }

  async #revert(c: LogCommit): Promise<void> {
    const ok = await choose(
      t("撤銷這個提交"),
      t("建立一個新的提交，把「{summary}」的修改反過來。原本的提交還留在歷史裡，已經推送的提交也可以撤銷。", { summary: c.summary }),
      [
        { id: "cancel", label: t("取消") },
        { id: "revert", label: t("撤銷"), primary: true },
      ],
    );
    if (ok !== "revert" || !this.#canTouchFiles()) return;
    await this.#run(async () => {
      const r = await this.#d.gitRevert(c.id);
      return { message: r.message, undo: this.#undoTo(r) };
    });
  }

  async #cherryPick(c: LogCommit): Promise<void> {
    const current = this.#current();
    const ok = await choose(
      t("挑選提交"),
      t("把「{summary}」的修改套用到目前的分支「{current}」（建立一個新的提交，保留原本的作者與說明）？", { summary: c.summary, current }),
      [
        { id: "cancel", label: t("取消") },
        { id: "pick", label: t("套用"), primary: true },
      ],
    );
    if (ok !== "pick" || !this.#canTouchFiles()) return;
    await this.#run(async () => {
      const r = await this.#d.gitCherryPick(c.id);
      return { message: r.message, undo: this.#undoTo(r) };
    });
  }

  async #reset(c: LogCommit): Promise<void> {
    const i = this.#items.findIndex((it) => it.kind === "commit" && it.c.id === c.id);
    const headIndex = this.#items.findIndex((it) => it.kind === "commit" && it.c.id === this.#head);
    const n = i > headIndex && headIndex >= 0 ? i - headIndex : null;
    const ok = await choose(
      t("退回到這個版本"),
      (n ? t("目前的分支會退回到「{summary}」，之後的 {n} 個提交從歷史拿掉。", { summary: c.summary, n }) : t("目前的分支會退回到「{summary}」，之後的提交從歷史拿掉。", { summary: c.summary })) +
        t("檔案內容不會變，拿掉的修改會變成「還沒提交的變更」，可以重新整理後再提交。已經推送的提交不能退回（請改用「撤銷這個提交」）。"),
      [
        { id: "cancel", label: t("取消") },
        { id: "reset", label: t("退回"), danger: true },
      ],
      { focus: "cancel" },
    );
    if (ok !== "reset") return;
    await this.#run(async () => {
      const r = await this.#d.gitReset(c.id);
      return { message: r.message, undo: this.#undoTo(r, true) };
    });
  }

  async #amend(c: LogCommit): Promise<void> {
    const detail = await this.#d.gitCommitDetail(c.id);
    const [title, ...rest] = detail.message.split("\n");
    const next = await askText(t("修改提交說明"), t("最後一次提交還沒推送，可以修改說明："), title, t("修改"));
    if (!next || next === title) return;
    const body = rest.join("\n").trim();
    await this.#run(async () => {
      const r = await this.#d.gitAmendMessage(body ? `${next}\n\n${body}` : next);
      return { message: r.message, undo: this.#undoTo(r) };
    });
  }

  // ---- 統計 ---------------------------------------------------------------

  /** 卡片放在按鈕下方，靠右對齊按鈕（按鈕在右上角），一律留在視窗內。 */
  #placeStats(button: HTMLElement): void {
    const box = this.#statsBox;
    const r = button.getBoundingClientRect();
    // 先移到左上角再量：靠近右邊時，寬度會被視窗邊緣擠窄。
    Object.assign(box.style, { left: "0px", top: "0px" });
    const width = box.offsetWidth;
    const p = placeMenu(
      { left: r.right - width, top: r.top, right: r.right, bottom: r.bottom },
      { width, height: box.offsetHeight },
      { width: innerWidth, height: innerHeight },
    );
    Object.assign(box.style, { left: `${p.left}px`, top: `${p.top}px`, maxHeight: `${p.maxHeight}px` });
  }

  async #showStats(button: HTMLElement): Promise<void> {
    const box = this.#statsBox;
    box.replaceChildren(el("p", "gh-loading", t("讀取中…")));
    this.#placeStats(button);
    try {
      const a = activity(await this.#d.gitStats(), new Date());
      const grid = el("div", "gh-heat");
      // 週數少（新的儲存庫）時格子放大一點。
      const n = a.weeks.length;
      grid.style.setProperty("--cell", n <= 16 ? "16px" : n <= 30 ? "13px" : "11px");
      grid.setAttribute("role", "img");
      grid.setAttribute("aria-label", t("最近一年有 {n} 個提交", { n: a.total }));
      for (const week of a.weeks) {
        const col = el("div", "gh-heat-week");
        for (const day of week) {
          const cell = el("span", "gh-heat-day");
          if (day) {
            cell.dataset.level = String(level(day.count, a.max));
            cell.title = t("{date}：{n} 個提交", { date: day.date, n: day.count });
          } else cell.classList.add("gh-heat-future");
          col.append(cell);
        }
        grid.append(col);
      }
      const authors = el("ol", "gh-authors");
      const top = a.authors[0]?.count ?? 1;
      for (const au of a.authors) {
        const li = el("li");
        const bar = el("span", "gh-author-bar");
        bar.style.width = `${Math.max(4, (au.count / top) * 100)}%`;
        li.append(el("span", "gh-author-name", au.name), bar, el("span", "gh-author-count", String(au.count)));
        authors.append(li);
      }
      const title = el(
        "p",
        "gh-stats-title",
        n >= 53
          ? t("最近一年有 {n} 個提交（目前的分支）", { n: a.total })
          : t("最近 {weeks} 週有 {n} 個提交（目前的分支）", { weeks: n, n: a.total }),
      );
      const row = el("div", "gh-stats-row");
      row.append(grid, authors);
      box.replaceChildren(title, row);
    } catch (e) {
      box.replaceChildren(el("p", "gh-loading gh-error", errorText(e)));
    }
    if (box.matches(":popover-open")) this.#placeStats(button);
  }
}
