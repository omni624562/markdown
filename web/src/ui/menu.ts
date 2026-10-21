import { type Commands, formatKeys } from "../commands.ts";
import { icon } from "./icons.ts";

export type MenuEntry = string | "-" | { label: string; icon?: string; checked: () => boolean; run(): void };

/**
 * 下拉選單：用原生 Popover API（點外面、按 Esc 自動關閉），
 * 項目直接取自指令中心，名稱與快速鍵和指令面板一致。
 */
export function setupMenu(button: HTMLButtonElement, commands: Commands, entries: MenuEntry[]): HTMLDivElement {
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.popover = "auto";
  menu.role = "menu";
  menu.id = `${button.id || "menu"}-popover`;
  document.body.append(menu);

  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.popoverTargetElement = menu;

  const build = () => {
    menu.replaceChildren(
      ...entries.flatMap((entry): HTMLElement[] => {
        if (entry === "-") {
          const hr = document.createElement("div");
          hr.className = "menu-sep";
          hr.role = "separator";
          return [hr];
        }
        const item = document.createElement("button");
        item.type = "button";
        let run: () => void;
        if (typeof entry === "string") {
          const cmd = commands.get(entry);
          if (!cmd || !(cmd.when?.() ?? true)) return [];
          item.role = "menuitem";
          if (cmd.icon) item.append(icon(cmd.icon));
          item.append(Object.assign(document.createElement("span"), { textContent: cmd.title }));
          if (cmd.keys) item.append(Object.assign(document.createElement("kbd"), { textContent: formatKeys(cmd.keys) }));
          run = () => void commands.run(cmd.id);
        } else {
          item.role = "menuitemradio";
          item.setAttribute("aria-checked", String(entry.checked()));
          if (entry.icon) item.append(icon(entry.icon));
          item.append(Object.assign(document.createElement("span"), { textContent: entry.label }));
          if (entry.checked()) item.append(icon("check"));
          run = () => entry.run();
        }
        item.addEventListener("click", () => {
          menu.hidePopover();
          run();
        });
        return [item];
      }),
    );
  };

  menu.addEventListener("beforetoggle", (e) => {
    const opening = (e as ToggleEvent).newState === "open";
    button.setAttribute("aria-expanded", String(opening));
    if (!opening) return;
    build();
    // 對齊按鈕下緣；靠近右邊界時改為靠右對齊。
    const r = button.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.bottom = "auto";
    const alignRight = r.left + 260 > window.innerWidth;
    menu.style.left = alignRight ? "auto" : `${Math.max(8, r.left)}px`;
    menu.style.right = alignRight ? `${Math.max(8, window.innerWidth - r.right)}px` : "auto";
  });
  menu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    // 下方放不下時（例如左下角的按鈕）改成往上開，並放在按鈕右邊。
    const r = button.getBoundingClientRect();
    if (menu.getBoundingClientRect().bottom > window.innerHeight - 8) {
      menu.style.top = "auto";
      menu.style.bottom = `${Math.max(8, window.innerHeight - r.bottom)}px`;
      menu.style.left = `${r.right + 6}px`;
    }
    menu.querySelector<HTMLElement>("button")?.focus();
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll<HTMLElement>("button")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
    else return;
    e.preventDefault();
  });
  return menu;
}
