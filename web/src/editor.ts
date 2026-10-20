import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, type Extension, type StateCommand } from "@codemirror/state";
import {
  EditorView,
  type KeyBinding,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** 顏色全部走 CSS 變數，深淺色主題只要在 styles.css 切換變數即可。 */
const markdownHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "700", color: "var(--syn-heading)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--syn-link)" },
  { tag: t.monospace, color: "var(--syn-code)" },
  { tag: [t.processingInstruction, t.contentSeparator, t.quote], color: "var(--syn-meta)" },
  { tag: [t.keyword, t.operatorKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--syn-number)" },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.typeName, t.className], color: "var(--syn-function)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg)" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontSize: "14px",
    lineHeight: "1.7",
  },
  ".cm-content": { padding: "16px 0", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 16px" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--muted)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--active-line)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--fg)" },
});

/** 用 `marker` 包住選取範圍；已經包住時則移除，達成切換效果。 */
function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const n = marker.length;
    const tr = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - n, range.from);
      const after = state.sliceDoc(range.to, range.to + n);
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - n, to: range.from },
            { from: range.to, to: range.to + n },
          ],
          range: EditorSelection.range(range.from - n, range.to - n),
        };
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + n, range.to + n),
      };
    });
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

const formattingKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleWrap("**") },
  { key: "Mod-i", run: toggleWrap("*") },
  { key: "Mod-e", run: toggleWrap("`") },
];

export interface EditorHandlers {
  onChange(doc: string): void;
  onScroll(topLine: number): void;
  extraKeys?: KeyBinding[];
}

export function createEditor(parent: HTMLElement, doc: string, handlers: EditorHandlers): EditorView {
  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    keymap.of([
      ...(handlers.extraKeys ?? []),
      ...formattingKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(markdownHighlight),
    theme,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) handlers.onChange(u.state.doc.toString());
    }),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
  editorExtensions.set(view, extensions);

  view.scrollDOM.addEventListener(
    "scroll",
    () => {
      const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop - view.documentPadding.top);
      handlers.onScroll(view.state.doc.lineAt(block.from).number);
    },
    { passive: true },
  );

  return view;
}

const editorExtensions = new WeakMap<EditorView, Extension>();

/** 換成另一份文件，並清空復原紀錄（開新檔時不該能復原到上一個檔案）。 */
export function loadDoc(view: EditorView, doc: string): void {
  view.setState(EditorState.create({ doc, extensions: editorExtensions.get(view) }));
  view.scrollDOM.scrollTop = 0;
}

/** 把游標移到指定行並捲到畫面頂端。 */
export function revealLine(view: EditorView, line: number): void {
  const pos = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 16 }),
  });
  view.focus();
}
