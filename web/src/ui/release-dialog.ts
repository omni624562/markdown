/**
 * 更新視窗：列出一個版本改了什麼（新版本詢問要不要更新、更新完成後說明這一版的新功能）。
 * 回傳使用者按的按鈕 id；按 Esc 或點外面回傳 null。
 */
import { parseReleaseNotes } from "../release-notes.ts";
import type { ChoiceOption } from "./choice.ts";

export interface ReleaseDialog {
  title: string;
  /** 標題下面的一行說明（例如日期、大小）。 */
  subtitle?: string;
  /** CHANGELOG.md 中這一版的說明；沒有時用 `summary`。 */
  changes?: string;
  summary?: string;
  buttons: ChoiceOption[];
}

export function showRelease(opts: ReleaseDialog): Promise<string | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "choice release";
  dialog.setAttribute("aria-labelledby", "release-title");
  const h = document.createElement("h2");
  h.id = "release-title";
  h.textContent = opts.title;
  dialog.append(h);
  if (opts.subtitle) dialog.append(Object.assign(document.createElement("p"), { className: "release-sub", textContent: opts.subtitle }));

  const body = document.createElement("div");
  body.className = "release-notes";
  const notes = parseReleaseNotes(opts.changes ?? "");
  for (const line of notes.intro) body.append(Object.assign(document.createElement("p"), { textContent: line }));
  for (const section of notes.sections) {
    if (section.title) body.append(Object.assign(document.createElement("h3"), { textContent: section.title }));
    const ul = document.createElement("ul");
    ul.append(...section.items.map((item) => Object.assign(document.createElement("li"), { textContent: item })));
    body.append(ul);
  }
  if (!body.childElementCount && opts.summary) body.append(Object.assign(document.createElement("p"), { textContent: opts.summary }));
  if (body.childElementCount) dialog.append(body);

  const actions = document.createElement("div");
  actions.className = "choice-actions";
  dialog.append(actions);
  return new Promise((resolve) => {
    let result: string | null = null;
    for (const opt of opts.buttons) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn${opt.primary ? " btn-primary" : ""}`;
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
