/**
 * 手機版面（`body.phone`）的助理輸入框：只留「目前的文件」標籤、輸入的地方、「＋」與送出。
 *
 * - 摘要、改寫、翻譯、審稿：還沒開始對話時，在對話區下方顯示成大按鈕（`.assistant-suggest`）。
 * - 「＋」從下面拉起選單：附加檔案、目前的文件／上網查／問整個專案／深入思考的開關、寫作動作、估算費用與本月用量。
 * - 輸入框上方只顯示打開的選項（例如「上網查 ✕」），沒打開的不佔位置（樣式在 styles.css 的「手機的助理」）。
 *
 * 電腦版、平板不顯示這些元件，輸入框維持原樣。
 */
import type { AssistantAction } from "../assistant-text.ts";
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";

/** 「＋」選單裡的開關。 */
export interface PhoneToggle {
  label: string;
  hint: string;
  icon: string;
  on: boolean;
  set(on: boolean): void;
  /** 現在不能打開（例如設定沒開）：按了執行這個（說明要去哪裡開）。 */
  blocked?: () => void;
}

export interface PhoneComposerParts {
  log: HTMLElement;
  bar: HTMLElement;
  /** 主要動作（摘要、改寫…）與「更多」裡的動作（寫作、自訂）。 */
  actions(): { main: AssistantAction[]; more: AssistantAction[] };
  run(action: AssistantAction): void;
  toggles(): PhoneToggle[];
  attach(): void;
  count(): void;
  manageActions(): void;
  usage(): string;
}

function button(className: string, ...children: (Node | string)[]): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.append(...children);
  return b;
}

export function initPhoneComposer(p: PhoneComposerParts): void {
  const sheet = document.createElement("dialog");
  sheet.className = "phone-sheet assistant-sheet";
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) sheet.close();
  });
  document.body.append(sheet);

  const actionLabel = (a: AssistantAction) => (a.needsSelection ? t("{name}（選取的文字）", { name: a.label() }) : a.label());
  const close = (then: () => void) => () => {
    sheet.close();
    then();
  };

  const row = (iconName: string, label: string, hint: string | null, run: () => void) => {
    const text = document.createElement("span");
    text.append(label);
    if (hint) text.append(Object.assign(document.createElement("small"), { textContent: hint }));
    const b = button("phone-row", icon(iconName), text);
    b.addEventListener("click", run);
    return b;
  };

  const renderMain = () => {
    const rows: HTMLElement[] = [row("paperclip", t("附加檔案或圖片"), t("圖片或 PDF"), close(p.attach))];
    for (const tg of p.toggles()) {
      const sw = document.createElement("input");
      sw.type = "checkbox";
      sw.role = "switch";
      sw.className = "switch";
      sw.checked = tg.on;
      sw.tabIndex = -1;
      sw.setAttribute("aria-hidden", "true");
      const r = row(tg.icon, tg.label, tg.hint, () => {
        if (tg.blocked) return close(tg.blocked)();
        tg.set(!sw.checked);
        sw.checked = !sw.checked;
        r.setAttribute("aria-checked", String(sw.checked));
      });
      r.role = "switch";
      r.setAttribute("aria-checked", String(tg.on));
      if (tg.blocked) r.classList.add("is-off");
      r.append(sw);
      rows.push(r);
    }
    rows.push(
      row("pen-line", t("寫作動作"), t("摘要、改寫、翻譯、轉成表格…"), renderMore),
      row("calculator", t("估算這次的費用"), t("送出前算 token 數，不產生回答、不收費"), close(p.count)),
    );
    const usage = document.createElement("p");
    usage.className = "assistant-sheet-usage";
    usage.textContent = p.usage();
    sheet.replaceChildren(Object.assign(document.createElement("div"), { className: "phone-grab" }), ...rows, usage);
  };

  /** 「寫作動作」：全部的動作一列一列，最上面「←」回到「＋」選單。 */
  const renderMore = () => {
    const { main, more } = p.actions();
    const back = row("arrow-left", t("寫作動作"), null, renderMain);
    back.classList.add("assistant-sheet-back");
    const rows = [...main, ...more].map((a) => row(a.group === "custom" ? "wand-sparkles" : "sparkles", actionLabel(a), null, close(() => p.run(a))));
    rows.push(row("settings", t("管理自訂動作…"), null, close(p.manageActions)));
    sheet.replaceChildren(Object.assign(document.createElement("div"), { className: "phone-grab" }), back, ...rows);
  };

  const plus = button("assistant-plus", icon("plus"));
  plus.title = t("附加檔案、上網查、深入思考…");
  plus.setAttribute("aria-label", plus.title);
  plus.addEventListener("click", () => {
    renderMain();
    sheet.showModal();
  });
  p.bar.prepend(plus);

  // 還沒開始對話：常用動作排成大按鈕（對話區是空的才顯示，見 styles.css）。
  const suggest = document.createElement("div");
  suggest.className = "assistant-suggest";
  const hint = Object.assign(document.createElement("p"), { textContent: t("問這份文件，或選一個：") });
  const list = document.createElement("div");
  for (const a of p.actions().main) {
    const b = button("", a.label());
    b.addEventListener("click", () => p.run(a));
    list.append(b);
  }
  const more = button("", t("更多…"));
  more.addEventListener("click", () => {
    renderMore();
    sheet.showModal();
  });
  list.append(more);
  suggest.append(hint, list);
  p.log.after(suggest);
}
