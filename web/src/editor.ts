import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  LanguageDescription,
  type LanguageSupport,
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { type Diagnostic, forceLinting, linter } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, Prec, type StateCommand } from "@codemirror/state";
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
import { bracketPairing } from "./brackets.ts";
import type { DocKind } from "./kinds.ts";
import { type Formatter, newRow, nextCell, previousCell } from "./table.ts";
import { cjkWords } from "./words.ts";
import { focusMode, typewriterMode } from "./writing-modes.ts";
import { createFindPanel } from "./ui/find-panel.ts";

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
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--editor-font-size)",
    lineHeight: "1.75",
    // 原始碼要顯示真正的字元，不要把 `|-`、`->` 之類合成連字。
    fontVariantLigatures: "none",
    fontFeatureSettings: '"liga" 0, "calt" 0',
  },
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

export interface EditorOptions {
  lineNumbers: boolean;
  autoPairBrackets: boolean;
  /** 表格排版器；不需要自動對齊時傳入原樣回傳的函式。 */
  formatTable: Formatter;
  /** 專注模式：淡化目前段落以外的文字。 */
  focusMode?: boolean;
  /** 打字機模式：游標所在行保持在畫面中央。 */
  typewriterMode?: boolean;
  /** 即時預覽（只用在 Markdown）。 */
  livePreview?: boolean;
  /** 即時預覽的擴充（由呼叫端建立，需要圖片網址、表格轉換等）。 */
  live?: Extension;
  /** Markdown 專用的擴充（例如選取文字時浮出的格式按鈕）。 */
  markdownTools?: Extension;
  /** 其他擴充（例如差異檢視）。 */
  extra?: Extension[];
}

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

/** CodeMirror 內建介面（搜尋與取代列、跳到行、摺疊）的中文字串。 */
const PHRASES = {
  Find: "尋找",
  Replace: "取代",
  next: "下一個",
  previous: "上一個",
  all: "全選",
  "match case": "大小寫須相符",
  regexp: "正規表示式",
  "by word": "全字拼寫須相符",
  replace: "取代",
  "replace all": "全部取代",
  close: "關閉",
  "current match": "目前的符合項目",
  "replaced $ matches": "已取代 $ 處",
  "replaced match on line $": "已取代第 $ 行的符合項目",
  "on line": "在第",
  "Go to line": "跳到第幾行",
  go: "前往",
  "Selection deleted": "已刪除選取範圍",
  "Control character": "控制字元",
  "folded code": "摺疊的內容",
  unfold: "展開",
  "Fold line": "摺疊",
  "Unfold line": "展開",
  "Folded lines": "已摺疊",
  "Unfolded lines": "已展開",
  Completions: "自動完成",
  to: "到",
};

export class Editor {
  readonly view: EditorView;
  #language = new Compartment();
  #gutter = new Compartment();
  #writing = new Compartment();
  #extensions: Extension[];
  #handlers: EditorHandlers;
  #kind: DocKind;
  #options: EditorOptions;
  /** 目前文件的檔名；純文字類型依副檔名替程式碼、YAML、HTML 等上色。 */
  #fileName = "";
  /** 依檔名載入好的語法（`null` 表示這個檔名沒有對應的語法）。 */
  #syntax: LanguageSupport | null = null;

  constructor(parent: HTMLElement, doc: string, kind: DocKind, handlers: EditorHandlers, options: EditorOptions) {
    this.#handlers = handlers;
    this.#kind = kind;
    this.#options = options;
    this.#extensions = [
      this.#gutter.of(this.#gutterFor(options)),
      this.#writing.of(this.#writingFor(options)),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ createPanel: createFindPanel }),
      EditorView.lineWrapping,
      EditorState.phrases.of(PHRASES),
      EditorView.contentAttributes.of({ "aria-label": "文件內容", spellcheck: "false" }),
      cjkWords(),
      folding(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
      syntaxHighlighting(syntaxColors),
      theme,
      this.#language.of(this.#languageFor(kind)),
      ...(options.extra ?? []),
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

  #gutterFor(options: EditorOptions): Extension {
    // 即時預覽像在看文件，不顯示行號。
    const live = options.livePreview && this.#kind === "markdown";
    return options.lineNumbers && !live ? [lineNumbers(), highlightActiveLineGutter()] : [];
  }

  #writingFor(options: EditorOptions): Extension {
    return [options.focusMode ? focusMode() : [], options.typewriterMode ? typewriterMode() : []];
  }

  #languageFor(kind: DocKind): Extension {
    const common = placeholder(PLACEHOLDER[kind]);
    const brackets = this.#options.autoPairBrackets ? bracketPairing() : [];
    switch (kind) {
      case "markdown": {
        const fmt = (b: string) => this.#options.formatTable(b);
        const composing = () => this.view.composing;
        return [
          common,
          brackets,
          this.#options.livePreview ? (this.#options.live ?? []) : [],
          this.#options.markdownTools ?? [],
          // 表格按鍵優先於縮排與清單延續；不在表格中時會交給下一個處理者。
          Prec.high(
            keymap.of([
              { key: "Tab", run: nextCell(fmt, composing) },
              { key: "Shift-Tab", run: previousCell(fmt, composing) },
              { key: "Enter", run: newRow(fmt, composing) },
            ]),
          ),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
        ];
      }
      case "json":
        return [common, json(), linter(() => this.#diagnostics(), { delay: 300 })];
      case "text":
        return [common, brackets, this.#syntax ?? []];
    }
  }

  /** 套用新的設定（行號、括號配對、表格排版）。 */
  configure(options: Partial<EditorOptions>): void {
    this.#options = { ...this.#options, ...options };
    this.view.dispatch({
      effects: [
        this.#gutter.reconfigure(this.#gutterFor(this.#options)),
        this.#writing.reconfigure(this.#writingFor(this.#options)),
        this.#language.reconfigure(this.#languageFor(this.#kind)),
      ],
    });
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
    this.view.dispatch({
      effects: [
        this.#gutter.reconfigure(this.#gutterFor(this.#options)),
        this.#language.reconfigure(this.#languageFor(kind)),
      ],
    });
  }

  /** 告訴編輯器目前文件的檔名：純文字類型會依副檔名載入對應的語法上色（例如 .py、.yaml、.html）。 */
  setFileName(name: string): void {
    if (name === this.#fileName) return;
    this.#fileName = name;
    const had = this.#syntax !== null;
    this.#syntax = null;
    // 這個方法可能在編輯器更新的過程中被呼叫，所以稍後再套用。
    if (had) queueMicrotask(() => this.#applySyntax());
    LanguageDescription.matchFilename(languages, name)
      ?.load()
      .then((support) => {
        // 載入期間可能已經換了檔案。
        if (this.#fileName !== name) return;
        this.#syntax = support;
        this.#applySyntax();
      })
      .catch(console.error);
  }

  #applySyntax(): void {
    if (this.#kind === "text") this.view.dispatch({ effects: this.#language.reconfigure(this.#languageFor("text")) });
  }

  /** 重新檢查錯誤（JSON 解析結果更新後呼叫）。 */
  relint(): void {
    if (this.#kind === "json") forceLinting(this.view);
  }

  /** 換成另一份文件，並清空復原紀錄（開新檔時不該能復原到上一個檔案）。 */
  load(doc: string, kind: DocKind): void {
    this.#kind = kind;
    this.view.setState(this.#createState(doc));
    // 新的 state 會用建立編輯器時的初始設定，所以要重新套用目前的設定。
    this.view.dispatch({
      effects: [
        this.#gutter.reconfigure(this.#gutterFor(this.#options)),
        this.#writing.reconfigure(this.#writingFor(this.#options)),
        this.#language.reconfigure(this.#languageFor(kind)),
      ],
    });
    this.view.scrollDOM.scrollTop = 0;
    this.#handlers.onSelection(this.view);
  }

  /** 目前的完整狀態（內容、游標、復原紀錄），切換分頁時保存。 */
  get state(): EditorState {
    return this.view.state;
  }

  /** 換回先前保存的狀態，並套用目前的設定（保存後設定可能已經改過）。 */
  restore(state: EditorState, kind: DocKind, scrollTop = 0): void {
    this.#kind = kind;
    this.view.setState(state);
    this.view.dispatch({
      effects: [
        this.#gutter.reconfigure(this.#gutterFor(this.#options)),
        this.#writing.reconfigure(this.#writingFor(this.#options)),
        this.#language.reconfigure(this.#languageFor(kind)),
      ],
    });
    requestAnimationFrame(() => (this.view.scrollDOM.scrollTop = scrollTop));
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

  /**
   * 換掉整份內容（可復原）。只替換有差異的中間段落，游標和捲動位置才不會跳走。
   * `isolate` 為 true 時自成一個復原步驟，不會和前後的輸入合併。
   */
  replaceAll(text: string, { userEvent = "input.format", isolate = false } = {}): void {
    const old = this.view.state.doc.toString();
    const max = Math.min(old.length, text.length);
    let start = 0;
    while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++;
    let end = 0;
    while (end < max - start && old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++;
    if (start === old.length && old.length === text.length) return;
    this.view.dispatch({
      changes: { from: start, to: old.length - end, insert: text.slice(start, text.length - end) },
      userEvent,
      annotations: isolate ? isolateHistory.of("full") : undefined,
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
    // 依字元（不是 UTF-16 單位）計算；不展開成陣列，全選大文件時才不會配置大量記憶體。
    const text = view.state.sliceDoc(r.from, r.to);
    let n = text.length;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) n--;
    }
    selected += n;
  }
  return { line: line.number, column: [...line.text.slice(0, sel.head - line.from)].length + 1, selected };
}

/**
 * 摺疊：標題左邊的箭頭可以收起整個章節（到下一個同級或更高的標題為止），程式碼區塊、清單、JSON 也能摺疊。
 * 箭頭平常隱藏，滑鼠移到左邊才出現；摺起來的地方顯示「⋯」，點一下展開。
 * 快速鍵：Ctrl+Shift+[ 摺疊、Ctrl+Shift+] 展開、Ctrl+Alt+[ 全部摺疊、Ctrl+Alt+] 全部展開。
 */
function folding(): Extension {
  return [
    codeFolding({
      placeholderDOM(_view, onclick) {
        const el = document.createElement("span");
        el.className = "cm-foldPlaceholder";
        el.textContent = "⋯";
        el.title = "已摺疊，按一下展開";
        el.setAttribute("aria-label", "已摺疊的內容，按一下展開");
        el.onclick = onclick;
        return el;
      },
    }),
    foldGutter({
      markerDOM(open) {
        const el = document.createElement("span");
        el.className = `cm-fold-marker${open ? "" : " folded"}`;
        el.textContent = "›";
        el.title = open ? "摺疊這個章節" : "展開";
        return el;
      },
    }),
  ];
}

