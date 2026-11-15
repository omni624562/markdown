/**
 * 拖動把手（⠿）的說明：把手只有滑鼠移到段落上才出現，不知道的人不會發現可以拖。把手前幾次出現時，
 * 旁邊顯示一個小說明「拖這裡可以調整順序」；看過幾次、或實際拖過一次之後就不再出現。
 * 說明不擋滑鼠，把手消失、開始拖曳時跟著消失。
 */
import { t } from "../i18n.ts";
import * as storage from "../storage.ts";

const KEY = "drag-hint-shown";
/** 最多出現幾次。 */
const TIMES = 3;
/** 把手出現後停多久才顯示（滑鼠只是經過時不要閃一下）。 */
const DELAY = 500;
/** 一次最多顯示多久。 */
const STAY = 6000;

let bubble: HTMLElement | null = null;
let owner: HTMLElement | null = null;
let showTimer = 0;
let hideTimer = 0;

const shown = (): number => Number(storage.load(KEY) ?? 0) || 0;

function hide(): void {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  owner = null;
  if (bubble) bubble.hidden = true;
}

function show(handle: HTMLElement): void {
  if (handle.hidden || !handle.getClientRects().length) return;
  bubble ??= Object.assign(document.createElement("div"), { className: "drag-hint", textContent: t("拖這裡可以調整順序") });
  bubble.setAttribute("role", "tooltip");
  if (!bubble.isConnected) document.body.append(bubble);
  const r = handle.getBoundingClientRect();
  bubble.hidden = false;
  // 放在把手的正上方；太靠近視窗上緣時放下面。
  const h = bubble.offsetHeight;
  const top = r.top - h - 6 >= 4 ? r.top - h - 6 : r.bottom + 6;
  bubble.style.top = `${top}px`;
  bubble.style.left = `${Math.max(4, r.left)}px`;
  storage.save(KEY, String(shown() + 1));
  hideTimer = window.setTimeout(hide, STAY);
}

/**
 * 讓 `handle`（預覽或即時預覽的拖動把手）帶著說明：每次它出現（`hidden` 拿掉）時呼叫 `dragHintFor`，
 * 這裡負責什麼時候顯示、什麼時候收起來。
 */
export function watchDragHandle(handle: HTMLElement): void {
  new MutationObserver(() => {
    if (handle.hidden) {
      if (owner === handle) hide();
      return;
    }
    if (owner === handle) {
      // 把手移到別的段落：說明先收起來，停下來再顯示。
      if (bubble && !bubble.hidden) bubble.hidden = true;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    }
    if (shown() >= TIMES) return;
    owner = handle;
    clearTimeout(showTimer);
    showTimer = window.setTimeout(() => owner === handle && show(handle), DELAY);
  }).observe(handle, { attributes: true, attributeFilter: ["hidden", "style"] });
  // 實際拖過了：已經會用，不用再說明。
  handle.addEventListener("dragstart", () => {
    storage.save(KEY, String(TIMES));
    hide();
  });
}
