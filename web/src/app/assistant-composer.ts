/**
 * 助理輸入框的「＋」與還沒開始對話時的常用動作。
 *
 * 輸入框只留打開的選項（輸入框上方的標籤）、輸入的地方、「＋」與送出：
 * - 摘要、改寫、翻譯、審稿：對話區還是空的時候，排在輸入框上方（`.assistant-suggest`，見 styles.css）。
 * - 「＋」選單：附加圖片或 PDF、估算費用、目前的文件／上網查／問整個專案／深入思考的開關、全部的寫作動作。
 */
import type { AssistantAction } from "../assistant-text.ts";
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";
import { type MenuEntry, setupMenu } from "../ui/menu.ts";

/** 「＋」選單裡的開關（和輸入框上方的標籤是同一組狀態）。 */
export interface ComposerToggle {
  label: string;
  icon: string;
  on: boolean;
  set(on: boolean): void;
  /** 現在不能打開（例如設定沒開）：按了執行這個（說明要去哪裡開）。 */
  blocked?: () => void;
}

export interface ComposerParts {
  log: HTMLElement;
  bar: HTMLElement;
  /** 主要動作（摘要、改寫…）與其他動作（寫作、自訂）。 */
  actions(): { main: AssistantAction[]; more: AssistantAction[] };
  run(action: AssistantAction): void;
  toggles(): ComposerToggle[];
  attach(): void;
  count(): void;
  manageActions(): void;
}

export const actionLabel = (a: AssistantAction): string => (a.needsSelection ? t("{name}（選取的文字）", { name: a.label() }) : a.label());

/** 寫作動作的選單項目（`withMain`：連摘要、改寫等主要動作一起列），最後是管理自訂動作。 */
function writeEntries(p: ComposerParts, withMain: boolean): MenuEntry[] {
  const { main, more } = p.actions();
  const item = (a: AssistantAction) => ({ label: actionLabel(a), run: () => p.run(a) });
  const custom = more.filter((a) => a.group === "custom");
  return [
    ...(withMain ? [...main.map(item), "-" as const] : []),
    ...more.filter((a) => a.group !== "custom").map(item),
    "-",
    ...(custom.length ? [{ heading: t("自訂動作") }, ...custom.map(item)] : []),
    { label: custom.length ? t("管理自訂動作…") : t("新增自訂動作…"), icon: "settings", run: p.manageActions },
  ];
}

export function initComposer(p: ComposerParts): { plus: HTMLButtonElement; suggest: HTMLElement } {
  const plus = document.createElement("button");
  plus.type = "button";
  plus.id = "assistant-plus";
  plus.className = "assistant-plus";
  plus.title = t("附加檔案、上網查、深入思考、寫作動作…");
  plus.setAttribute("aria-label", plus.title);
  plus.append(icon("plus"));
  setupMenu(plus, null, () => [
    { label: t("附加圖片或 PDF…"), icon: "paperclip", run: p.attach },
    { label: t("估算這一題的費用"), icon: "calculator", run: p.count },
    "-",
    ...p.toggles().map((tg): MenuEntry => {
      if (tg.blocked) return { label: t("{name}（要先在設定開啟）", { name: tg.label }), icon: tg.icon, run: tg.blocked };
      // 開關按了不關掉選單，可以連續切換好幾個。
      let on = tg.on;
      return { label: tg.label, icon: tg.icon, checked: () => on, keepOpen: true, run: () => tg.set((on = !on)) };
    }),
    "-",
    { label: t("寫作動作"), icon: "pen-line", items: writeEntries(p, true) },
  ]);
  p.bar.prepend(plus);

  // 還沒開始對話：常用動作排在輸入框上方（對話區是空的才顯示，見 styles.css）。
  const suggest = document.createElement("div");
  suggest.className = "assistant-suggest";
  const hint = Object.assign(document.createElement("p"), { textContent: t("問這份文件，或選一個：") });
  const list = document.createElement("div");
  for (const a of p.actions().main) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.label();
    b.title = a.needsSelection ? t("先選取文字") : a.prompt();
    b.addEventListener("click", () => p.run(a));
    list.append(b);
  }
  const more = document.createElement("button");
  more.type = "button";
  more.id = "assistant-write";
  more.textContent = t("更多…");
  more.title = t("更多寫作動作");
  setupMenu(more, null, () => writeEntries(p, false));
  list.append(more);
  suggest.append(hint, list);
  p.log.after(suggest);
  return { plus, suggest };
}
