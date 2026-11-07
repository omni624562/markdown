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
  /** 一開始聚焦的選項（預設是主要選項）。危險的動作不會預設聚焦（見 {@link choiceLayout}）。 */
  focus?: string;
}

/** 取消的選項 id。 */
const CANCEL = "cancel";

/**
 * 按鈕的順序與一開始聚焦的選項。有危險動作（`danger`，刪除、不儲存、覆蓋等）的對話框全部同一種規則，
 * 照 Windows 的慣例：「取消」一律在最右邊，危險的動作（紅色）緊貼在它左邊，其他不危險的選項排在最前面；
 * 一開始聚焦的一定不是危險的動作（呼叫端指定的、不危險的主要選項，或「取消」）。這樣最右邊永遠是取消，
 * 對話框在使用者打字時跳出來，按 Enter 也不會誤按危險的動作。
 * 沒有危險動作的對話框照呼叫端給的順序，聚焦指定的或主要選項；都沒有時回傳 null（由瀏覽器決定）。
 */
export function choiceLayout(options: readonly ChoiceOption[], focus?: string): { order: ChoiceOption[]; focus: string | null } {
  const safe = options.filter((o) => !o.danger);
  if (safe.length === options.length) {
    return { order: [...options], focus: options.find((o) => o.id === focus)?.id ?? options.find((o) => o.primary)?.id ?? null };
  }
  const others = safe.filter((o) => o.id !== CANCEL);
  const order = [...others, ...options.filter((o) => o.danger), ...safe.filter((o) => o.id === CANCEL)].map((o) =>
    o.danger || o.id === CANCEL ? { ...o, primary: false } : o,
  );
  const first =
    safe.find((o) => o.id === focus) ?? others.find((o) => o.primary) ?? safe.find((o) => o.id === CANCEL) ?? safe[0];
  return { order, focus: first?.id ?? null };
}

/** 請使用者輸入一行文字（例如範本名稱）。取消時回傳 null。`secret` 時輸入的內容顯示成圓點（例如 API 金鑰）。 */
export function askText(title: string, message: string, value = "", okLabel = t("確定"), secret = false): Promise<string | null> {
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
  if (secret) {
    input.type = "password";
    input.autocomplete = "off";
  }
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

  const layout = choiceLayout(options, extra.focus);
  return new Promise((resolve) => {
    let result: string | null = null;
    for (const opt of layout.order) {
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
    actions.querySelectorAll<HTMLButtonElement>("button")[layout.order.findIndex((o) => o.id === layout.focus)]?.focus();
  });
}
