/**
 * 寫作模式（E6）：專注模式淡化目前段落以外的文字；打字機模式讓游標所在行保持在畫面中央。
 * 兩者都只改變顯示，不會動到文件內容或復原紀錄。
 */
import { EditorState, type Extension, RangeSetBuilder, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** 包含 `fromLine`～`toLine` 的段落（前後以空白行為界）的行號範圍。游標在空白行時只算那一行。 */
export function paragraphLines(doc: Text, fromLine: number, toLine: number): { first: number; last: number } {
  const blank = (n: number) => doc.line(n).text.trim() === "";
  let first = fromLine;
  let last = toLine;
  if (fromLine === toLine && blank(fromLine)) return { first, last };
  while (first > 1 && !blank(first - 1)) first--;
  while (last < doc.lines && !blank(last + 1)) last++;
  return { first, last };
}

const dimmed = Decoration.line({ class: "cm-dimmed" });

function dimDecorations(view: EditorView): DecorationSet {
  const { doc, selection } = view.state;
  const { first, last } = paragraphLines(
    doc,
    doc.lineAt(selection.main.from).number,
    doc.lineAt(selection.main.to).number,
  );
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      if (line.number < first || line.number > last) builder.add(line.from, line.from, dimmed);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export function focusMode(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = dimDecorations(view);
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = dimDecorations(u.view);
        }
      },
      { decorations: (p) => p.decorations },
    ),
    EditorView.theme({
      ".cm-line.cm-dimmed": { opacity: "0.3" },
    }),
  ];
}

export function typewriterMode(): Extension {
  return [
    // 打字、刪除、用鍵盤移動游標、復原時才置中；用滑鼠點選或拖曳選取時不捲動，以免畫面亂跳。
    EditorState.transactionExtender.of((tr) => {
      if (!tr.selection && !tr.docChanged) return null;
      if (tr.isUserEvent("select.pointer")) return null;
      const typed = ["input", "delete", "select", "undo", "redo", "move"].some((e) => tr.isUserEvent(e));
      if (!typed) return null;
      return { effects: EditorView.scrollIntoView(tr.newSelection.main.head, { y: "center" }) };
    }),
    // 上方也留白，文件開頭的幾行同樣能捲到畫面中央。
    EditorView.theme({ ".cm-content": { paddingTop: "40vh" } }),
  ];
}
