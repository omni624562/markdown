/**
 * 即時預覽（Obsidian 式）：在編輯區直接顯示排版效果。
 * 游標所在的行（或區塊）顯示 Markdown 原始碼，其他地方隱藏 `**`、`#`、`[]()` 等符號，
 * 圖片、表格、公式、待辦勾選框直接畫出來。文件內容永遠是原始碼，只改變顯示方式。
 */
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { editorFocused, focusChanged, focusTracking } from "./inline-tools.ts";

export interface LivePreviewOptions {
  /** 圖片的網址（相對路徑換成可載入的網址）；回傳 null 表示無法顯示。 */
  imageUrl(src: string): string | null | Promise<string | null>;
  /** 表格的 Markdown 轉成 HTML（由 Rust 核心產生，已移除危險內容）。 */
  renderTable(markdown: string): string;
  /** 數學公式；沒有提供或關閉公式時顯示原始碼。 */
  renderMath?(tex: string, display: boolean): Promise<string>;
  mathEnabled?(): boolean;
  /** Ctrl（⌘）＋點連結。 */
  openLink(href: string): void;
  /** 暫停顯示（例如正在逐段比較差異時，一律顯示原始碼）。 */
  enabled?(): boolean;
}

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
  readonly resolve: LivePreviewOptions["imageUrl"];
  constructor(src: string, alt: string, resolve: LivePreviewOptions["imageUrl"]) {
    super();
    this.src = src;
    this.alt = alt;
    this.resolve = resolve;
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-image";
    const show = (url: string | null) => {
      if (!url) {
        wrap.textContent = `🖼 ${this.alt || this.src}`;
        wrap.classList.add("cm-lp-image-missing");
        return;
      }
      const img = document.createElement("img");
      img.alt = this.alt;
      img.src = url;
      img.addEventListener("error", () => show(null), { once: true });
      img.addEventListener("load", () => view.requestMeasure(), { once: true });
      wrap.replaceChildren(img);
    };
    try {
      const url = this.resolve(this.src);
      if (url instanceof Promise) url.then(show, () => show(null));
      else show(url);
    } catch {
      show(null);
    }
    revealOnClick(view, wrap);
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class TableWidget extends WidgetType {
  readonly markdown: string;
  readonly render: LivePreviewOptions["renderTable"];
  constructor(markdown: string, render: LivePreviewOptions["renderTable"]) {
    super();
    this.markdown = markdown;
    this.render = render;
  }
  eq(other: TableWidget): boolean {
    return other.markdown === this.markdown;
  }
  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-lp-block cm-lp-table markdown-body";
    div.innerHTML = this.render(this.markdown);
    div.title = "按一下編輯表格";
    revealOnClick(view, div);
    return div;
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

function build(state: EditorState, opts: LivePreviewOptions): DecorationSet {
  if (opts.enabled && !opts.enabled()) return Decoration.none;
  const doc = state.doc;
  // 游標或選取範圍所在的行顯示原始碼；編輯器沒有焦點時（例如在側邊欄操作）整份都顯示排版。
  const active = new Set<number>();
  for (const r of editorFocused(state) ? state.selection.ranges : []) {
    for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l);
  }
  const lineActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const rangeActive = (from: number, to: number) => {
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) if (active.has(l)) return true;
    return false;
  };
  /** 整行都在範圍內（區塊替換只能用在完整的行上）。 */
  const wholeLines = (from: number, to: number) => doc.lineAt(from).from === from && doc.lineAt(to).to === to;
  const decos: Range<Decoration>[] = [];
  const hide = (from: number, to: number) => {
    if (to > from) decos.push(hidden.range(from, to));
  };
  /** 標記後面如果緊接一個空白，一起隱藏。 */
  const withSpace = (to: number) => (doc.sliceString(to, to + 1) === " " ? to + 1 : to);
  const mathOn = !!opts.renderMath && (opts.mathEnabled?.() ?? true);

  syntaxTree(state).iterate({
    enter: (ref) => {
      const { name, from, to } = ref;
      const node = ref.node;
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
          if (lineActive(from)) return false;
          const url = node.getChild("URL");
          if (!url) return false;
          const alt = doc.sliceString(from + 2, Math.max(from + 2, (node.getChildren("LinkMark")[1]?.from ?? from + 2)));
          decos.push(
            Decoration.replace({ widget: new ImageWidget(doc.sliceString(url.from, url.to), alt, opts.imageUrl) }).range(
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
          if (!rangeActive(from, to) && wholeLines(from, to)) {
            decos.push(
              Decoration.replace({ widget: new TableWidget(doc.sliceString(from, to), opts.renderTable), block: true }).range(
                from,
                to,
              ),
            );
          }
          return false;
        case "HTMLBlock":
        case "CommentBlock":
          return false;
        case "Paragraph": {
          if (!mathOn) return;
          const text = doc.sliceString(from, to);
          const display = blockMath(text);
          if (display !== null) {
            if (!rangeActive(from, to) && wholeLines(from, to)) {
              decos.push(
                Decoration.replace({ widget: new MathWidget(display, true, opts.renderMath!), block: true }).range(from, to),
              );
            }
            return false;
          }
          // 行內公式：避開行內程式碼裡的 $。
          const skip = node.getChildren("InlineCode").map((c) => [c.from - from, c.to - from]);
          for (const m of inlineMath(text)) {
            if (skip.some(([a, b]) => m.from < b && m.to > a)) continue;
            if (lineActive(from + m.from) || lineActive(from + m.to)) continue;
            decos.push(
              Decoration.replace({ widget: new MathWidget(m.tex, false, opts.renderMath!) }).range(from + m.from, from + m.to),
            );
          }
          return;
        }
      }
    },
  });
  return Decoration.set(decos, true);
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

export function livePreview(opts: LivePreviewOptions): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, opts),
    update(value, tr) {
      const treeChanged = syntaxTree(tr.state) !== syntaxTree(tr.startState);
      if (!tr.docChanged && !tr.selection && !treeChanged && !tr.reconfigured && !focusChanged(tr)) return value;
      return build(tr.state, opts);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return [
    focusTracking,
    field,
    EditorView.editorAttributes.of({ class: "cm-lp" }),
    EditorView.domEventHandlers({
      mousedown(e) {
        const link = (e.target as HTMLElement).closest<HTMLElement>(".cm-lp-link");
        if (!link || !(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
        e.preventDefault();
        opts.openLink(link.dataset.href ?? "");
        return true;
      },
    }),
  ];
}
