import { type Commands, formatKeys } from "../commands.ts";
import { t } from "../i18n.ts";
import { containWheel } from "./contain-wheel.ts";
import { icon } from "./icons.ts";
import { placeMenu } from "./menu-place.ts";
// 所有 <select> 的清單也用 oMarker 的選單，一律留在視窗內（見 select-menu.ts）。
import "./select-menu.ts";

export type MenuEntry =
  | string
  | "-"
  /** 一般動作（沒給 `checked`）或可勾選的項目；`when` 回傳 false 時不列出。 */
  | { label: string; icon?: string; checked?: () => boolean; when?: () => boolean; run(): void }
  /** 子選單：滑鼠移上去、點一下或按 → 展開。 */
  | { label: string; icon?: string; items: MenuEntry[] }
  /** 一區的小標題（不能點）。 */
  | { heading: string };

/** 把選單放在 `anchor` 旁邊，一律留在視窗內，太高時可以捲動。 */
function position(menu: HTMLElement, anchor: DOMRect, side: "below" | "right"): void {
  menu.style.maxHeight = "";
  const { width, height } = menu.getBoundingClientRect();
  const p = placeMenu(anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight }, side);
  Object.assign(menu.style, { left: `${p.left}px`, top: `${p.top}px`, right: "auto", bottom: "auto", maxHeight: `${p.maxHeight}px` });
}

/** 子選單裡的指令省略和子選單同名的前綴（「Git」子選單裡的「Git：提交…」顯示成「提交…」）。 */
export function menuTitle(title: string, parent?: string): string {
  if (!parent) return title;
  for (const sep of ["：", ": "]) { // i18n-ignore（全形與半形冒號）
    if (title.startsWith(parent + sep) && title.length > parent.length + sep.length) return title.slice(parent.length + sep.length);
  }
  return title;
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

/**
 * 焦點跟著滑鼠（和 Windows 的選單一樣）：開啟時鍵盤焦點在第一項，滑鼠移到別項時焦點也移過去，
 * 畫面上只會有一項反白，之後改用方向鍵也從滑鼠所在的那一項接著走。
 */
function focusOnHover(item: HTMLElement): void {
  item.addEventListener("pointermove", () => {
    if (document.activeElement !== item) item.focus({ preventScroll: true });
  });
}

/** 選單裡的指令可以釘到看得到的地方（檔案面板上方、左側圖示列，見 app/pin-commands.ts）。 */
export interface CommandPins {
  /** 釘選的選項（已經釘了的是移除）。 */
  entries(id: string): MenuEntry[];
  /** 已經釘在某個地方。 */
  pinned(id: string): boolean;
  /** 在指令項目上按右鍵：在滑鼠的位置開釘選的選項。 */
  context(id: string, at: DOMRect): void;
}
let commandPins: CommandPins | null = null;
export function onCommandPins(pins: CommandPins): void {
  commandPins = pins;
}

function newMenu(): HTMLDivElement {
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.popover = "auto";
  menu.role = "menu";
  containWheel(menu);
  return menu;
}

/**
 * 下拉選單：用原生 Popover API（點外面、按 Esc 自動關閉），
 * 項目直接取自指令中心，名稱與快速鍵和指令面板一致。
 */
/** 項目名稱前面的圖示（記下名稱，連續相同的只畫第一個）。 */
function leadIcon(name: string): SVGElement {
  const el = icon(name);
  el.dataset.icon = name;
  return el;
}

/**
 * 連續幾項用同一個圖示（例如分頁選單的關閉分頁、關閉其他分頁、關閉所有分頁……）時只在第一項畫，
 * 後面的換成一樣寬的空白，文字照樣對齊；分隔線之後重新算。
 */
export function hideRepeatedIcons(items: readonly HTMLElement[]): void {
  let prev: string | null = null;
  for (const el of items) {
    if (el.classList.contains("menu-sep")) {
      prev = null;
      continue;
    }
    const lead = el.firstElementChild instanceof SVGElement ? el.firstElementChild : null;
    const name = lead?.dataset.icon ?? null;
    if (lead && name && name === prev) {
      const blank = document.createElement("span");
      blank.className = "icon menu-icon-blank";
      blank.setAttribute("aria-hidden", "true");
      lead.replaceWith(blank);
    }
    prev = name;
  }
}

/** `entries` 也可以是函式：每次打開選單時才產生（例如「最近用過」這種會變的項目）。 */
export function setupMenu(button: HTMLButtonElement, commands: Commands | null, entries: MenuEntry[] | (() => MenuEntry[])): HTMLDivElement {
  const root = newMenu();
  root.id = `${button.id || "menu"}-popover`;
  document.body.append(root);

  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.popoverTargetElement = root;

  /** 建立一層選單的項目；子選單放在這一層裡面，Popover 才會當成巢狀（開子選單時不會關掉上一層）。 */
  const fill = (menu: HTMLElement, list: MenuEntry[], parent?: string): void => {
    let openSub: HTMLElement | null = null;
    let hoverTimer = 0;
    const closeSub = () => {
      clearTimeout(hoverTimer);
      if (openSub?.matches(":popover-open")) openSub.hidePopover();
      openSub = null;
    };
    const build = (entry: MenuEntry): HTMLElement[] => {
      if (entry === "-") {
        const hr = document.createElement("div");
        hr.className = "menu-sep";
        hr.role = "separator";
        return [hr];
      }
      if (typeof entry === "object" && "heading" in entry) {
        const head = document.createElement("div");
        head.className = "menu-head";
        head.role = "presentation";
        head.textContent = entry.heading;
        return [head];
      }
      const item = document.createElement("button");
      item.type = "button";
      if (typeof entry === "string") {
        const cmd = commands?.get(entry);
        if (!cmd || !(cmd.when?.() ?? true)) return [];
        // 單選的指令（例如明暗的跟隨系統／淺色／深色）：目前選的那一項打勾。
        const checked = cmd.checked?.();
        item.role = checked === undefined ? "menuitem" : "menuitemradio";
        if (checked !== undefined) item.setAttribute("aria-checked", String(checked));
        if (cmd.icon) item.append(leadIcon(cmd.icon));
        item.append(Object.assign(document.createElement("span"), { textContent: menuTitle(cmd.title, parent) }));
        const note = cmd.note?.();
        if (note) item.append(Object.assign(document.createElement("small"), { className: "menu-note", textContent: note }));
        const keys = cmd.keys ?? cmd.shownKeys;
        if (keys) item.append(Object.assign(document.createElement("kbd"), { textContent: formatKeys(keys) }));
        if (checked) item.append(icon("check"));
        item.addEventListener("click", () => {
          root.hidePopover();
          void commands?.run(cmd.id);
        });
        // 釘到看得到的地方（有圖示的指令才能釘）：滑鼠移到項目上時右邊出現圖釘，按圖釘（或按 →）展開釘選的子選單；
        // 已經釘了的圖釘一直顯示。按右鍵也可以。單選的項目（例如明暗）右邊是打勾，不放圖釘（按右鍵或用「釘選常用指令…」）。
        if (cmd.icon && commandPins) {
          const pins = commandPins;
          if (checked === undefined) {
            const pin = document.createElement("span");
            pin.className = "menu-pin";
            pin.classList.toggle("pinned", pins.pinned(cmd.id));
            pin.title = pins.pinned(cmd.id) ? t("已經釘了：按一下調整（也可以按 →）") : t("釘到檔案面板上方或左側圖示列（也可以按 →）");
            pin.setAttribute("aria-hidden", "true");
            pin.append(icon("pin"));
            item.append(pin);
            item.setAttribute("aria-keyshortcuts", "ArrowRight");
            let sub: HTMLElement | null = null;
            const openPins = (focusFirst: boolean) => {
              clearTimeout(hoverTimer);
              if (!sub) {
                const s = newMenu();
                s.classList.add("submenu", "pin-submenu");
                s.addEventListener("toggle", (e) => {
                  const opened = (e as ToggleEvent).newState === "open";
                  pin.classList.toggle("open", opened);
                  item.classList.toggle("open", opened);
                  if (!opened && s.contains(document.activeElement)) item.focus();
                });
                s.addEventListener("keydown", (e) => {
                  if (navigate(s, e)) e.preventDefault();
                  else if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    s.hidePopover();
                    item.focus();
                  } else return;
                  e.stopPropagation();
                });
                menu.append(s);
                sub = s;
              }
              if (openSub !== sub) closeSub();
              // 每次展開都重建：釘了或移除之後，選項跟著換。
              if (!sub.matches(":popover-open")) {
                sub.replaceChildren();
                fill(sub, pins.entries(cmd.id));
                sub.showPopover();
                position(sub, item.getBoundingClientRect(), "right");
              }
              openSub = sub;
              if (focusFirst) sub.querySelector<HTMLElement>(":scope > button")?.focus();
            };
            pin.addEventListener("click", (e) => {
              // 不要執行指令本身。
              e.preventDefault();
              e.stopPropagation();
              openPins(false);
            });
            pin.addEventListener("pointerenter", () => {
              clearTimeout(hoverTimer);
              hoverTimer = window.setTimeout(() => openPins(false), 200);
            });
            pin.addEventListener("pointerleave", () => clearTimeout(hoverTimer));
            item.addEventListener("keydown", (e) => {
              if (e.key !== "ArrowRight") return;
              e.preventDefault();
              e.stopPropagation();
              openPins(true);
            });
          }
          item.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            root.hidePopover();
            const at = new DOMRect(e.clientX, e.clientY, 0, 0);
            // 右鍵還按著時（Linux 放開前就觸發）：放開後才開，否則放開那一下會把剛開的選單關掉。
            if (e.buttons & 2) window.addEventListener("pointerup", () => setTimeout(() => pins.context(cmd.id, at)), { once: true });
            else pins.context(cmd.id, at);
          });
        }
      } else if ("items" in entry) {
        const sub = newMenu();
        sub.classList.add("submenu");
        fill(sub, entry.items, entry.label);
        const count = sub.querySelectorAll(":scope > button").length;
        if (!count) return [];
        // 只剩一項的子選單不必多點一層：那一項直接放在這一層（用完整的名稱，例如沒開資料夾時的「Git」）。
        if (count === 1) return entry.items.filter((e) => e !== "-").flatMap(build);
        item.role = "menuitem";
        item.setAttribute("aria-haspopup", "menu");
        item.setAttribute("aria-expanded", "false");
        item.classList.add("has-submenu");
        if (entry.icon) item.append(leadIcon(entry.icon));
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
        focusOnHover(item);
        return [item];
      } else {
        if (!(entry.when?.() ?? true)) return [];
        const checked = entry.checked?.();
        item.role = checked === undefined ? "menuitem" : "menuitemradio";
        if (checked !== undefined) item.setAttribute("aria-checked", String(checked));
        if (entry.icon) item.append(leadIcon(entry.icon));
        item.append(Object.assign(document.createElement("span"), { textContent: entry.label }));
        if (checked) item.append(icon("check"));
        item.addEventListener("click", () => {
          root.hidePopover();
          entry.run();
        });
      }
      // 滑鼠移到其他項目時收起已展開的子選單。
      item.addEventListener("pointerenter", closeSub);
      focusOnHover(item);
      return [item];
    };
    const items = list.flatMap(build);
    // 隱藏的項目可能讓分隔線相鄰或出現在頭尾，一併拿掉。
    const isSep = (el: HTMLElement) => el.classList.contains("menu-sep");
    const shown: HTMLElement[] = [];
    for (const el of items) {
      if (isSep(el) && (!shown.length || isSep(shown[shown.length - 1]))) continue;
      shown.push(el);
    }
    if (shown.length && isSep(shown[shown.length - 1])) shown.pop();
    hideRepeatedIcons(shown);
    // 子選單（已經放進 menu）留在最後面。
    menu.prepend(...shown);
  };

  root.addEventListener("beforetoggle", (e) => {
    const opening = (e as ToggleEvent).newState === "open";
    button.setAttribute("aria-expanded", String(opening));
    if (!opening) return;
    root.replaceChildren();
    fill(root, typeof entries === "function" ? entries() : entries);
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
