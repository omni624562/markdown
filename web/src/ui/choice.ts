/**
 * 有多個選項的確認對話框（原生 confirm() 只能「確定／取消」）。
 * 回傳使用者選的選項 id；按 Esc 或點外面則回傳 null。
 */
import { t } from "../i18n.ts";

export interface ChoiceOption {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

export interface ChoiceExtra {
  /** 原樣顯示的文字（例如要執行的指令），用等寬字型、保留換行。 */
  code?: string;
  /** 從外部關閉對話框（例如等待逾時），結果視同取消。 */
  signal?: AbortSignal;
  /** 一開始聚焦的選項（預設是主要選項）。對話框可能在使用者打字時跳出來，危險的動作不要預設聚焦。 */
  focus?: string;
}

/** 請使用者輸入一行文字（例如範本名稱）。取消時回傳 null。 */
export function askText(title: string, message: string, value = "", okLabel = t("確定")): Promise<string | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "choice";
  dialog.setAttribute("aria-labelledby", "ask-title");
  const cancel = t("取消");
  dialog.innerHTML = `<h2 id="ask-title"></h2><p></p><form method="dialog"><input class="choice-input" type="text" />
    <div class="choice-actions"><button type="button" class="btn" value="cancel">${cancel}</button><button class="btn btn-primary" value="ok"></button></div></form>`;
  dialog.querySelector("h2")!.textContent = title;
  dialog.querySelector("p")!.textContent = message;
  const input = dialog.querySelector("input")!;
  input.value = value;
  dialog.querySelector<HTMLButtonElement>(".btn-primary")!.textContent = okLabel;
  return new Promise((resolve) => {
    let result: string | null = null;
    dialog.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      result = input.value.trim();
      dialog.close();
    });
    dialog.querySelector<HTMLButtonElement>("[value=cancel]")!.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    input.select();
  });
}

export function choose(
  title: string,
  message: string,
  options: ChoiceOption[],
  extra: ChoiceExtra = {},
): Promise<string | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "choice";
  dialog.setAttribute("aria-labelledby", "choice-title");
  const h = document.createElement("h2");
  h.id = "choice-title";
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = message;
  const actions = document.createElement("div");
  actions.className = "choice-actions";
  dialog.append(h, p);
  if (extra.code) {
    const pre = document.createElement("pre");
    pre.className = "choice-code";
    pre.textContent = extra.code;
    dialog.append(pre);
  }
  dialog.append(actions);

  return new Promise((resolve) => {
    let result: string | null = null;
    for (const opt of options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn${opt.primary ? " btn-primary" : ""}${opt.danger ? " btn-danger" : ""}`;
      b.textContent = opt.label;
      b.addEventListener("click", () => {
        result = opt.id;
        dialog.close();
      });
      actions.append(b);
    }
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    extra.signal?.addEventListener("abort", () => dialog.close(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    const index = extra.focus ? options.findIndex((o) => o.id === extra.focus) : -1;
    const buttons = actions.querySelectorAll<HTMLButtonElement>("button");
    (index >= 0 ? buttons[index] : actions.querySelector<HTMLButtonElement>(".btn-primary"))?.focus();
  });
}
