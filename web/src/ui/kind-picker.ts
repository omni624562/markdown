/**
 * 狀態列的文件類型與語言：Markdown、純文字、JSON，以及純文字用哪個語言上色（YAML、Python…）。
 * 按鈕上顯示語言（例如 .yaml 檔顯示「YAML」）。按一下開選單：「自動（依副檔名）」、文件、資料與設定、
 * 最近用過的語言，最後是「更多語言…」（可以打字找的清單，列出所有能上色的語言）。
 *
 * 不用原生的 `<select>`：Windows 上它的下拉清單由瀏覽器核心決定往上或往下開，
 * 視窗最大化時可能往下開到螢幕外面，選不到。改用 oMarker 自己的選單：位置一律留在視窗內
 * （狀態列在最下面，所以會往上開），也和其他選單長得一樣。
 *
 * 對外和原本的 `<select>` 一樣用 `value` 讀寫文件類型、選了以後發出 `change` 事件。選了語言時發出
 * `language` 事件（`detail`：語言名稱；`""` 是純文字不上色；`null` 是改回依副檔名），由 app/doc-language.ts 處理。
 */
import { languages } from "@codemirror/language-data";
import { t } from "../i18n.ts";
import { type DocKind, KINDS } from "../kinds.ts";
import * as storage from "../storage.ts";
import { icon } from "./icons.ts";
import { type MenuEntry, setupMenu } from "./menu.ts";
import { Picker } from "./picker.ts";

/** 「資料與設定」一區直接列出的語言（JSON 是另一種文件類型，排在最前面）。 */
const DATA_LANGUAGES = ["YAML", "XML", "TOML", "Properties files"];
const RECENT_KEY = "recent-languages";
const RECENT_LIMIT = 3;

/** 語言在介面上的名稱（@codemirror/language-data 的名稱有幾個不好懂）。 */
export function languageLabel(name: string): string {
  if (name === "Properties files") return t("INI／Properties");
  if (name === "diff") return "Diff";
  return name;
}

function recentLanguages(): string[] {
  try {
    const list = JSON.parse(storage.load(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string" && languages.some((l) => l.name === n)) : [];
  } catch {
    return [];
  }
}

function rememberLanguage(name: string): void {
  if (!name) return;
  storage.save(RECENT_KEY, JSON.stringify([name, ...recentLanguages().filter((n) => n !== name)].slice(0, RECENT_LIMIT)));
}

/** 「更多語言…」清單的排序：名稱開頭符合的在前，再來是名稱或副檔名裡有。 */
export function matchLanguages(query: string): (typeof languages)[number][] {
  const q = query.trim().toLowerCase().replace(/^\./, "");
  const all = [...languages].sort((a, b) => a.name.localeCompare(b.name));
  if (!q) return all;
  const score = (l: (typeof languages)[number]) => {
    const name = l.name.toLowerCase();
    if (name === q || l.extensions.includes(q)) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q) || l.alias.some((a) => a.toLowerCase().includes(q)) || l.extensions.some((e) => e.startsWith(q))) return 2;
    return -1;
  };
  return all
    .map((l) => ({ l, s: score(l) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.l);
}

export class KindPicker extends EventTarget {
  #button: HTMLButtonElement;
  #label: HTMLElement;
  #value: DocKind = "markdown";
  /** 純文字目前用哪個語言上色（依副檔名或使用者選的）。 */
  #language: string | null = null;
  /** 使用者自己選了語言（不是依副檔名）。 */
  #chosen = false;
  #more: Picker<(typeof languages)[number]> | null = null;

  constructor(button: HTMLButtonElement) {
    super();
    this.#button = button;
    this.#label = document.createElement("span");
    button.replaceChildren(this.#label, icon("chevron-down"));
    setupMenu(button, null, () => this.#entries());
    this.value = this.#value;
  }

  #entries(): MenuEntry[] {
    const text = this.#value === "text";
    const language = (name: string): MenuEntry => ({
      label: languageLabel(name),
      checked: () => text && this.#language === name,
      run: () => this.#pickLanguage(name),
    });
    const recent = recentLanguages().filter((n) => !DATA_LANGUAGES.includes(n));
    return [
      { label: t("自動（依副檔名）"), when: () => this.#chosen, run: () => this.#pickLanguage(null) },
      { heading: t("文件") },
      { label: "Markdown", checked: () => this.#value === "markdown", run: () => this.#pickKind("markdown") },
      { label: t("純文字"), checked: () => text && !this.#language, run: () => this.#pickLanguage("") },
      { heading: t("資料與設定") },
      { label: "JSON", checked: () => this.#value === "json", run: () => this.#pickKind("json") },
      ...DATA_LANGUAGES.map(language),
      ...(recent.length ? [{ heading: t("最近用過") }, ...recent.map(language)] : []),
      "-",
      { label: t("更多語言…"), icon: "search", run: () => this.#openMore() },
    ];
  }

  #pickKind(kind: DocKind): void {
    if (kind === this.#value) return;
    this.value = kind;
    this.dispatchEvent(new Event("change"));
  }

  /** 純文字用這個語言上色（`""` 不上色、`null` 依副檔名）。 */
  #pickLanguage(name: string | null): void {
    if (name) rememberLanguage(name);
    this.dispatchEvent(new CustomEvent<string | null>("language", { detail: name }));
  }

  #openMore(): void {
    this.#more ??= new Picker({
      label: t("選擇語言"),
      placeholder: t("選擇語言：輸入名稱或副檔名（例如 py、sql）"),
      empty: t("找不到符合的語言"),
      query: (q) => matchLanguages(q),
      render: (l) => ({ title: languageLabel(l.name), detail: l.extensions.slice(0, 4).map((e) => `.${e}`).join(" ") }),
      pick: (l) => this.#pickLanguage(l.name),
    });
    this.#more.open();
  }

  get value(): DocKind {
    return this.#value;
  }

  /** 換顯示的類型（不發出 `change`：和設定 `<select>` 的 value 一樣）。 */
  set value(kind: DocKind) {
    this.#value = kind in KINDS ? kind : "markdown";
    this.#render();
  }

  /** 純文字目前用哪個語言上色、是不是使用者自己選的（app/doc-language.ts 在換文件、換語言時設定）。 */
  setLanguage(name: string | null, chosen: boolean): void {
    this.#language = name;
    this.#chosen = chosen;
    this.#render();
  }

  #render(): void {
    const label = this.#value === "text" && this.#language ? languageLabel(this.#language) : KINDS[this.#value].label;
    if (this.#label.textContent !== label) this.#label.textContent = label;
    this.#button.dataset.kind = this.#value;
  }
}
