/**
 * 只列常用項目的下拉選單（Wiki、工作板的專案）：旁邊的星號按鈕勾選常用的；
 * 有常用時選單只列常用的，最下面「顯示全部（N）」暫時列出全部，再選「只顯示常用」回來。
 */
import { type Choice, SHOW_ALL, SHOW_FAVORITES, favoriteOptions } from "../favorites.ts";
import { t } from "../i18n.ts";
import { icon } from "./icons.ts";
import { MultiSelect } from "./multi-select.ts";

export interface FavoriteSelectOptions {
  /** 選單的名稱（例如「Wiki」「專案」）。 */
  label: string;
  /** 星號選單最上面的說明（例如「常用的 Wiki（選單只列這些）」）。 */
  caption: string;
  load(): string[];
  save(values: string[]): void;
  /** 選了別的項目（不含「顯示全部」這類切換）。 */
  onChange(value: string): void;
}

export class FavoriteSelect {
  readonly select: HTMLSelectElement;
  readonly star: HTMLButtonElement;
  #o: FavoriteSelectOptions;
  #picker: MultiSelect;
  #items: Choice[] = [];
  #showAll = false;
  /** 目前選的值（選了「顯示全部」時，選單要回到這個）。 */
  #value = "";

  constructor(o: FavoriteSelectOptions) {
    this.#o = o;
    this.select = document.createElement("select");
    this.select.className = "workitems-select";
    this.select.setAttribute("aria-label", o.label);
    this.select.addEventListener("change", () => {
      const v = this.select.value;
      if (v === SHOW_ALL || v === SHOW_FAVORITES) {
        this.#showAll = v === SHOW_ALL;
        this.#render();
        // 換了清單之後直接打開，接著選。
        try {
          this.select.showPicker();
        } catch {
          // 不支援 showPicker 的環境：使用者再點一次就好。
        }
        return;
      }
      this.#value = v;
      o.onChange(v);
    });
    this.star = document.createElement("button");
    this.star.type = "button";
    this.star.className = "workitems-filter-toggle favorite-toggle";
    this.star.append(icon("star"));
    this.#picker = new MultiSelect({
      label: o.caption,
      all: "",
      button: this.star,
      caption: o.caption,
      onChange: (values) => {
        // 全部勾起來等於沒有設常用。
        o.save(values.length >= this.#items.length ? [] : values);
        this.#showAll = false;
        this.#render();
      },
    });
    this.#updateStar();
  }

  get value(): string {
    return this.#value;
  }

  set value(v: string) {
    this.#value = v;
    this.#render();
  }

  set hidden(v: boolean) {
    this.select.hidden = v;
    this.star.hidden = v;
  }

  /** 換一份清單（`value` 是要選的）。 */
  setItems(items: Choice[], value: string): void {
    this.#items = items;
    this.#value = value;
    this.#picker.setOptions(items);
    this.#render();
  }

  #render(): void {
    const favorites = this.#o.load();
    const o = favoriteOptions(this.#items, favorites, this.#showAll, this.#value);
    const options = o.items.map(([v, label]) => new Option(label, v));
    if (o.toggle) {
      const line = new Option("──────────", "");
      line.disabled = true;
      options.push(
        line,
        o.toggle === "all" ? new Option(t("顯示全部（{n}）", { n: o.total }), SHOW_ALL) : new Option(t("只顯示常用"), SHOW_FAVORITES),
      );
    }
    this.select.replaceChildren(...options);
    this.select.value = this.#value;
    this.#picker.value = favorites.filter((f) => this.#items.some(([v]) => v === f));
    this.#updateStar();
  }

  #updateStar(): void {
    const n = this.#o.load().filter((f) => this.#items.some(([v]) => v === f)).length;
    this.star.classList.toggle("active", n > 0);
    const label = n ? t("常用的{label}：{n} 個（按一下修改）", { label: this.#o.label, n }) : t("設定常用的{label}（選單只列常用的）", { label: this.#o.label });
    this.star.title = label;
    this.star.setAttribute("aria-label", label);
  }
}
