/**
 * 有多個選項的確認對話框（原生 confirm() 只能「確定／取消」）。
 * 回傳使用者選的選項 id；按 Esc 或點外面則回傳 null。
 */
export interface ChoiceOption {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

export function choose(title: string, message: string, options: ChoiceOption[]): Promise<string | null> {
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
  dialog.append(h, p, actions);

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
    document.body.append(dialog);
    dialog.showModal();
    actions.querySelector<HTMLButtonElement>(".btn-primary")?.focus();
  });
}
