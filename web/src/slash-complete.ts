/**
 * 斜線指令：在空白行輸入「/」叫出插入選單（標題、清單、表格、待辦、圖片……），
 * 繼續打字可以篩選（中文或英文都行，例如「/表格」「/table」），按 Enter 插入。
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

export interface SlashItem {
  id: string;
  title: string;
  /** 篩選用的其他關鍵字（英文、別名）。 */
  keywords: string;
  /** 快速鍵（顯示在右邊）。 */
  keys?: string;
}

/** 依輸入的文字篩選，標題開頭相符的排前面。 */
export function filterSlash(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const score = (it: SlashItem) => {
    const title = it.title.toLowerCase();
    if (title.startsWith(q)) return 0;
    if (title.includes(q)) return 1;
    if (it.keywords.toLowerCase().split(/\s+/).some((k) => k.startsWith(q))) return 2;
    return -1;
  };
  return items
    .map((it, i) => ({ it, i, s: score(it) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.it);
}

export function slashCompletion(
  items: () => readonly SlashItem[],
  run: (id: string) => void,
): (ctx: CompletionContext) => CompletionResult | null {
  return (ctx) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const m = /^(\s*)\/([^\s/]{0,12})$/.exec(before);
    if (!m) return null;
    // 程式碼區塊裡的「/」是內容，不是指令。
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    for (let n: typeof node | null = node; n; n = n.parent) {
      if (/^(FencedCode|CodeBlock|InlineCode)$/.test(n.name)) return null;
    }
    const from = line.from + m[1].length;
    const options: Completion[] = filterSlash(items(), m[2]).map((it) => ({
      label: it.title,
      detail: it.keys,
      apply(view: EditorView, _c: Completion, _from: number, to: number) {
        view.dispatch({ changes: { from, to, insert: "" }, userEvent: "delete.slash" });
        run(it.id);
      },
    }));
    if (!options.length) return null;
    return { from, options, filter: false };
  };
}
