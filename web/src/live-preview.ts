/**
 * 即時預覽（Obsidian 式）：在編輯區直接顯示排版效果。
 * 游標所在的行（或區塊）顯示 Markdown 原始碼，其他地方隱藏 `**`、`#`、`[]()` 等符號，
 * 圖片、表格、公式、待辦勾選框直接畫出來。文件內容永遠是原始碼，只改變顯示方式。
 */
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { TAG } from "./doc-index.ts";
import { rangeChecker } from "./ranges.ts";
import { editorFocused, focusChanged, focusTracking } from "./inline-tools.ts";
import { EditableTableWidget } from "./table-widget.ts";
import { icon } from "./ui/icons.ts";

export interface LivePreviewOptions {
  /** 圖片的網址（相對路徑換成可載入的網址）；回傳 null 表示無法顯示。 */
  imageUrl(src: string): string | null | Promise<string | null>;
  /** 表格的 Markdown 轉成 HTML（由 Rust 核心產生，已移除危險內容）。 */
  renderTable(markdown: string): string;
  /** 直接編輯表格後重新對齊（依中文字寬）；回傳 undefined 時照原樣。 */
  formatTable?(markdown: string): string | undefined;
  /** 數學公式；沒有提供或關閉公式時顯示原始碼。 */
  renderMath?(tex: string, display: boolean): Promise<string>;
  mathEnabled?(): boolean;
  /** Mermaid 流程圖畫成 SVG；沒有提供或關閉流程圖時顯示原始碼。 */
  renderMermaid?(code: string): Promise<string>;
  mermaidEnabled?(): boolean;
  /** 流程圖目前的配色；改變時（切換深淺色主題）重畫。 */
  mermaidTheme?(): string;
  /** 放大檢視流程圖；`editSource` 把游標移進原始碼。 */
  openDiagram?(svg: string, editSource: () => void): void;
  /** 流程圖複製成圖片。 */
  copyDiagram?(svg: string): void;
  /** Ctrl（⌘）＋點連結。 */
  openLink(href: string): void;
  /** 暫停顯示（例如正在逐段比較差異時，一律顯示原始碼）。 */
  enabled?(): boolean;
  /** Ctrl（⌘）＋點 `[[文件]]`（`target` 可能帶 `#標題`）。 */
  openWiki?(target: string): void;
  /** `[[文件]]` 找不找得到對應的檔案；不知道時回傳 null（不標示）。 */
  wikiExists?(target: string): boolean | null;
  /** Ctrl（⌘）＋點 `#標籤`。 */
  openTag?(tag: string): void;
  /** 點圖片放大檢視；`editSource` 把游標移進圖片的原始碼。 */
  openImage?(url: string, alt: string, editSource: () => void): void;
}

/** 圖片說明文字結尾的 `|400`（或 `|400x300`）是顯示寬度（Obsidian 的寫法）。 */
export function imageSize(alt: string): { alt: string; width: number | null; height: number | null } {
  const m = /^(.*?)\s*\|\s*(\d{1,4})(?:\s*x\s*(\d{1,4}))?$/.exec(alt);
  return m ? { alt: m[1], width: Number(m[2]), height: m[3] ? Number(m[3]) : null } : { alt, width: null, height: null };
}

/** `[[目標#標題|顯示文字]]`：目標、`#標題`、`|顯示文字` 分開。 */
const WIKI_LINK = /\[\[([^[\]|#\n]+)(#[^[\]|\n]*)?(\|[^[\]\n]*)?\]\]/g;
/** 這些語法節點裡不找 `[[ ]]` 與標籤。 */
const NO_INLINE = /^(InlineCode|FencedCode|CodeBlock|CommentBlock|HTMLBlock|HTMLTag|URL|Link|Image|Autolink|Comment)$/;

// ---- 小工具：找出行內數學公式 ------------------------------------------------

/**
 * 段落中的行內公式 `$…$`（和 md-core 的規則一致：開頭的 $ 後面、結尾的 $ 前面不能是空白，
 * 結尾的 $ 後面不能接數字，`\$` 不算），回傳相對於文字開頭的位置。
 */
export function inlineMath(text: string): { from: number; to: number; tex: string }[] {
  const out: { from: number; to: number; tex: string }[] = [];
  const re = /(?<![\\$])\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?![\d$])/g;
  for (const m of text.matchAll(re)) out.push({ from: m.index, to: m.index + m[0].length, tex: m[1] });
  return out;
}

/** ```mermaid 區塊裡的流程圖原始碼（不含前後的圍欄）；不是流程圖時回傳 null。 */
export function mermaidSource(block: string): string | null {
  const open = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid(?:[ \t][^\n]*)?\n/.exec(block);
  if (!open) return null;
  const lines = block.slice(open[0].length).split("\n");
  const fence = open[1];
  const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines.at(-1) ?? "");
  if (close && close[1][0] === fence[0] && close[1].length >= fence.length) lines.pop();
  return lines.join("\n");
}

/** 整段都是 `$$…$$` 的區塊公式時回傳 TeX。 */
export function blockMath(text: string): string | null {
  const m = /^\$\$([\s\S]+?)\$\$$/.exec(text.trim());
  return m ? m[1] : null;
}

// ---- 小元件 ------------------------------------------------------------------

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "•";
    return span;
  }
}

class CheckboxWidget extends WidgetType {
  readonly checked: boolean;
  constructor(checked: boolean) {
    super();
    this.checked = checked;
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-checkbox";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "已完成，按一下取消" : "按一下標示完成");
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      const at = view.posAtDOM(box);
      const line = view.state.doc.lineAt(at);
      const m = /\[( |x|X)\]/.exec(line.text.slice(at - line.from));
      if (!m) return;
      const pos = at + m.index + 1;
      view.dispatch({ changes: { from: pos, to: pos + 1, insert: this.checked ? " " : "x" }, userEvent: "input.toggle" });
    });
    return box;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const hr = document.createElement("span");
    hr.className = "cm-lp-hr";
    return hr;
  }
}

/** 點區塊元件時把游標移進去，顯示原始碼。 */
function revealOnClick(view: EditorView, dom: HTMLElement): void {
  dom.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("a, input")) return;
    e.preventDefault();
    const pos = view.posAtDOM(dom);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: false, userEvent: "select.pointer" });
    view.focus();
  });
}

class ImageWidget extends WidgetType {
  readonly src: string;
  readonly alt: string;
  readonly opts: LivePreviewOptions;
  constructor(src: string, alt: string, opts: LivePreviewOptions) {
    super();
    this.src = src;
    this.alt = alt;
    this.opts = opts;
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-image";
    const size = imageSize(this.alt);
    /** 把游標移進圖片的原始碼。 */
    const editSource = () => {
      const pos = view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: false, userEvent: "select.pointer" });
      view.focus();
    };
    const show = (url: string | null) => {
      if (!url) {
        wrap.textContent = `🖼 ${size.alt || this.src}`;
        wrap.classList.add("cm-lp-image-missing");
        revealOnClick(view, wrap);
        return;
      }
      const img = document.createElement("img");
      img.alt = size.alt;
      img.src = url;
      if (size.width) img.style.width = `${size.width}px`;
      img.addEventListener("error", () => show(null), { once: true });
      img.addEventListener("load", () => view.requestMeasure(), { once: true });
      img.title = "按一下放大；拖曳右下角調整大小";
      img.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (this.opts.openImage) this.opts.openImage(url, size.alt, editSource);
        else editSource();
      });
      const handle = document.createElement("span");
      handle.className = "cm-lp-image-handle";
      handle.title = "拖曳調整大小";
      handle.addEventListener("pointerdown", (e) => this.#resize(e, view, wrap, img));
      wrap.replaceChildren(img, handle);
    };
    try {
      const url = this.opts.imageUrl(this.src);
      if (url instanceof Promise) url.then(show, () => show(null));
      else show(url);
    } catch {
      show(null);
    }
    return wrap;
  }

  /** 拖曳右下角調整寬度，放開後把寬度寫進說明文字（`![說明|400](…)`）。 */
  #resize(e: PointerEvent, view: EditorView, wrap: HTMLElement, img: HTMLImageElement): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = img.getBoundingClientRect().width;
    const max = view.contentDOM.clientWidth;
    let width = startWidth;
    wrap.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      width = Math.max(40, Math.min(max, startWidth + ev.clientX - startX));
      img.style.width = `${Math.round(width)}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      wrap.classList.remove("resizing");
      if (Math.abs(width - startWidth) < 3) return;
      const pos = view.posAtDOM(wrap);
      const m = /^!\[([^\]\n]*)\]/.exec(view.state.doc.sliceString(pos, pos + 1000));
      if (!m) return;
      const alt = `${imageSize(m[1]).alt}|${Math.round(width / 10) * 10}`;
      view.dispatch({ changes: { from: pos + 2, to: pos + 2 + m[1].length, insert: alt }, userEvent: "input.image" });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class MathWidget extends WidgetType {
  readonly tex: string;
  readonly display: boolean;
  readonly render: NonNullable<LivePreviewOptions["renderMath"]>;
  constructor(tex: string, display: boolean, render: NonNullable<LivePreviewOptions["renderMath"]>) {
    super();
    this.tex = tex;
    this.display = display;
    this.render = render;
  }
  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-lp-block cm-lp-math-block" : "cm-lp-math";
    el.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`;
    this.render(this.tex, this.display).then(
      (html) => {
        el.innerHTML = html;
        view.requestMeasure();
      },
      () => {},
    );
    revealOnClick(view, el);
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** 流程圖畫面上最多多高，超過的等比例縮小（點「放大」看原始大小）。 */
const DIAGRAM_MAX_HEIGHT = 560;
/** 編輯原始碼時，停止打字多久後重畫。 */
const DIAGRAM_DEBOUNCE = 300;
/** 畫好的流程圖高度：重新建立元件時先用這個高度估算，捲動才不會跳。 */
const diagramHeights = new Map<string, number>();

interface DiagramState {
  widget: MermaidWidget;
  /** 上一次畫成功的圖；語法錯誤時繼續顯示。 */
  svg: string | null;
  timer: number;
  seq: number;
}
const diagramStates = new WeakMap<HTMLElement, DiagramState>();

/**
 * Mermaid 流程圖。游標不在區塊裡時取代整個區塊，只顯示圖；
 * 游標在區塊裡時接在原始碼下面，邊打字邊更新（語法錯誤時保留上一次畫好的圖）。
 */
class MermaidWidget extends WidgetType {
  readonly code: string;
  readonly theme: string;
  readonly editing: boolean;
  readonly opts: LivePreviewOptions;
  constructor(code: string, theme: string, editing: boolean, opts: LivePreviewOptions) {
    super();
    this.code = code;
    this.theme = theme;
    this.editing = editing;
    this.opts = opts;
  }
  eq(other: MermaidWidget): boolean {
    return other.code === this.code && other.theme === this.theme && other.editing === this.editing;
  }
  get estimatedHeight(): number {
    return diagramHeights.get(this.code) ?? -1;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-lp-block cm-lp-mermaid";
    const tools = document.createElement("div");
    tools.className = "cm-lp-diagram-tools";
    const button = (name: string, label: string, run: (st: DiagramState) => void, cls = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.title = label;
      b.setAttribute("aria-label", label);
      b.append(icon(name));
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.button === 0) run(diagramStates.get(el)!);
      });
      return b;
    };
    tools.append(
      button("pen-line", "編輯原始碼", () => editDiagram(view, el), "cm-lp-diagram-edit"),
      button("maximize-2", "放大", (st) => {
        if (st.svg && st.widget.opts.openDiagram) st.widget.opts.openDiagram(st.svg, () => editDiagram(view, el));
      }),
      button("copy", "複製成圖片", (st) => {
        if (st.svg) st.widget.opts.copyDiagram?.(st.svg);
      }),
    );
    const diagram = document.createElement("div");
    diagram.className = "cm-lp-diagram";
    diagram.textContent = "流程圖繪製中…";
    const error = document.createElement("div");
    error.className = "cm-lp-diagram-error";
    error.hidden = true;
    el.append(tools, diagram, error);
    el.addEventListener("mousedown", (e) => {
      // 點圖開始編輯原始碼（已經在編輯時不動，免得游標跳走）。
      if (e.button !== 0 || diagramStates.get(el)?.widget.editing) return;
      e.preventDefault();
      editDiagram(view, el);
    });
    diagramStates.set(el, { widget: this, svg: null, timer: 0, seq: 0 });
    this.#apply(el, view, 0);
    return el;
  }
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const st = diagramStates.get(dom);
    if (!st) return false;
    const redraw = st.widget.code !== this.code || st.widget.theme !== this.theme;
    st.widget = this;
    this.#apply(dom, view, redraw && this.editing ? DIAGRAM_DEBOUNCE : redraw ? 0 : -1);
    return true;
  }
  /** `delay` 是 -1 時只更新外觀，不重畫。 */
  #apply(el: HTMLElement, view: EditorView, delay: number): void {
    el.classList.toggle("cm-lp-mermaid-editing", this.editing);
    el.title = this.editing ? "" : "按一下編輯流程圖";
    if (delay < 0) return;
    const st = diagramStates.get(el)!;
    clearTimeout(st.timer);
    const draw = () => {
      const seq = ++st.seq;
      const done = (svg: string | null, err?: unknown) => {
        // 等待期間又改了原始碼，以最新的為準。
        if (seq !== st.seq) return;
        const diagram = el.querySelector<HTMLElement>(".cm-lp-diagram")!;
        const error = el.querySelector<HTMLElement>(".cm-lp-diagram-error")!;
        if (svg !== null) {
          st.svg = svg;
          diagram.innerHTML = svg;
          fitDiagram(diagram.querySelector("svg"));
        } else if (st.svg === null) {
          diagram.textContent = "";
        }
        error.hidden = err === undefined;
        if (err !== undefined) {
          const message = err instanceof Error ? err.message : String(err);
          error.textContent = `流程圖語法錯誤：${message.split("\n").find((l) => l.trim()) ?? ""}`;
          error.title = message;
        }
        el.classList.toggle("cm-lp-mermaid-stale", err !== undefined && st.svg !== null);
        view.requestMeasure({
          read: () => el.getBoundingClientRect().height,
          write: (h) => {
            if (svg === null) return;
            if (diagramHeights.size >= 200) diagramHeights.clear();
            diagramHeights.set(this.code, h);
          },
        });
      };
      this.opts.renderMermaid!(this.code).then(
        (svg) => done(svg),
        (e) => done(null, e),
      );
    };
    if (delay > 0) st.timer = window.setTimeout(draw, delay);
    else draw();
  }
  destroy(dom: HTMLElement): void {
    const st = diagramStates.get(dom);
    if (st) clearTimeout(st.timer);
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** 流程圖照原始大小顯示：太高的等比例縮小，太寬的先縮到六成，再寬就左右捲動。 */
function fitDiagram(svg: SVGSVGElement | null): void {
  const box = svg?.viewBox.baseVal;
  if (!svg || !box?.width || !box.height) return;
  const scale = Math.min(1, DIAGRAM_MAX_HEIGHT / box.height);
  const width = box.width * scale;
  svg.removeAttribute("height");
  svg.style.width = `${width}px`;
  svg.style.maxWidth = "100%";
  svg.style.minWidth = `${Math.round(width * 0.6)}px`;
  svg.style.height = "auto";
}

/** 把游標移到流程圖原始碼的第一行（圍欄的下一行）。 */
function editDiagram(view: EditorView, el: HTMLElement): void {
  const pos = view.posAtDOM(el);
  const doc = view.state.doc;
  let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1);
  while (node && node.name !== "FencedCode") node = node.parent;
  // 編輯中的圖接在區塊後面，往前找區塊。
  if (!node) {
    node = syntaxTree(view.state).resolveInner(pos, -1);
    while (node && node.name !== "FencedCode") node = node.parent;
  }
  const start = node ? node.from : pos;
  const line = doc.lineAt(start);
  const anchor = line.number < doc.lines && (!node || doc.line(line.number + 1).from < node.to) ? doc.line(line.number + 1).from : start;
  view.dispatch({ selection: { anchor }, scrollIntoView: false, userEvent: "select.pointer" });
  view.focus();
}

// ---- 計算要隱藏或替換的範圍 ----------------------------------------------------

const hidden = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const marks = {
  strong: Decoration.mark({ class: "cm-lp-strong" }),
  em: Decoration.mark({ class: "cm-lp-em" }),
  strike: Decoration.mark({ class: "cm-lp-strike" }),
  code: Decoration.mark({ class: "cm-lp-code" }),
};
const lineClass = (cls: string) => Decoration.line({ class: cls });

/** 游標或選取範圍所在的行（顯示原始碼）；編輯器沒有焦點時（例如在側邊欄操作）整份都顯示排版。 */
function activeLines(state: EditorState) {
  const doc = state.doc;
  const active = new Set<number>();
  for (const r of editorFocused(state) ? state.selection.ranges : []) {
    for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l);
  }
  const lineActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const rangeActive = (from: number, to: number) => {
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) if (active.has(l)) return true;
    return false;
  };
  return { active, lineActive, rangeActive };
}

/**
 * 區塊元件（表格、`$$` 公式、流程圖）：會改變版面高度，CodeMirror 規定要由 StateField 提供，所以看整份文件；
 * 只走區塊層級的節點（不進入段落內容），大文件也很快。
 */
function buildBlocks(state: EditorState, opts: LivePreviewOptions): DecorationSet {
  if (opts.enabled && !opts.enabled()) return Decoration.none;
  const doc = state.doc;
  const { rangeActive } = activeLines(state);
  const wholeLines = (from: number, to: number) => doc.lineAt(from).from === from && doc.lineAt(to).to === to;
  const mathOn = !!opts.renderMath && (opts.mathEnabled?.() ?? true);
  const mermaidOn = !!opts.renderMermaid && (opts.mermaidEnabled?.() ?? true);
  const theme = opts.mermaidTheme?.() ?? "";
  const decos: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: ({ name, from, to }) => {
      switch (name) {
        case "Document":
        case "Blockquote":
        case "BulletList":
        case "OrderedList":
        case "ListItem":
          return;
        case "Table":
          if (!rangeActive(from, to) && wholeLines(from, to)) {
            decos.push(
              Decoration.replace({
                widget: new EditableTableWidget(doc.sliceString(from, to), opts.renderTable, opts.formatTable ?? (() => undefined)),
                block: true,
              }).range(from, to),
            );
          }
          return false;
        case "FencedCode": {
          const code = mermaidOn && wholeLines(from, to) ? mermaidSource(doc.sliceString(from, to)) : null;
          if (code === null) return false;
          if (!rangeActive(from, to)) {
            decos.push(Decoration.replace({ widget: new MermaidWidget(code, theme, false, opts), block: true }).range(from, to));
          } else if (code.trim()) {
            // 編輯中：上面是原始碼，下面是即時更新的圖。
            decos.push(Decoration.widget({ widget: new MermaidWidget(code, theme, true, opts), block: true, side: 1 }).range(to));
          }
          return false;
        }
        case "Paragraph": {
          if (!mathOn || doc.sliceString(from, from + 2) !== "$$") return false;
          const display = blockMath(doc.sliceString(from, to));
          if (display !== null && !rangeActive(from, to) && wholeLines(from, to)) {
            decos.push(Decoration.replace({ widget: new MathWidget(display, true, opts.renderMath!), block: true }).range(from, to));
          }
          return false;
        }
        default:
          return false;
      }
    },
  });
  return Decoration.set(decos, true);
}

/**
 * 行內的排版（隱藏符號、連結、圖片、勾選框、標題樣式……）：只處理畫面上看得到的範圍，
 * 文件再長，每次按鍵或移動游標的工作量都差不多。
 */
function build(state: EditorState, opts: LivePreviewOptions, ranges: readonly { from: number; to: number }[]): DecorationSet {
  if (opts.enabled && !opts.enabled()) return Decoration.none;
  const doc = state.doc;
  const { active, lineActive, rangeActive } = activeLines(state);
  /** 同一行內（由 ViewPlugin 提供的替換不能跨行）。 */
  const oneLine = (from: number, to: number) => doc.lineAt(from).to >= to;
  const decos: Range<Decoration>[] = [];
  const hide = (from: number, to: number) => {
    if (to > from && oneLine(from, to)) decos.push(hidden.range(from, to));
  };
  /** 標記後面如果緊接一個空白，一起隱藏。 */
  const withSpace = (to: number) => (doc.sliceString(to, to + 1) === " " ? to + 1 : to);
  const mathOn = !!opts.renderMath && (opts.mathEnabled?.() ?? true);
  const htmlTags: InlineTag[] = [];
  const noInline: [number, number][] = [];
  // 畫面上可能有好幾段可見範圍（中間有摺疊）：同一個節點只處理一次。
  const seen = new Set<string>();

  for (const range of ranges) syntaxTree(state).iterate({
    from: range.from,
    to: range.to,
    enter: (ref) => {
      const { name, from, to } = ref;
      const key = `${name}:${from}:${to}`;
      if (seen.has(key)) return;
      seen.add(key);
      const node = ref.node;
      // `[[週報]]` 裡的 `[週報]` 會被當成沒有網址的連結，那種不算。
      if (NO_INLINE.test(name) && (name !== "Link" || node.getChild("URL"))) noInline.push([from, to]);
      const heading = /^ATXHeading(\d)$/.exec(name) ?? /^SetextHeading(\d)$/.exec(name);
      if (heading) {
        decos.push(lineClass(`cm-lp-h cm-lp-h${heading[1]}`).range(doc.lineAt(from).from));
        if (!rangeActive(from, to)) {
          for (const mark of node.getChildren("HeaderMark")) {
            if (name.startsWith("Setext")) hide(mark.from, mark.to);
            else if (mark.from === from) hide(mark.from, withSpace(mark.to));
            else hide(doc.sliceString(mark.from - 1, mark.from) === " " ? mark.from - 1 : mark.from, mark.to);
          }
        }
        return;
      }
      switch (name) {
        case "StrongEmphasis":
          decos.push(marks.strong.range(from, to));
          return;
        case "Emphasis":
          decos.push(marks.em.range(from, to));
          return;
        case "Strikethrough":
          decos.push(marks.strike.range(from, to));
          return;
        case "InlineCode":
          decos.push(marks.code.range(from, to));
          return;
        case "EmphasisMark":
        case "StrikethroughMark":
          if (!lineActive(from)) hide(from, to);
          return;
        case "CodeMark":
          if (node.parent?.name === "InlineCode" && !lineActive(from)) hide(from, to);
          return;
        case "Escape":
          if (!lineActive(from)) hide(from, from + 1);
          return;
        case "Link":
        case "Autolink": {
          const url = node.getChild("URL");
          const href = url ? doc.sliceString(url.from, url.to) : "";
          const linkMarks = node.getChildren("LinkMark");
          if (lineActive(from) || !href || !linkMarks.length) return;
          if (name === "Autolink") {
            hide(from, from + 1);
            hide(to - 1, to);
            decos.push(linkMark(href).range(from + 1, to - 1));
            return false;
          }
          // [文字](網址 "標題")：只留「文字」。參考式連結 [文字][代號] 沒有 URL，不處理。
          const close = linkMarks.find((m) => doc.sliceString(m.from, m.to) === "]");
          if (!close || close.from <= from + 1) return;
          hide(from, from + 1);
          hide(close.from, to);
          decos.push(linkMark(href).range(from + 1, close.from));
          return;
        }
        case "Image": {
          if (lineActive(from) || !oneLine(from, to)) return false;
          const url = node.getChild("URL");
          if (!url) return false;
          const alt = doc.sliceString(from + 2, Math.max(from + 2, (node.getChildren("LinkMark")[1]?.from ?? from + 2)));
          decos.push(
            Decoration.replace({ widget: new ImageWidget(doc.sliceString(url.from, url.to), alt, opts) }).range(
              from,
              to,
            ),
          );
          return false;
        }
        case "Blockquote":
          for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) {
            decos.push(lineClass("cm-lp-quote").range(doc.line(l).from));
          }
          return;
        case "QuoteMark":
          if (!lineActive(from)) hide(from, withSpace(to));
          return;
        case "ListMark": {
          if (lineActive(from)) return;
          const item = node.parent;
          if (taskMarker(item)) return; // 待辦項目由勾選框處理
          if (item?.parent?.name === "BulletList") decos.push(bullet.range(from, to));
          return;
        }
        case "TaskMarker": {
          if (lineActive(from)) return;
          const listMark = node.parent?.parent?.getChild("ListMark");
          const start = listMark?.from ?? from;
          const checked = doc.sliceString(from, to).toLowerCase() === "[x]";
          decos.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(start, withSpace(to)));
          if (checked) {
            const lineEnd = doc.lineAt(to).to;
            if (lineEnd > withSpace(to)) decos.push(Decoration.mark({ class: "cm-lp-done" }).range(withSpace(to), lineEnd));
          }
          return;
        }
        case "HorizontalRule":
          if (!lineActive(from)) decos.push(rule.range(from, to));
          return false;
        case "FencedCode": {
          const first = doc.lineAt(from).number;
          const last = doc.lineAt(to).number;
          const inside = rangeActive(from, to);
          for (let l = first; l <= last; l++) {
            const fence = (l === first || l === last) && last > first;
            const cls = `cm-lp-codeblock${l === first ? " cm-lp-codeblock-first" : ""}${l === last ? " cm-lp-codeblock-last" : ""}${fence && !inside ? " cm-lp-fence" : ""}`;
            decos.push(lineClass(cls).range(doc.line(l).from));
          }
          return false;
        }
        case "Table":
          // 由 buildBlocks 畫成表格元件。
          return false;
        case "CommentBlock":
          // HTML 註解（例如目錄的 <!-- toc --> 標記）在預覽中看不到，這裡淡化顯示。
          for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) {
            decos.push(lineClass("cm-lp-comment").range(doc.line(l).from));
          }
          return false;
        case "HTMLBlock":
          return false;
        case "HTMLTag": {
          const tag = parseTag(doc.sliceString(from, to));
          if (tag) htmlTags.push({ ...tag, from, to, parent: node.parent?.from ?? -1 });
          return;
        }
        case "Paragraph": {
          if (!mathOn) return;
          const text = doc.sliceString(from, to);
          // 整段 `$$…$$` 由 buildBlocks 畫成區塊公式。
          if (blockMath(text) !== null) return false;
          // 行內公式：避開行內程式碼裡的 $。
          const skip = node.getChildren("InlineCode").map((c) => [c.from - from, c.to - from]);
          for (const m of inlineMath(text)) {
            if (skip.some(([a, b]) => m.from < b && m.to > a)) continue;
            if (lineActive(from + m.from) || lineActive(from + m.to) || !oneLine(from + m.from, from + m.to)) continue;
            decos.push(
              Decoration.replace({ widget: new MathWidget(m.tex, false, opts.renderMath!) }).range(from + m.from, from + m.to),
            );
          }
          return;
        }
      }
    },
  });
  // [[文件]] 與 #標籤（只看可見範圍內的行）
  const blocked = rangeChecker(noInline);
  let lastLine = 0;
  for (const range of ranges) for (let l = Math.max(doc.lineAt(range.from).number, lastLine + 1); l <= doc.lineAt(range.to).number; l++) {
    lastLine = l;
    const line = doc.line(l);
    if (!line.text.includes("[[") && !line.text.includes("#")) continue;
    for (const m of line.text.matchAll(WIKI_LINK)) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (blocked(from, to)) continue;
      const target = m[1].trim();
      const exists = opts.wikiExists?.(target) ?? null;
      const mark = Decoration.mark({
        class: `cm-lp-link cm-lp-wiki${exists === false ? " cm-lp-wiki-missing" : ""}`,
        attributes: {
          "data-wiki": target + (m[2] ?? ""),
          title: `${target}${exists === false ? "（還沒有這份文件，Ctrl＋點一下建立）" : "\n（Ctrl＋點一下開啟）"}`,
        },
      });
      if (active.has(l)) {
        decos.push(mark.range(from, to));
        continue;
      }
      // 有顯示文字時只留顯示文字，否則留「目標#標題」。
      const textFrom = m[3] ? to - 2 - (m[3].length - 1) : from + 2;
      hide(from, textFrom);
      hide(to - 2, to);
      if (to - 2 > textFrom) decos.push(mark.range(textFrom, to - 2));
    }
    for (const m of line.text.matchAll(TAG)) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (blocked(from, to) || /^\d+$/.test(m[1])) continue;
      const tag = m[1].replace(/[/-]+$/, "");
      decos.push(
        Decoration.mark({
          class: "cm-lp-tag",
          attributes: { "data-tag": tag, title: `標籤「${tag}」（Ctrl＋點一下列出同標籤的文件）` },
        }).range(from, from + 1 + tag.length),
      );
    }
  }
  // 成對的 <u>、<mark>、<sup>、<sub>：隱藏標籤，中間套上格式（和預覽一樣，只認同一層裡成對的標籤）。
  // 只有游標在這一組標籤裡（或碰到它）時才顯示 <mark> 等原始碼，同一行其他地方編輯時照樣顯示排版。
  const cursors = editorFocused(state) ? state.selection.ranges : [];
  const touches = (a: number, b: number) => cursors.some((r) => r.from <= b && r.to >= a);
  for (const [open, close] of pairTags(htmlTags)) {
    if (touches(open.from, close.to)) continue;
    hide(open.from, open.to);
    hide(close.from, close.to);
    if (close.from > open.to) decos.push(tagMarks[open.name].range(open.to, close.from));
  }
  return Decoration.set(decos, true);
}

const FORMAT_TAGS = ["u", "mark", "sup", "sub", "ins"] as const;
type FormatTag = (typeof FORMAT_TAGS)[number];
const tagMarks = Object.fromEntries(FORMAT_TAGS.map((t) => [t, Decoration.mark({ class: `cm-lp-${t}` })])) as Record<
  FormatTag,
  Decoration
>;

export interface InlineTag {
  name: FormatTag;
  closing: boolean;
  from: number;
  to: number;
  /** 所在的上層節點（只配對同一層的標籤）。 */
  parent: number;
}

/** `<u>`、`</mark>` 這種不帶屬性的格式標籤。 */
export function parseTag(text: string): Pick<InlineTag, "name" | "closing"> | null {
  const m = /^<(\/?)([a-z]+)\s*>$/i.exec(text);
  const name = m?.[2].toLowerCase() as FormatTag | undefined;
  return name && FORMAT_TAGS.includes(name) ? { name, closing: m![1] === "/" } : null;
}

/** 依文件順序配對：同一層、同名、正確巢狀的開頭與結尾標籤。 */
export function pairTags(tags: InlineTag[]): [InlineTag, InlineTag][] {
  const pairs: [InlineTag, InlineTag][] = [];
  const stacks = new Map<number, InlineTag[]>();
  for (const tag of tags) {
    const stack = stacks.get(tag.parent) ?? [];
    stacks.set(tag.parent, stack);
    if (!tag.closing) stack.push(tag);
    else if (stack.at(-1)?.name === tag.name) pairs.push([stack.pop()!, tag]);
  }
  return pairs;
}

function taskMarker(item: SyntaxNode | null): SyntaxNode | null {
  return item?.getChild("Task")?.getChild("TaskMarker") ?? null;
}

function linkMark(href: string): Decoration {
  return Decoration.mark({
    class: "cm-lp-link",
    attributes: { "data-href": href, title: `${href}\n（Ctrl＋點一下開啟）` },
  });
}

const rebuild = StateEffect.define<null>();

/** 外部資料變了（例如資料夾的檔案清單）：重新計算即時預覽（`[[文件]]` 找不找得到檔案）。 */
export function refreshLivePreview(view: EditorView): void {
  view.dispatch({ effects: rebuild.of(null) });
}

export function livePreview(opts: LivePreviewOptions): Extension {
  const blocks = StateField.define<DecorationSet>({
    create: (state) => buildBlocks(state, opts),
    update(value, tr) {
      const treeChanged = syntaxTree(tr.state) !== syntaxTree(tr.startState);
      const forced = tr.effects.some((e) => e.is(rebuild));
      if (!tr.docChanged && !tr.selection && !treeChanged && !tr.reconfigured && !focusChanged(tr) && !forced) return value.map(tr.changes);
      return buildBlocks(tr.state, opts);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  const inline = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view.state, opts, view.visibleRanges);
      }
      update(u: ViewUpdate) {
        const changed =
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          syntaxTree(u.state) !== syntaxTree(u.startState) ||
          u.transactions.some((tr) => tr.reconfigured || focusChanged(tr) || tr.effects.some((e) => e.is(rebuild)));
        if (changed) this.decorations = build(u.state, opts, u.view.visibleRanges);
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [
    focusTracking,
    blocks,
    inline,
    EditorView.editorAttributes.of({ class: "cm-lp" }),
    EditorView.domEventHandlers({
      mousedown(e) {
        if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
        const target = e.target as HTMLElement;
        const wiki = target.closest<HTMLElement>(".cm-lp-wiki");
        const tag = target.closest<HTMLElement>(".cm-lp-tag");
        const link = target.closest<HTMLElement>(".cm-lp-link");
        if (wiki && opts.openWiki) opts.openWiki(wiki.dataset.wiki ?? "");
        else if (tag && opts.openTag) opts.openTag(tag.dataset.tag ?? "");
        else if (link) opts.openLink(link.dataset.href ?? "");
        else return false;
        e.preventDefault();
        return true;
      },
    }),
  ];
}
