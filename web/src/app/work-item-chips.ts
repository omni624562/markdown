/**
 * 文件裡的工作項目連結：旁邊顯示目前的狀態（即時預覽、預覽、Wiki 內容）。狀態一批一起讀、五分鐘內不重新讀取。
 * 從 main.ts 拆出來，透過 `app` 取用 Azure DevOps 的連線與編輯器。
 */
import { StateEffect, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { setBounded } from "../bounded.ts";
import { type AdoWorkItem, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import type { PreviewPlugin } from "../preview.ts";
import { parseRemoteLink } from "../remote-links.ts";
import { linksInLine, stateTone } from "../workitem-chips.ts";
import { app } from "./context.ts";


/** 讀過的狀態（五分鐘內不重新讀取；讀不到的記成 null）。 */
const chipCache = new Map<number, { item: AdoWorkItem | null; at: number }>();
const chipWanted = new Set<number>();
let chipTimer = 0;
const CHIP_TTL = 5 * 60_000;
const chipsChanged = StateEffect.define<null>();

/** 需要 `id` 的狀態：還沒讀過或太舊就排進下一次一起讀（打字停一下才送出）。 */
function wantChip(id: number): void {
  const hit = chipCache.get(id);
  if (hit && Date.now() - hit.at < CHIP_TTL) return;
  if (!desktop || !app.ado?.account) return;
  chipWanted.add(id);
  clearTimeout(chipTimer);
  chipTimer = window.setTimeout(() => void flushChips(), 300);
}

async function flushChips(): Promise<void> {
  const ids = [...chipWanted];
  chipWanted.clear();
  if (!ids.length) return;
  // 先記下時間，讀取期間不會重複排隊。
  for (const id of ids) setBounded(chipCache, id, { item: chipCache.get(id)?.item ?? null, at: Date.now() }, app.CACHE_MAX);
  try {
    const items = await desktop!.adoWorkItemsByIds(ids);
    for (const id of ids) setBounded(chipCache, id, { item: items.find((w) => w.id === id) ?? null, at: Date.now() }, app.CACHE_MAX);
  } catch {
    // 連不到伺服器：留著舊的狀態，五分鐘後再試。
  }
  app.editor.view.dispatch({ effects: chipsChanged.of(null) });
  for (const el of document.querySelectorAll<HTMLElement>(".wi-chip[data-wi]")) fillChip(el, Number(el.dataset.wi));
}

function fillChip(el: HTMLElement, id: number): void {
  const item = chipCache.get(id)?.item;
  // 內容裡本來就寫了狀態（例如相關工作項目）：還沒讀到時先顯示那個狀態。
  const fallback = el.dataset.fallback;
  el.hidden = !item && !fallback;
  if (!item) {
    if (fallback) {
      el.textContent = fallback;
      el.dataset.tone = stateTone(fallback);
    }
    return;
  }
  el.textContent = item.state;
  el.dataset.tone = stateTone(item.state);
  el.title = t("{label}：{title}・{state}", { label: `${item.kind} ${item.id}`, title: item.title, state: item.state });
}

function chipElement(id: number, fallback?: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "wi-chip";
  el.dataset.wi = String(id);
  if (fallback) el.dataset.fallback = fallback;
  fillChip(el, id);
  wantChip(id);
  return el;
}

class ChipWidget extends WidgetType {
  constructor(readonly id: number) {
    super();
  }
  eq(other: ChipWidget): boolean {
    return other.id === this.id;
  }
  toDOM(): HTMLElement {
    return chipElement(this.id);
  }
}

/** 即時預覽：看得到的行裡，連到工作項目的連結後面加上狀態標籤。 */
function chipDecorations(view: EditorView): DecorationSet {
  const base = app.ado?.account?.url;
  if (!desktop || !base) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      for (const link of linksInLine(line.text)) {
        const target = parseRemoteLink(link.url, base);
        if (target?.kind === "workitem") {
          builder.add(line.from + link.end, line.from + link.end, Decoration.widget({ widget: new ChipWidget(target.id), side: 1 }));
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const workItemChips = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = chipDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(chipsChanged)))) {
        this.decorations = chipDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** 預覽、Wiki 內容：連到工作項目的連結後面加上狀態標籤。 */
export const workItemChipsPlugin: PreviewPlugin = {
  name: "workitem-chips",
  apply(_root, scope) {
    const base = app.ado?.account?.url;
    if (!desktop || !base) return;
    for (const a of scope.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (a.nextElementSibling?.classList.contains("wi-chip")) continue;
      const target = parseRemoteLink(a.getAttribute("href") ?? "", base);
      if (target?.kind !== "workitem") continue;
      // 連結後面已經寫了「・狀態」（工作項目的相關工作項目）：換成標籤，不要顯示兩次。
      const next = a.nextSibling;
      const written = next?.nodeType === Node.TEXT_NODE ? /^・([^・\n]+)$/.exec(next.textContent?.trim() ?? "") : null;
      if (written) next!.remove();
      a.after(chipElement(target.id, written?.[1].trim()));
    }
  },
  // 匯出的文件不帶狀態標籤（狀態會變，別人看的時候已經不準了）；原本內容裡寫的狀態放回去。
  exportTransform(root) {
    for (const chip of root.querySelectorAll<HTMLElement>(".wi-chip")) {
      if (chip.dataset.fallback) chip.replaceWith(`・${chip.dataset.fallback}`);
      else chip.remove();
    }
  },
};
