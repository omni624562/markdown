/**
 * 下拉選單（`<select>`）的清單改用 oMarker 自己的選單。
 *
 * Windows 上原生的清單由瀏覽器核心決定往上或往下開：視窗在螢幕下半部、或最大化時，常常開到螢幕外面，
 * 被工作列切掉，下面的項目選不到（狀態列的文件類型也是這個原因改掉的，見 kind-picker.ts）。
 * 自己的選單一律留在視窗內：下方放不下就往上開，還是太高時可以捲動；也和其他選單長得一樣。
 *
 * `<select>` 本身照舊：值、`change` 事件、焦點在上面時按方向鍵直接換選項都不變，
 * 只是用滑鼠按下去（或按 Alt+↓、F4、空白鍵）時開的是這個選單。載入這個模組就套用到所有的 `<select>`。
 */
import { containWheel } from "./contain-wheel.ts";
import { icon } from "./icons.ts";
import { placeMenu } from "./menu-place.ts";

/** 開著的選單，和打開時下拉選單的位置（後面的頁面捲動、下拉選單移走了就關掉選單）。 */
let current: { select: HTMLSelectElement; menu: HTMLElement; at: DOMRect } | null = null;
/** 按下去的下拉選單，以及那時選單是不是開著（開著時按下拉選單本身是關掉選單）。 */
let pressed: { select: HTMLSelectElement; wasOpen: boolean } | null = null;

/** 用單一清單的下拉選單（不是多選、也不是直接攤開的清單）。 */
function isDropdown(el: unknown): el is HTMLSelectElement {
  return el instanceof HTMLSelectElement && !el.multiple && el.size <= 1;
}

/** 選項的值與名稱（比對選單開著時選項有沒有換）。 */
function optionsKey(select: HTMLSelectElement): string {
  return JSON.stringify([...select.options].map((o) => [o.value, o.label || o.text, o.disabled, o.hidden]));
}

function choose(select: HTMLSelectElement, opt: HTMLOptionElement): void {
  closeSelect();
  select.focus({ preventScroll: true });
  // 選項在選單開著時換過（例如清單剛讀到）：照值找，找不到就不改。
  const target = opt.closest("select") === select ? opt : [...select.options].find((o) => o.value === opt.value);
  if (!target || target.selected || target.disabled) return;
  target.selected = true;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

export function closeSelect(): void {
  if (current?.menu.matches(":popover-open")) current.menu.hidePopover();
}

/** 打開 `select` 的選單（和按下去一樣）。停用的下拉選單不會打開。 */
export function openSelect(select: HTMLSelectElement): void {
  if (!isDropdown(select) || select.disabled) return;
  closeSelect();
  const menu = document.createElement("div");
  menu.className = "menu select-menu";
  menu.popover = "auto";
  menu.role = "listbox";
  containWheel(menu);
  // 名稱：aria-label，或包著下拉選單的 <label> 自己的文字（不含選項的文字）。
  const own = [...(select.labels?.[0]?.childNodes ?? [])].filter((n) => n.nodeType === Node.TEXT_NODE);
  const label = select.getAttribute("aria-label") ?? own.map((n) => n.textContent).join("").trim();
  if (label) menu.setAttribute("aria-label", label);

  const option = (opt: HTMLOptionElement) => {
    if (opt.hidden) return;
    const item = document.createElement("button");
    item.type = "button";
    item.role = "option";
    item.disabled = opt.disabled;
    item.setAttribute("aria-selected", String(opt.selected));
    item.append(Object.assign(document.createElement("span"), { textContent: opt.label || opt.text }));
    if (opt.selected) item.append(icon("check"));
    item.addEventListener("click", () => choose(select, opt));
    // 焦點跟著滑鼠（和其他選單一樣，畫面上只會有一項反白）。
    item.addEventListener("pointermove", () => {
      if (document.activeElement !== item && !item.disabled) item.focus({ preventScroll: true });
    });
    menu.append(item);
  };
  for (const child of select.children) {
    if (child instanceof HTMLOptGroupElement) {
      const head = document.createElement("div");
      head.className = "menu-head";
      head.role = "presentation";
      head.textContent = child.label;
      menu.append(head);
      for (const opt of child.children) if (opt instanceof HTMLOptionElement) option(opt);
    } else if (child instanceof HTMLOptionElement) option(child);
  }
  if (!menu.querySelector("button")) return;

  const items = () => [...menu.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)")];
  let typed = "";
  let typedAt = 0;
  menu.addEventListener("keydown", (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === "ArrowDown") next = list[Math.min(i + 1, list.length - 1)];
    else if (e.key === "ArrowUp") next = list[Math.max(i - 1, 0)];
    else if (e.key === "Home") next = list[0];
    else if (e.key === "End") next = list[list.length - 1];
    else if (e.key === "PageDown") next = list[Math.min(i + 10, list.length - 1)];
    else if (e.key === "PageUp") next = list[Math.max(i - 10, 0)];
    else if (e.key === "Tab") {
      closeSelect();
      return;
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key !== " ") {
      // 打字跳到開頭相符的項目（和原生的下拉選單一樣）。
      typed = e.timeStamp - typedAt < 800 ? typed + e.key.toLowerCase() : e.key.toLowerCase();
      typedAt = e.timeStamp;
      const from = typed.length === 1 ? i + 1 : i;
      const order = [...list.slice(from), ...list.slice(0, from)];
      next = order.find((b) => b.textContent?.trim().toLowerCase().startsWith(typed));
    } else return;
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  });
  // 選項換了、下拉選單停用了：關掉選單（列的已經不是現在的選項）。重畫成一樣的選項不算。
  const listed = optionsKey(select);
  const watch = new MutationObserver(() => {
    if (select.disabled || optionsKey(select) !== listed) closeSelect();
  });
  watch.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });
  menu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "closed") return;
    watch.disconnect();
    if (menu.contains(document.activeElement)) select.focus({ preventScroll: true });
    menu.remove();
    if (current?.menu === menu) current = null;
  });

  // 對話框（showModal）外面的元素不能操作：選單放在對話框裡面。
  (select.closest("dialog") ?? document.body).append(menu);
  const anchor = select.getBoundingClientRect();
  current = { select, menu, at: anchor };
  menu.style.minWidth = `${Math.round(anchor.width)}px`;
  menu.showPopover();
  const { width, height } = menu.getBoundingClientRect();
  const p = placeMenu(anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight }, "below");
  Object.assign(menu.style, { left: `${p.left}px`, top: `${p.top}px`, maxHeight: `${p.maxHeight}px` });
  const selected = menu.querySelector<HTMLButtonElement>(":scope > button[aria-selected=true]:not(:disabled)") ?? items()[0];
  selected?.focus({ preventScroll: true });
  // 目前選的捲到中間（只捲選單本身，不動後面的頁面）。
  if (selected) menu.scrollTop = selected.offsetTop - (menu.clientHeight - selected.offsetHeight) / 2;
}

if (typeof document !== "undefined") {
  const selectOf = (e: Event) => (e.target instanceof Element ? e.target.closest("select") : null);
  // 按下去時擋掉原生的清單，放開（click）時才打開：在按下去時打開的話，放開那一下會被當成點在選單外面而關掉。
  document.addEventListener(
    "mousedown",
    (e) => {
      const select = selectOf(e);
      pressed = null;
      if (!isDropdown(select) || e.button !== 0) return;
      e.preventDefault();
      if (select.disabled) return;
      pressed = { select, wasOpen: current?.select === select };
      select.focus();
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      const select = selectOf(e);
      // 只有在下拉選單上按下去、放開的才算（點 <label> 的文字只是移動焦點，和原生的一樣）。
      if (!pressed || pressed.select !== select) return;
      const { wasOpen } = pressed;
      pressed = null;
      if (wasOpen) closeSelect();
      else openSelect(select);
    },
    true,
  );
  // 後面的頁面捲動、視窗改變大小：和原生的一樣關掉選單（選單不會跟著移動）。選單自己捲動、下拉選單沒有移動的不算。
  document.addEventListener(
    "scroll",
    (e) => {
      if (!current || e.target === current.menu) return;
      const r = current.select.getBoundingClientRect();
      if (Math.abs(r.top - current.at.top) > 1 || Math.abs(r.left - current.at.left) > 1) closeSelect();
    },
    true,
  );
  window.addEventListener("resize", closeSelect);
  document.addEventListener(
    "keydown",
    (e) => {
      if (!isDropdown(e.target) || e.target.disabled) return;
      const open = (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) || e.key === "F4" || (e.key === " " && !e.ctrlKey);
      if (!open) return;
      e.preventDefault();
      openSelect(e.target);
    },
    true,
  );
}
