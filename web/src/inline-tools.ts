/**
 * MarkText 式的編輯輔助：
 * - 選取文字時，在上方浮出格式按鈕（拖曳選取的過程中不顯示，放開滑鼠才出現）。
 * - 游標停在空白行時，左邊出現「＋」，按下去可以插入標題、表格、程式碼區塊等。
 * 按鈕的內容與動作由呼叫端提供，這裡只負責何時、在哪裡顯示。
 */
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, StateEffect, StateField, type Transaction } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  showTooltip,
} from "@codemirror/view";
import { t } from "./i18n.ts";

const setPointer = StateEffect.define<boolean>();
const setFocus = StateEffect.define<boolean>();

/** 滑鼠是否按著（拖曳選取中）、編輯器是否有焦點。 */
const interaction = StateField.define<{ pointer: boolean; focused: boolean }>({
  create: () => ({ pointer: false, focused: false }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setPointer)) value = { ...value, pointer: e.value };
      else if (e.is(setFocus)) value = { ...value, focused: e.value, pointer: e.value && value.pointer };
    }
    return value;
  },
});

/**
 * 焦點直接讀 DOM 再寫進狀態。不用 focusChangeEffect：切換檢視時編輯器會短暫失焦又立刻拿回焦點，
 * 那時 CodeMirror 送出的「失焦」可能晚於重新聚焦，狀態就會一直停在失焦。
 */
export const focusTracking: Extension = [
  interaction,
  ViewPlugin.fromClass(
    class {
      view: EditorView;
      timer = 0;
      up = () => {
        if (this.view.state.field(interaction).pointer) this.view.dispatch({ effects: setPointer.of(false) });
      };
      constructor(view: EditorView) {
        this.view = view;
        window.addEventListener("mouseup", this.up);
        // 換文件（setState）時狀態會重設；編輯器原本就有焦點時要補記下來。
        this.sync();
      }
      update(u: ViewUpdate) {
        if (u.focusChanged) this.sync();
      }
      /** 稍後比對 DOM 的焦點和狀態，不一致就更新（不能在 update 裡直接 dispatch）。 */
      sync() {
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          const focused = this.view.hasFocus;
          if (this.view.state.field(interaction, false)?.focused !== focused) {
            this.view.dispatch({ effects: setFocus.of(focused) });
          }
        });
      }
      destroy() {
        clearTimeout(this.timer);
        window.removeEventListener("mouseup", this.up);
      }
    },
    {
      eventHandlers: {
        mousedown(e) {
          if (e.button === 0) this.view.dispatch({ effects: setPointer.of(true) });
        },
        focus() {
          this.sync();
        },
        blur() {
          this.sync();
        },
      },
    },
  ),
];

/** 編輯器是否有焦點（需要 focusTracking；沒有時當作有焦點）。 */
export function editorFocused(state: EditorState): boolean {
  return state.field(interaction, false)?.focused ?? true;
}

/** 這個交易是否改變了焦點狀態。 */
export function focusChanged(tr: Transaction): boolean {
  return tr.effects.some((e) => e.is(setFocus));
}

export interface SelectionToolbarOptions {
  /** 目前是否要顯示（例如只在 Markdown、不是審閱模式時）。 */
  enabled(): boolean;
  /** 建立按鈕列。按鈕要在 mousedown 時 preventDefault，選取範圍才不會消失。 */
  render(view: EditorView): HTMLElement;
}

/** 選取文字時浮出的格式按鈕。 */
export function selectionToolbar(opts: SelectionToolbarOptions): Extension {
  // create 函式固定不變，CodeMirror 才會沿用同一個 DOM，只更新位置。
  const create = (view: EditorView) => {
    const dom = opts.render(view);
    dom.classList.add("cm-format-bubble");
    return { dom, offset: { x: 0, y: 8 } };
  };
  const compute = (state: EditorState): Tooltip | null => {
    const { pointer, focused } = state.field(interaction);
    const sel = state.selection.main;
    if (sel.empty || pointer || !focused || !opts.enabled()) return null;
    return { pos: sel.from, end: sel.to, above: true, arrow: false, create };
  };
  return [
    focusTracking,
    StateField.define<Tooltip | null>({
      create: compute,
      update: (_, tr) => compute(tr.state),
      provide: (f) => showTooltip.from(f),
    }),
  ];
}

export interface InsertHandleOptions {
  enabled(): boolean;
  /** 按下「＋」：在按鈕旁邊開啟插入選單。 */
  open(anchor: HTMLElement): void;
}

class HandleWidget extends WidgetType {
  open: (anchor: HTMLElement) => void;
  constructor(open: (anchor: HTMLElement) => void) {
    super();
    this.open = open;
  }
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-insert-handle";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = t("插入（Ctrl+Shift+Enter）");
    btn.setAttribute("aria-label", t("插入"));
    btn.tabIndex = -1;
    btn.textContent = "+";
    // 不要讓編輯器失去焦點或移動游標。
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => this.open(btn));
    wrap.append(btn);
    return wrap;
  }
}

/** 空白行（不在程式碼區塊或表格裡）。 */
export function emptyLineAt(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  if (line.text.trim()) return false;
  for (let node = syntaxTree(state).resolveInner(pos, 0); node.parent; node = node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "Table" || node.name === "HTMLBlock") return false;
  }
  return true;
}

/** 游標停在空白行時，左邊的「＋」。 */
export function insertHandle(opts: InsertHandleOptions): Extension {
  const widget = Decoration.widget({ widget: new HandleWidget(opts.open), side: -1 });
  const compute = (state: EditorState): DecorationSet => {
    const sel = state.selection;
    const { focused } = state.field(interaction);
    if (sel.ranges.length !== 1 || !sel.main.empty || !focused || !opts.enabled()) return Decoration.none;
    if (!emptyLineAt(state, sel.main.head)) return Decoration.none;
    return Decoration.set(widget.range(state.doc.lineAt(sel.main.head).from));
  };
  return [
    focusTracking,
    StateField.define<DecorationSet>({
      create: compute,
      update: (_, tr) => compute(tr.state),
      provide: (f) => EditorView.decorations.from(f),
    }),
  ];
}
