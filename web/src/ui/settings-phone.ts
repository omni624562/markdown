/**
 * 手機版面（`body.phone`）的設定：像 Android 的設定 App 一樣分兩層。
 *
 * - 第一層：分類清單，一行一個，下面一行小字列出裡面有哪些選項；上方有搜尋。
 * - 第二層：點進分類後只顯示那一頁，左上角「←」回到分類清單。
 * - Android 的返回鍵（瀏覽器的上一頁）也是一層一層退：頁面 → 分類清單 → 關閉設定。
 *
 * 手機用不到的選項（分頁樣式、大綱放在右邊、快速鍵…）加上 `phone-hide`，只在手機版面藏起來。
 * 螢幕寬的時候（電腦、平板）什麼都不改。
 */
import { t } from "../i18n.ts";

export const isPhone = (): boolean => document.body.classList.contains("phone");

/** 手機版面看不到的選項列（`#row` 的 id）：手機沒有分頁列、側邊欄、圖示列、快速鍵。 */
export const PHONE_HIDDEN_ROWS = new Set(["previewWidth", "tabStyle", "panelStyle", "fixedToolbar", "outlineRight", "viewSwitchLabels", "activity", "shortcuts"]);

type View = "list" | "page" | "search";

export interface PhoneSettingsParts {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  back: HTMLButtonElement;
  search: HTMLInputElement;
  tabs: HTMLButtonElement[];
  sections: HTMLElement[];
  /** 選項列看得到（沒有依狀態藏、沒被搜尋篩掉、手機也顯示）。 */
  shown: (row: HTMLElement) => boolean;
}

export class PhoneSettings {
  #p: PhoneSettingsParts;
  /** 開著設定時，加進瀏覽紀錄的層數（1：設定、2：設定裡的某一頁），返回鍵一層一層退。 */
  #depth = 0;

  constructor(p: PhoneSettingsParts) {
    this.#p = p;
    p.back.addEventListener("click", () => (this.#view() === "list" ? p.dialog.close() : this.#leave()));
    p.search.addEventListener("input", () => {
      if (!isPhone()) return;
      if (p.search.value.trim()) this.#set("search");
      else if (this.#view() === "search") this.#set("list");
    });
    p.dialog.addEventListener("close", () => {
      delete p.dialog.dataset.phoneView;
      p.title.textContent = t("設定");
      const n = this.#depth;
      this.#depth = 0;
      if (n) history.go(-n);
    });
    window.addEventListener("popstate", () => {
      if (!p.dialog.open || !this.#depth) return;
      const depth = history.state?.settingsPage ? 2 : history.state?.settings ? 1 : 0;
      this.#depth = depth;
      if (depth === 0) p.dialog.close();
      else if (depth === 1 && this.#view() !== "list") this.#clearToList();
    });
  }

  /** 開啟設定時先顯示分類清單。 */
  opened(): void {
    if (!isPhone()) return;
    this.#push(1);
    // 指定了分類時，`open()` 接著會點那個分類（`entered()`）。
    this.#set("list");
  }

  /** 點了某個分類（或 `open(page)`）：進到那一頁。 */
  entered(): void {
    if (!isPhone() || !this.#p.dialog.open) return;
    this.#set("page");
    this.#push(2);
  }

  #view(): View {
    return (this.#p.dialog.dataset.phoneView as View | undefined) ?? "list";
  }

  #set(view: View): void {
    const p = this.#p;
    p.dialog.dataset.phoneView = view;
    const i = p.tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    p.title.textContent = view === "page" && i >= 0 ? (p.sections[i].querySelector("h3")?.textContent ?? t("設定")) : t("設定");
    p.back.title = view === "list" ? t("關閉設定") : t("回到設定分類");
    p.back.setAttribute("aria-label", p.back.title);
    if (view === "list") this.#describe();
    p.dialog.querySelector(".settings-body")?.scrollTo?.(0, 0);
  }

  /** 「←」：回到分類清單（瀏覽紀錄也退一層，返回鍵才不會多按一次）。 */
  #leave(): void {
    if (this.#depth === 2) history.back();
    else this.#clearToList();
  }

  #clearToList(): void {
    const s = this.#p.search;
    if (s.value) {
      s.value = "";
      s.dispatchEvent(new Event("input"));
    }
    this.#set("list");
  }

  #push(depth: 1 | 2): void {
    while (this.#depth < depth) {
      this.#depth++;
      history.pushState({ ...history.state, settings: true, settingsPage: this.#depth === 2 }, "");
    }
  }

  /** 分類下面的小字：列出那一頁手機看得到的前幾個選項；一個都沒有的分類整個藏起來。 */
  #describe(): void {
    const { tabs, sections, shown } = this.#p;
    tabs.forEach((tab, i) => {
      const labels = [...sections[i].querySelectorAll<HTMLElement>(".settings-row")]
        .filter((r) => shown(r) && !r.classList.contains("phone-hide"))
        .map((r) => r.querySelector("label")?.textContent?.trim() ?? "")
        .filter(Boolean);
      tab.classList.toggle("phone-empty", labels.length === 0);
      let desc = tab.querySelector<HTMLElement>(".settings-tab-desc");
      if (!desc) {
        desc = document.createElement("small");
        desc.className = "settings-tab-desc";
        tab.append(desc);
      }
      desc.textContent = labels.slice(0, 3).join(t("、")) + (labels.length > 3 ? "…" : "");
    });
  }
}
