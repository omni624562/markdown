import {
  FONT_SIZE_RANGE,
  QUICK_ACTION_LIMITS,
  type QuickAction,
  type Settings,
  type SettingsStore,
} from "../settings.ts";
import { icon } from "./icons.ts";
import { toast } from "./toast.ts";

type ThemePref = "system" | "light" | "dark";

/** 桌面版提供：偵測已安裝的 AI 工具、取得手動註冊 MCP 伺服器的指令。 */
export interface AiHooks {
  available(): Promise<{ claude: string | null; codex: string | null }>;
  registration(): Promise<{ claudeAdd: string; codexAdd: string }>;
}

const SELECT_OPTIONS: Partial<Record<keyof Settings, [string, string][]>> = {
  previewWidth: [
    ["narrow", "窄"],
    ["medium", "中"],
    ["wide", "寬"],
  ],
  aiTool: [
    ["claude", "Claude Code"],
    ["codex", "Codex"],
  ],
  gitSyncMinutes: [
    ["5", "每 5 分鐘"],
    ["10", "每 10 分鐘"],
    ["30", "每 30 分鐘"],
    ["60", "每小時"],
  ],
};

/** 桌面版提供：目前版本與手動檢查更新。 */
export interface UpdateHooks {
  version(): Promise<string>;
  check(): void;
}

/** AI 區中，總開關關閉時一起停用的選項。 */
const AI_DEPENDENT: (keyof Settings)[] = ["aiTool", "mcpServer", "aiTerminal", "markExternalChanges"];

interface Field {
  key: keyof Settings;
  label: string;
  hint?: string;
}

/** 「外觀」頁中，主題下面的選項。 */
const LOOK_FIELDS: Field[] = [
  { key: "previewWidth", label: "預覽的文字欄寬" },
  { key: "fixedToolbar", label: "固定顯示格式工具列", hint: "在編輯區上方一直顯示粗體、清單等按鈕；關閉時選取文字才會浮出格式按鈕" },
  { key: "math", label: "顯示數學公式", hint: "用 $…$ 或 $$…$$ 撰寫，使用 KaTeX" },
  { key: "mermaid", label: "顯示流程圖", hint: "```mermaid 程式碼區塊" },
];

const SECTIONS: { title: string; fields: Field[] }[] = [
  {
    title: "編輯",
    fields: [
      { key: "editorFontSize", label: "編輯區字級", hint: "也可以按 Ctrl+= 或 Ctrl+- 調整" },
      { key: "lineNumbers", label: "顯示行號" },
      { key: "autoPairBrackets", label: "自動補上右括號與引號", hint: "包含全形「」『』（）《》【】" },
      { key: "tableAutoFormat", label: "在表格中按 Tab 時自動對齊", hint: "依中文字寬對齊，原始碼中的直線會對齊" },
      {
        key: "smartPaste",
        label: "貼上網頁、Google 文件、Word 時轉成 Markdown",
        hint: "保留標題、清單、粗體、連結和表格；按 Ctrl+Shift+V 一律貼純文字",
      },
      {
        key: "autoSave",
        label: "自動存檔",
        hint: "桌面版：已經存過的檔案，停止打字一秒多後自動存回磁碟；檔案被其他程式改過時照樣先讓你比較差異",
      },
      {
        key: "autoSymbols",
        label: "打字自動轉符號",
        hint: "<= 變 ≤、>= 變 ≥、!= 變 ≠、-> 變 →、=> 變 ⇒、+- 變 ±；程式碼與公式裡不轉換，轉換後馬上按 Backspace 可以還原",
      },
      {
        key: "termCheck",
        label: "檢查兩國用語與錯字",
        hint: "中國用語（視頻、默認、軟件…）與常見錯字畫上波浪底線，滑鼠移上去可以換成台灣的說法；「⋯」→「修正兩國用語與錯字」一次修正整份文件；選過「不再提示」的詞可以在指令面板清除",
      },
      {
        key: "imageCompress",
        label: "貼上大圖片時自動壓縮",
        hint: "寬或高超過 2000 像素的圖片縮小到 2000 像素，很大的照片改存成 JPEG，NAS 上的檔案不會越來越大",
      },
      { key: "focusMode", label: "專注模式", hint: "淡化目前段落以外的文字" },
      { key: "typewriterMode", label: "打字機模式", hint: "游標所在的行保持在畫面中央" },
    ],
  },
];

/**
 * 設定對話框。每個選項改了立即生效、立即儲存，所以不需要「確定」按鈕。
 */
export class SettingsDialog {
  #dialog: HTMLDialogElement;
  #store: SettingsStore;

  #ai: AiHooks | null;
  #actions!: HTMLElement;
  #page = 0;

  constructor(
    store: SettingsStore,
    theme: { get(): ThemePref; set(t: ThemePref): void },
    ai: AiHooks | null = null,
    update: UpdateHooks | null = null,
  ) {
    this.#ai = ai;
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

    // 左邊是分類，右邊一次只顯示一個分類的選項。
    const layout = document.createElement("div");
    layout.className = "settings-layout";
    const nav = document.createElement("div");
    nav.className = "settings-nav";
    nav.role = "tablist";
    nav.setAttribute("aria-label", "設定分類");
    nav.setAttribute("aria-orientation", "vertical");
    const body = document.createElement("div");
    body.className = "settings-body";
    layout.append(nav, body);
    d.append(layout);

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
    for (const f of LOOK_FIELDS) look.append(this.#row(f.key, f.label, f.hint, () => this.#control(f.key)));
    body.append(look);

    for (const section of SECTIONS) {
      const el = this.#section(section.title);
      for (const f of section.fields) el.append(this.#row(f.key, f.label, f.hint, () => this.#control(f.key)));
      body.append(el);
    }

    body.append(this.#aiSection());
    if (ai) {
      const git = this.#section("Git");
      git.append(
        this.#row("gitAutoSync", "自動同步", "開啟的資料夾是 Git 儲存庫時，定時提交、拉取、推送；遇到衝突會暫停", () =>
          this.#control("gitAutoSync"),
        ),
        this.#row("gitSyncMinutes", "同步頻率", undefined, () => this.#control("gitSyncMinutes")),
      );
      body.append(git);
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
    if (update) {
      const checkBtn = document.createElement("button");
      checkBtn.type = "button";
      checkBtn.className = "btn";
      checkBtn.textContent = "檢查更新";
      checkBtn.addEventListener("click", () => update.check());
      const versionRow = this.#row("version", "版本", "讀取中…", () => checkBtn);
      d.addEventListener("toggle", () => {
        if (d.open) void update.version().then((v) => (versionRow.querySelector("small")!.textContent = v));
      });
      advanced.append(
        versionRow,
        this.#row("autoUpdate", "自動檢查更新", "每天檢查一次 GitHub 上的最新版，下載前會先詢問", () =>
          this.#control("autoUpdate"),
        ),
      );
    }
    advanced.append(this.#row("reset", "所有設定", "主題、版面配置不受影響", () => reset));
    body.append(advanced);
    this.#buildNav(nav, body);

    d.addEventListener("click", (e) => {
      if (e.target === d) d.close();
    });
    document.body.append(d);
    store.subscribe(() => this.#sync());
  }

  /** 開啟設定；`page` 是分類名稱（例如「AI 協作」）。 */
  open(page?: string): void {
    this.#sync();
    this.#dialog.showModal();
    void this.#refreshTools();
    if (page) {
      const tab = [...this.#dialog.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((t) => t.textContent === page);
      tab?.click();
    }
  }

  /** 每個 section 成為左邊的一個分類；方向鍵上下切換。 */
  #buildNav(nav: HTMLElement, body: HTMLElement): void {
    const sections = [...body.querySelectorAll<HTMLElement>(":scope > section")];
    const tabs = sections.map((section, i) => {
      const id = `settings-page-${i}`;
      section.id = id;
      section.role = "tabpanel";
      const tab = document.createElement("button");
      tab.type = "button";
      tab.role = "tab";
      tab.id = `${id}-tab`;
      tab.setAttribute("aria-controls", id);
      section.setAttribute("aria-labelledby", tab.id);
      tab.textContent = section.querySelector("h3")?.textContent ?? "";
      tab.addEventListener("click", () => show(i));
      return tab;
    });
    const show = (i: number) => {
      this.#page = i;
      sections.forEach((s, j) => (s.hidden = j !== i));
      tabs.forEach((t, j) => {
        t.setAttribute("aria-selected", String(j === i));
        t.tabIndex = j === i ? 0 : -1;
      });
      body.scrollTop = 0;
    };
    nav.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const next = (this.#page + (e.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
      show(next);
      tabs[next].focus();
    });
    nav.append(...tabs);
    show(0);
  }

  #aiSection(): HTMLElement {
    const section = this.#section("AI 協作");
    if (!this.#ai) {
      const p = document.createElement("p");
      p.className = "settings-note";
      p.textContent = "AI 協作（Claude Code／Codex）需要桌面版。";
      section.append(p);
      return section;
    }
    const intro = document.createElement("p");
    intro.className = "settings-note";
    intro.textContent =
      "使用你自己安裝並登入的 Claude Code 或 Codex，編輯器不會儲存任何帳號或金鑰。AI 提出的修改一律先標示差異，由你決定是否套用。";
    section.append(
      intro,
      this.#row("aiEnabled", "啟用 AI 協作", "開啟後可使用終端機、選取段落快捷動作", () => this.#control("aiEnabled")),
      this.#row("aiTool", "快捷動作使用", undefined, () => this.#control("aiTool")),
      this.#row(
        "mcpServer",
        "讓 AI 讀取目前的文件",
        "終端機中的 Claude Code／Codex 可以讀取你正在看的文件與選取範圍，並提出修改。只接受本機連線。",
        () => this.#control("mcpServer"),
      ),
      this.#row(
        "aiTerminal",
        "讓 AI 在終端機執行指令",
        "Claude Code／Codex 可以要求在下方的終端機執行指令（例如 git、轉檔），每次都會先問你，執行過程會顯示在終端機分頁。需要開啟「讓 AI 讀取目前的文件」。",
        () => this.#control("aiTerminal"),
      ),
      this.#row(
        "markExternalChanges",
        "外部修改時逐段標示",
        "AI 或其他程式改了已開啟的檔案時，標示改了哪些地方，可以逐段還原",
        () => this.#control("markExternalChanges"),
      ),
    );

    const register = document.createElement("div");
    register.className = "settings-register";
    for (const [tool, label] of [
      ["claude", "複製 Claude Code 註冊指令"],
      ["codex", "複製 Codex 註冊指令"],
    ] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.textContent = label;
      b.dataset.aiDependent = "1";
      b.addEventListener("click", async () => {
        try {
          const r = await this.#ai!.registration();
          await navigator.clipboard.writeText(tool === "claude" ? r.claudeAdd : r.codexAdd);
          toast("已複製。在終端機貼上執行一次，之後在任何地方啟動都能連到編輯器（編輯器要開著）。", { duration: 8000 });
        } catch (e) {
          toast(`無法取得註冊指令：${e instanceof Error ? e.message : e}`, { tone: "error" });
        }
      });
      register.append(b);
    }
    section.append(
      this.#row("register", "在編輯器外使用", "從編輯器的終端機啟動時會自動連線；在其他終端機使用前，先註冊一次", () => register),
    );

    const h = document.createElement("h4");
    h.textContent = "選取段落快捷動作";
    const hint = document.createElement("p");
    hint.className = "settings-note";
    hint.textContent = "選取文字後按 Ctrl+J（或在選取範圍按右鍵）執行。提示詞會連同選取的文字一起送出。";
    this.#actions = document.createElement("div");
    this.#actions.className = "quick-actions";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn";
    add.dataset.aiDependent = "1";
    add.append(icon("plus"), "新增動作");
    add.addEventListener("click", () => {
      const list = [...this.#store.value.quickActions, { name: "新動作", prompt: "請描述要 AI 怎麼處理選取的文字" }];
      this.#store.update({ quickActions: list });
      this.#renderActions();
      this.#actions.querySelector<HTMLInputElement>(".quick-action:last-child input")?.select();
    });
    section.append(h, hint, this.#actions, add);
    return section;
  }

  #renderActions(): void {
    if (!this.#actions) return;
    const save = () => {
      const rows = [...this.#actions.querySelectorAll<HTMLElement>(".quick-action")];
      const list: QuickAction[] = rows.map((r) => ({
        name: r.querySelector("input")!.value,
        prompt: r.querySelector("textarea")!.value,
      }));
      this.#store.update({ quickActions: list });
    };
    const disabled = !this.#store.value.aiEnabled;
    this.#actions.replaceChildren(
      ...this.#store.value.quickActions.map((a, i) => {
        const row = document.createElement("div");
        row.className = "quick-action";
        const name = document.createElement("input");
        name.value = a.name;
        name.maxLength = QUICK_ACTION_LIMITS.name;
        name.setAttribute("aria-label", `第 ${i + 1} 個動作的名稱`);
        const prompt = document.createElement("textarea");
        prompt.value = a.prompt;
        prompt.rows = 2;
        prompt.maxLength = QUICK_ACTION_LIMITS.prompt;
        prompt.setAttribute("aria-label", `「${a.name}」的提示詞`);
        const del = document.createElement("button");
        del.type = "button";
        del.className = "btn icon-only";
        del.title = "刪除這個動作";
        del.setAttribute("aria-label", `刪除「${a.name}」`);
        del.append(icon("x"));
        del.addEventListener("click", () => {
          row.remove();
          save();
          this.#renderActions();
        });
        for (const el of [name, prompt]) el.addEventListener("change", save);
        for (const el of [name, prompt, del]) el.disabled = disabled;
        row.append(name, del, prompt);
        return row;
      }),
    );
  }

  /** 標出沒有安裝的工具。 */
  async #refreshTools(): Promise<void> {
    if (!this.#ai) return;
    const sel = this.#dialog.querySelector<HTMLSelectElement>("select[data-key=aiTool]");
    try {
      const found = await this.#ai.available();
      for (const opt of sel?.options ?? []) {
        const ok = !!found[opt.value as "claude" | "codex"];
        opt.textContent = `${opt.value === "claude" ? "Claude Code" : "Codex"}${ok ? "" : "（未安裝）"}`;
      }
    } catch (e) {
      console.error(e);
    }
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
    for (const [v, l] of SELECT_OPTIONS[key] ?? []) sel.append(new Option(l, v));
    sel.addEventListener("change", () =>
      this.#store.update({ [key]: key === "gitSyncMinutes" ? Number(sel.value) : sel.value }),
    );
    return sel;
  }

  /** 讓畫面上的控制項反映目前的設定值。 */
  #sync(): void {
    const v = this.#store.value;
    for (const el of this.#dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]")) {
      const value = v[el.dataset.key as keyof Settings];
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = value as boolean;
      else el.value = String(value);
      if (AI_DEPENDENT.includes(el.dataset.key as keyof Settings)) el.disabled = !v.aiEnabled;
    }
    for (const el of this.#dialog.querySelectorAll<HTMLButtonElement>("[data-ai-dependent]")) el.disabled = !v.aiEnabled;
    // 正在輸入時不要重畫，避免游標跳走。
    if (!this.#actions?.contains(document.activeElement)) this.#renderActions();
  }
}
