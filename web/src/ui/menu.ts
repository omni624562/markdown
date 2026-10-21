import { type Commands, formatKeys } from "../commands.ts";
import { icon } from "./icons.ts";
import { placeMenu } from "./menu-place.ts";

export type MenuEntry =
  | string
  | "-"
  | { label: string; icon?: string; checked: () => boolean; run(): void }
  /** 子選單：滑鼠移上去、點一下或按 → 展開。 */
  | { label: string; icon?: string; items: MenuEntry[] };

/** 把選單放在 `anchor` 旁邊，一律留在視窗內，太高時可以捲動。 */
function position(menu: HTMLElement, anchor: DOMRect, side: "below" | "right"): void {
  menu.style.maxHeight = "";
  const { width, height } = menu.getBoundingClientRect();
  const p = placeMenu(anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight }, side);
  Object.assign(menu.style, { left: `${p.left}px`, top: `${p.top}px`, right: "auto", bottom: "auto", maxHeight: `${p.maxHeight}px` });
}

/** 上下鍵在同一層的項目間移動。 */
function navigate(menu: HTMLElement, e: KeyboardEvent): boolean {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return false;
  const items = [...menu.querySelectorAll<HTMLElement>(":scope > button")];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
  return true;
}

function newMenu(): HTMLDivElement {
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.popover = "auto";
  menu.role = "menu";
  return menu;
}

/**
 * 下拉選單：用原生 Popover API（點外面、按 Esc 自動關閉），
 * 項目直接取自指令中心，名稱與快速鍵和指令面板一致。
 */
export function setupMenu(button: HTMLButtonElement, commands: Commands, entries: MenuEntry[]): HTMLDivElement {
  const root = newMenu();
  root.id = `${button.id || "menu"}-popover`;
  document.body.append(root);

  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.popoverTargetElement = root;

  /** 建立一層選單的項目；子選單放在這一層裡面，Popover 才會當成巢狀（開子選單時不會關掉上一層）。 */
  const fill = (menu: HTMLElement, list: MenuEntry[]): void => {
    let openSub: HTMLElement | null = null;
    let hoverTimer = 0;
    const closeSub = () => {
      clearTimeout(hoverTimer);
      if (openSub?.matches(":popover-open")) openSub.hidePopover();
      openSub = null;
    };
    const items = list.flatMap((entry): HTMLElement[] => {
      if (entry === "-") {
        const hr = document.createElement("div");
        hr.className = "menu-sep";
        hr.role = "separator";
        return [hr];
      }
      const item = document.createElement("button");
      item.type = "button";
      if (typeof entry === "string") {
        const cmd = commands.get(entry);
        if (!cmd || !(cmd.when?.() ?? true)) return [];
        item.role = "menuitem";
        if (cmd.icon) item.append(icon(cmd.icon));
        item.append(Object.assign(document.createElement("span"), { textContent: cmd.title }));
        const keys = cmd.keys ?? cmd.shownKeys;
        if (keys) item.append(Object.assign(document.createElement("kbd"), { textContent: formatKeys(keys) }));
        item.addEventListener("click", () => {
          root.hidePopover();
          void commands.run(cmd.id);
        });
      } else if ("items" in entry) {
        const sub = newMenu();
        sub.classList.add("submenu");
        fill(sub, entry.items);
        if (!sub.querySelector("button")) return [];
        item.role = "menuitem";
        item.setAttribute("aria-haspopup", "menu");
        item.setAttribute("aria-expanded", "false");
        item.classList.add("has-submenu");
        if (entry.icon) item.append(icon(entry.icon));
        item.append(Object.assign(document.createElement("span"), { textContent: entry.label }), icon("chevron-right"));
        const open = (focusFirst: boolean) => {
          clearTimeout(hoverTimer);
          if (openSub !== sub) closeSub();
          if (!sub.matches(":popover-open")) {
            sub.showPopover();
            position(sub, item.getBoundingClientRect(), "right");
          }
          openSub = sub;
          if (focusFirst) sub.querySelector<HTMLElement>(":scope > button")?.focus();
        };
        item.addEventListener("click", () => open(false));
        item.addEventListener("pointerenter", () => {
          clearTimeout(hoverTimer);
          hoverTimer = window.setTimeout(() => open(false), 120);
        });
        item.addEventListener("keydown", (e) => {
          if (e.key !== "ArrowRight" && e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          open(true);
        });
        sub.addEventListener("toggle", (e) => {
          const opened = (e as ToggleEvent).newState === "open";
          item.setAttribute("aria-expanded", String(opened));
          item.classList.toggle("open", opened);
          if (!opened && sub.contains(document.activeElement)) item.focus();
        });
        sub.addEventListener("keydown", (e) => {
          // 子選單在上一層裡面，按鍵不要再傳上去。
          if (navigate(sub, e)) e.preventDefault();
          else if (e.key === "ArrowLeft") {
            e.preventDefault();
            sub.hidePopover();
            item.focus();
          } else return;
          e.stopPropagation();
        });
        menu.append(sub);
        return [item];
      } else {
        item.role = "menuitemradio";
        item.setAttribute("aria-checked", String(entry.checked()));
        if (entry.icon) item.append(icon(entry.icon));
        item.append(Object.assign(document.createElement("span"), { textContent: entry.label }));
        if (entry.checked()) item.append(icon("check"));
        item.addEventListener("click", () => {
          root.hidePopover();
          entry.run();
        });
      }
      // 滑鼠移到其他項目時收起已展開的子選單。
      item.addEventListener("pointerenter", closeSub);
      return [item];
    });
    // 隱藏的項目可能讓分隔線相鄰或出現在頭尾，一併拿掉。
    const isSep = (el: HTMLElement) => el.classList.contains("menu-sep");
    const shown: HTMLElement[] = [];
    for (const el of items) {
      if (isSep(el) && (!shown.length || isSep(shown[shown.length - 1]))) continue;
      shown.push(el);
    }
    if (shown.length && isSep(shown[shown.length - 1])) shown.pop();
    // 子選單（已經放進 menu）留在最後面。
    menu.prepend(...shown);
  };

  root.addEventListener("beforetoggle", (e) => {
    const opening = (e as ToggleEvent).newState === "open";
    button.setAttribute("aria-expanded", String(opening));
    if (!opening) return;
    root.replaceChildren();
    fill(root, entries);
    // 開啟後才量得到大小，定位好之前先不顯示。
    root.style.visibility = "hidden";
  });
  root.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    position(root, button.getBoundingClientRect(), "below");
    root.style.visibility = "";
    root.querySelector<HTMLElement>(":scope > button")?.focus();
  });
  root.addEventListener("keydown", (e) => {
    if (navigate(root, e)) e.preventDefault();
  });
  return root;
}
