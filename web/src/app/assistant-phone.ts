/**
 * 手機版面（`body.phone`）的助理：「＋」與「更多…」的選單改成從下面拉起來（電腦版是一般的選單，見 app/assistant-composer.ts）。
 *
 * - 「＋」：附加檔案、目前的文件／上網查／問整個專案／深入思考的開關（名稱下面一行說明）、寫作動作、估算費用與本月用量。
 * - 「寫作動作」「更多…」：全部的動作一列一列，最上面「←」回到「＋」選單。
 *
 * 螢幕寬的時候（平板）照電腦版：按鈕照常打開一般的選單。
 */
import { type ComposerParts, actionLabel } from "./assistant-composer.ts";
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";

const isPhone = () => document.body.classList.contains("phone");

export function initPhoneSheet(p: ComposerParts & { usage(): string }, plus: HTMLButtonElement, more: HTMLButtonElement): void {
  const sheet = document.createElement("dialog");
  sheet.className = "phone-sheet assistant-sheet";
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) sheet.close();
  });
  document.body.append(sheet);

  const close = (then: () => void) => () => {
    sheet.close();
    then();
  };
  const row = (iconName: string, label: string, hint: string | null | undefined, run: () => void) => {
    const text = document.createElement("span");
    text.append(label);
    if (hint) text.append(Object.assign(document.createElement("small"), { textContent: hint }));
    const b = document.createElement("button");
    b.type = "button";
    b.className = "phone-row";
    b.append(icon(iconName), text);
    b.addEventListener("click", run);
    return b;
  };
  const grab = () => Object.assign(document.createElement("div"), { className: "phone-grab" });

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
      row("pen-line", t("寫作動作"), t("摘要、改寫、翻譯、轉成表格…"), () => renderMore(true)),
      row("calculator", t("估算這次的費用"), t("送出前算 token 數，不產生回答、不收費"), close(p.count)),
    );
    const usage = document.createElement("p");
    usage.className = "assistant-sheet-usage";
    usage.textContent = p.usage();
    sheet.replaceChildren(grab(), ...rows, usage);
  };

  /** 全部的寫作動作；`back`：從「＋」選單進來，最上面可以回去。 */
  const renderMore = (back: boolean) => {
    const { main, more: rest } = p.actions();
    const head = row("arrow-left", t("寫作動作"), null, back ? renderMain : () => sheet.close());
    head.classList.add("assistant-sheet-back");
    const rows = [...main, ...rest].map((a) => row(a.group === "custom" ? "wand-sparkles" : "sparkles", actionLabel(a), null, close(() => p.run(a))));
    rows.push(row("settings", t("管理自訂動作…"), null, close(p.manageActions)));
    sheet.replaceChildren(grab(), head, ...rows);
  };

  // 手機版面時攔下按鈕原本的選單（取消點擊的預設動作，Popover 就不會打開），改成拉起來的選單。
  const intercept = (button: HTMLButtonElement, render: () => void) =>
    button.addEventListener(
      "click",
      (e) => {
        if (!isPhone()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        render();
        sheet.showModal();
      },
      { capture: true },
    );
  intercept(plus, renderMain);
  intercept(more, () => renderMore(false));
}
