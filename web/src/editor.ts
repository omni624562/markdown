import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { type Diagnostic, forceLinting, linter } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, type StateCommand } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { SourceError } from "../pkg/md_wasm.js";
import type { DocKind } from "./kinds.ts";

/** 顏色全部走 CSS 變數，深淺色主題只要在 styles.css 切換變數即可。 */
const syntaxColors = HighlightStyle.define([
  { tag: t.heading, fontWeight: "700", color: "var(--syn-heading)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--syn-link)" },
  { tag: t.monospace, color: "var(--syn-code)" },
  { tag: [t.processingInstruction, t.contentSeparator, t.quote], color: "var(--syn-meta)" },
  { tag: [t.keyword, t.operatorKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.atom, t.null], color: "var(--syn-number)" },
  { tag: t.propertyName, color: "var(--syn-function)" },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.typeName, t.className], color: "var(--syn-function)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "var(--editor-font-size)", lineHeight: "1.75" },
  ".cm-content": { padding: "20px 0 40vh", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 20px" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--subtle)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-placeholder": { color: "var(--subtle)" },
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--fg)", borderColor: "var(--border)" },
  ".cm-tooltip": { backgroundColor: "var(--surface-raised)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: "8px" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--danger)" },
});

export interface EditorHandlers {
  onChange(doc: string): void;
  onSelection(view: EditorView): void;
  onScroll(topLine: number): void;
  /** JSON 解析錯誤，用於編輯器內的紅色底線提示。 */
  getError(): SourceError | null;
}

const PLACEHOLDER: Record<DocKind, string> = {
  markdown: "開始寫 Markdown…（按 Ctrl+Shift+P 開啟指令面板）",
  text: "開始輸入純文字…",
  json: '貼上或輸入 JSON，例如 {"name": "值"}',
};

export class Editor {
  readonly view: EditorView;
  #language = new Compartment();
  #extensions: Extension[];
  #handlers: EditorHandlers;
  #kind: DocKind;

  constructor(parent: HTMLElement, doc: string, kind: DocKind, handlers: EditorHandlers) {
    this.#handlers = handlers;
    this.#kind = kind;
    this.#extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "文件內容", spellcheck: "false" }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      syntaxHighlighting(syntaxColors),
      theme,
      this.#language.of(this.#languageFor(kind)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) handlers.onChange(u.state.doc.toString());
        if (u.docChanged || u.selectionSet) handlers.onSelection(u.view);
      }),
    ];
    this.view = new EditorView({ parent, state: this.#createState(doc) });

    const scroller = this.view.scrollDOM;
    scroller.addEventListener(
      "scroll",
      () => {
        const block = this.view.lineBlockAtHeight(scroller.scrollTop - this.view.documentPadding.top);
        handlers.onScroll(this.view.state.doc.lineAt(block.from).number);
      },
      { passive: true },
    );
  }

  get kind(): DocKind {
    return this.#kind;
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  #createState(doc: string): EditorState {
    return EditorState.create({ doc, extensions: this.#extensions });
  }

  #languageFor(kind: DocKind): Extension {
    const common = placeholder(PLACEHOLDER[kind]);
    switch (kind) {
      case "markdown":
        return [common, markdown({ base: markdownLanguage, codeLanguages: languages })];
      case "json":
        return [common, json(), linter(() => this.#diagnostics(), { delay: 300 })];
      case "text":
        return common;
    }
  }

  #diagnostics(): Diagnostic[] {
    const err = this.#handlers.getError();
    if (!err) return [];
    const doc = this.view.state.doc;
    const line = doc.line(Math.min(Math.max(err.line, 1), doc.lines));
    const from = Math.min(line.from + Math.max(err.column - 1, 0), line.to);
    return [{ from, to: Math.min(from + 1, line.to), severity: "error", message: err.message }];
  }

  /** 切換文件類型（語法上色、提示等）。 */
  setKind(kind: DocKind): void {
    this.#kind = kind;
    this.view.dispatch({ effects: this.#language.reconfigure(this.#languageFor(kind)) });
  }

  /** 重新檢查錯誤（JSON 解析結果更新後呼叫）。 */
  relint(): void {
    if (this.#kind === "json") forceLinting(this.view);
  }

  /** 換成另一份文件，並清空復原紀錄（開新檔時不該能復原到上一個檔案）。 */
  load(doc: string, kind: DocKind): void {
    this.#kind = kind;
    this.view.setState(this.#createState(doc));
    this.view.dispatch({ effects: this.#language.reconfigure(this.#languageFor(kind)) });
    this.view.scrollDOM.scrollTop = 0;
    this.#handlers.onSelection(this.view);
  }

  /** 把游標移到指定行（與欄）並捲到畫面上方。 */
  reveal(line: number, column = 1): void {
    const doc = this.view.state.doc;
    const l = doc.line(Math.min(Math.max(line, 1), doc.lines));
    const pos = Math.min(l.from + column - 1, l.to);
    this.view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 24 }),
    });
    this.view.focus();
  }

  replaceAll(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      userEvent: "input.format",
    });
  }

  /** 對編輯器執行一個 StateCommand，並把焦點拉回編輯器。 */
  exec(cmd: StateCommand): void {
    cmd({ state: this.view.state, dispatch: (tr) => this.view.dispatch(tr) });
    this.view.focus();
  }
}

/** 游標位置與選取字數，給狀態列使用。 */
export function cursorInfo(view: EditorView): { line: number; column: number; selected: number } {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  let selected = 0;
  for (const r of view.state.selection.ranges) {
    selected += [...view.state.sliceDoc(r.from, r.to)].length;
  }
  return { line: line.number, column: [...line.text.slice(0, sel.head - line.from)].length + 1, selected };
}
