import { FONT_SIZE_RANGE, type Settings, type SettingsStore } from "../settings.ts";

type ThemePref = "system" | "light" | "dark";

interface Field {
  key: keyof Settings;
  label: string;
  hint?: string;
}

const SECTIONS: { title: string; fields: Field[] }[] = [
  {
    title: "編輯",
    fields: [
      { key: "editorFontSize", label: "編輯區字級" },
      { key: "lineNumbers", label: "顯示行號" },
      { key: "autoPairBrackets", label: "自動補上右括號與引號", hint: "包含全形「」『』（）《》【】" },
      { key: "tableAutoFormat", label: "在表格中按 Tab 時自動對齊", hint: "依中文字寬對齊，原始碼中的直線會對齊" },
    ],
  },
  {
    title: "預覽",
    fields: [
      { key: "previewWidth", label: "文字欄寬" },
      { key: "math", label: "顯示數學公式", hint: "用 $…$ 或 $$…$$ 撰寫，使用 KaTeX" },
      { key: "mermaid", label: "顯示流程圖", hint: "```mermaid 程式碼區塊" },
    ],
  },
];

/**
 * 設定對話框。每個選項改了立即生效、立即儲存，所以不需要「確定」按鈕。
 */
export class SettingsDialog {
  #dialog: HTMLDialogElement;
  #store: SettingsStore;

  constructor(store: SettingsStore, theme: { get(): ThemePref; set(t: ThemePref): void }) {
    this.#store = store;
    const d = document.createElement("dialog");
    d.className = "settings";
    d.setAttribute("aria-labelledby", "settings-title");
    this.#dialog = d;

    const header = document.createElement("header");
    const h = document.createElement("h2");
    h.id = "settings-title";
    h.textContent = "設定";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn";
    close.textContent = "完成";
    close.addEventListener("click", () => d.close());
    header.append(h, close);
    d.append(header);

    const body = document.createElement("div");
    body.className = "settings-body";
    d.append(body);

    // 外觀：主題沿用標題列主題選單的同一份狀態。
    const look = this.#section("外觀");
    look.append(
      this.#row("theme", "主題", undefined, () => {
        const sel = document.createElement("select");
        sel.id = "setting-theme";
        for (const [v, l] of [
          ["system", "跟隨系統"],
          ["light", "淺色"],
          ["dark", "深色"],
        ] as const) {
          sel.append(new Option(l, v, false, theme.get() === v));
        }
        sel.addEventListener("change", () => theme.set(sel.value as ThemePref));
        d.addEventListener("toggle", () => (sel.value = theme.get()));
        return sel;
      }),
    );
    body.append(look);

    for (const section of SECTIONS) {
      const el = this.#section(section.title);
      for (const f of section.fields) el.append(this.#row(f.key, f.label, f.hint, () => this.#control(f.key)));
      body.append(el);
    }

    const advanced = this.#section("進階");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn";
    reset.textContent = "恢復預設值";
    reset.addEventListener("click", () => {
      store.reset();
      this.#sync();
    });
    advanced.append(this.#row("reset", "所有設定", "主題、版面配置不受影響", () => reset));
    const ai = document.createElement("p");
    ai.className = "settings-note";
    ai.textContent = "AI 協作（Claude Code／Codex）會在之後的版本加入，屆時可在這裡開啟；預設為關閉。";
    advanced.append(ai);
    body.append(advanced);

    d.addEventListener("click", (e) => {
      if (e.target === d) d.close();
    });
    document.body.append(d);
    store.subscribe(() => this.#sync());
  }

  open(): void {
    this.#sync();
    this.#dialog.showModal();
  }

  #section(title: string): HTMLElement {
    const s = document.createElement("section");
    const h = document.createElement("h3");
    h.textContent = title;
    s.append(h);
    return s;
  }

  #row(id: string, label: string, hint: string | undefined, control: () => HTMLElement): HTMLElement {
    const row = document.createElement("div");
    row.className = "settings-row";
    const text = document.createElement("div");
    const l = document.createElement("label");
    l.htmlFor = `setting-${id}`;
    l.textContent = label;
    text.append(l);
    if (hint) {
      const h = document.createElement("small");
      h.textContent = hint;
      text.append(h);
    }
    const c = control();
    if (!c.id) c.id = `setting-${id}`;
    row.append(text, c);
    return row;
  }

  #control(key: keyof Settings): HTMLElement {
    const value = this.#store.value[key];
    if (typeof value === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.role = "switch";
      input.className = "switch";
      input.dataset.key = key;
      input.addEventListener("change", () => this.#store.update({ [key]: input.checked }));
      return input;
    }
    if (key === "editorFontSize") {
      const input = document.createElement("input");
      input.type = "number";
      input.min = String(FONT_SIZE_RANGE.min);
      input.max = String(FONT_SIZE_RANGE.max);
      input.step = "1";
      input.dataset.key = key;
      input.addEventListener("change", () => this.#store.update({ editorFontSize: Number(input.value) }));
      return input;
    }
    const sel = document.createElement("select");
    sel.dataset.key = key;
    for (const [v, l] of [
      ["narrow", "窄"],
      ["medium", "中"],
      ["wide", "寬"],
    ]) {
      sel.append(new Option(l, v));
    }
    sel.addEventListener("change", () => this.#store.update({ previewWidth: sel.value as Settings["previewWidth"] }));
    return sel;
  }

  /** 讓畫面上的控制項反映目前的設定值。 */
  #sync(): void {
    const v = this.#store.value;
    for (const el of this.#dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]")) {
      const value = v[el.dataset.key as keyof Settings];
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = value as boolean;
      else el.value = String(value);
    }
  }
}
