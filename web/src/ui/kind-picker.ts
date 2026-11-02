/**
 * 狀態列的文件類型（Markdown／純文字／JSON）：按一下開選單，勾選目前的類型。
 *
 * 不用原生的 `<select>`：Windows 上它的下拉清單由瀏覽器核心決定往上或往下開，
 * 視窗最大化時可能往下開到螢幕外面，選不到。改用 oMarker 自己的選單：位置一律留在視窗內
 * （狀態列在最下面，所以會往上開），也和其他選單長得一樣。
 *
 * 對外和原本的 `<select>` 一樣用 `value` 讀寫、選了以後發出 `change` 事件，呼叫的地方不必改。
 */
import { type DocKind, KINDS } from "../kinds.ts";
import { icon } from "./icons.ts";
import { setupMenu } from "./menu.ts";

export class KindPicker extends EventTarget {
  #button: HTMLButtonElement;
  #label: HTMLElement;
  #value: DocKind = "markdown";

  constructor(button: HTMLButtonElement) {
    super();
    this.#button = button;
    this.#label = document.createElement("span");
    button.replaceChildren(this.#label, icon("chevron-down"));
    setupMenu(
      button,
      null,
      (Object.keys(KINDS) as DocKind[]).map((kind) => ({
        label: KINDS[kind].label,
        checked: () => this.#value === kind,
        run: () => {
          if (kind === this.#value) return;
          this.value = kind;
          this.dispatchEvent(new Event("change"));
        },
      })),
    );
    this.value = this.#value;
  }

  get value(): DocKind {
    return this.#value;
  }

  /** 換顯示的類型（不發出 `change`：和設定 `<select>` 的 value 一樣）。 */
  set value(kind: DocKind) {
    this.#value = kind in KINDS ? kind : "markdown";
    this.#label.textContent = KINDS[this.#value].label;
    this.#button.dataset.kind = this.#value;
  }
}
