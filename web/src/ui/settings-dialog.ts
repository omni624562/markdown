import {
  FONT_SIZE_RANGE,
  QUICK_ACTION_LIMITS,
  type QuickAction,
  type Settings,
  type SettingsStore,
} from "../settings.ts";
import { fontStack, installedFonts } from "../fonts.ts";
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
  docFont: [
    ["sans", "黑體（預設）"],
    ["serif", "明體"],
    ["kai", "楷體"],
    ["mono", "等寬"],
    ["custom", "自訂…"],
  ],
  docLineHeight: [
    ["compact", "緊湊"],
    ["normal", "標準"],
    ["relaxed", "寬鬆"],
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
/** 設定的 Git 頁：GitHub 帳號與儲存庫（桌面版）。 */
export interface GitHubHooks {
  account(): { login: string } | null;
  /** 有開啟（本機的）資料夾，才能上傳到 GitHub。 */
  canPublish(): boolean;
  login(): void;
  logout(): void;
  openRepo(): void;
  publish(): void;
}

/** 設定的 Git 頁：Azure DevOps 連線（桌面版）。 */
export interface AdoSettingsHooks {
  account(): { name: string; url: string } | null;
  connect(url: string, pat: string): Promise<boolean>;
  disconnect(): void;
  openRepo(): void;
  workItems(): void;
}

export interface UpdateHooks {
  /** `label` 是版本號，`detail` 顯示在下面（例如發佈日期），`title` 是滑鼠停留時的技術資訊。 */
  version(): Promise<{ label: string; detail: string; title: string }>;
  /** 已經下載好、等重新啟動的新版本。 */
  pending(): string | null;
  /** 更新狀態改變時呼叫 `fn`。 */
  onChange(fn: () => void): void;
  check(): void;
  restart(): void;
}

/** AI 區中，總開關關閉時一起停用的選項。 */
const AI_DEPENDENT: (keyof Settings)[] = ["aiTool", "mcpServer", "aiTerminal", "markExternalChanges"];

interface Field {
  key: keyof Settings;
  label: string;
  hint?: string;
}

/** 一組放在同一張卡片裡的選項；`title` 顯示在卡片上方。 */
interface Group {
  title?: string;
  fields: Field[];
}

/** 「外觀」頁（主題另外加在第一組的最前面）。 */
const LOOK_GROUPS: Group[] = [
  {
    title: "主題與字型",
    fields: [
      { key: "docFont", label: "內文字型", hint: "即時預覽、預覽與 PDF 使用" },
      {
        key: "docFontCustom",
        label: "自訂內文字型",
        hint: "輸入或從清單挑選電腦上的字型；這個字型缺字時，用預設字型補上",
      },
      { key: "codeFont", label: "程式碼字型", hint: "原始碼檢視與程式碼區塊；留空使用內建的等寬字型" },
      { key: "docLineHeight", label: "行距" },
      { key: "previewWidth", label: "文字欄寬", hint: "預覽與匯出的版面寬度" },
    ],
  },
  {
    title: "版面",
    fields: [
      { key: "fixedToolbar", label: "固定顯示格式工具列", hint: "關閉時，選取文字才會浮出格式按鈕" },
      { key: "outlineRight", label: "大綱放在右邊", hint: "視窗夠寬時，大綱固定在內文右邊，目前的章節會亮起來" },
    ],
  },
  {
    title: "文件內容",
    fields: [
      { key: "math", label: "顯示數學公式", hint: "$…$ 與 $$…$$，使用 KaTeX" },
      { key: "mermaid", label: "顯示流程圖", hint: "```mermaid 程式碼區塊" },
      { key: "blockRemoteImages", label: "封鎖遠端圖片", hint: "不載入網路上的圖片，避免別人得知你何時開啟文件" },
    ],
  },
];

const EDIT_GROUPS: Group[] = [
  {
    title: "編輯區",
    fields: [
      { key: "editorFontSize", label: "字級", hint: "也可以按 Ctrl+= 或 Ctrl+- 調整" },
      { key: "lineNumbers", label: "顯示行號", hint: "原始碼檢視" },
      { key: "focusMode", label: "專注模式", hint: "淡化目前段落以外的文字" },
      { key: "typewriterMode", label: "打字機模式", hint: "游標所在的行保持在畫面中央" },
    ],
  },
  {
    title: "輸入輔助",
    fields: [
      { key: "autoPairBrackets", label: "自動補上右括號與引號", hint: "包含全形「」『』（）《》【】" },
      { key: "autoSymbols", label: "打字自動轉符號", hint: "<= 變 ≤、-> 變 →、!= 變 ≠；轉換後按 Backspace 可以還原" },
      { key: "tableAutoFormat", label: "表格自動對齊", hint: "在表格中按 Tab 時，依中文字寬對齊直線" },
      {
        key: "termCheck",
        label: "檢查兩國用語、錯字與標點",
        hint: "中國用語、常見錯字與中文裡的半形標點畫上波浪底線，滑鼠移上去就能修正",
      },
    ],
  },
  {
    title: "貼上與存檔",
    fields: [
      { key: "smartPaste", label: "貼上時轉成 Markdown", hint: "網頁、Google 文件、Word 保留標題、清單與表格；Ctrl+Shift+V 貼純文字" },
      { key: "imageCompress", label: "壓縮貼上的大圖片", hint: "超過 2000 像素的圖片自動縮小，大照片改存成 JPEG" },
      { key: "autoSave", label: "自動存檔", hint: "已經存過的檔案，停止打字後自動存回磁碟" },
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
  /** 重新整理 Git 頁的帳號狀態（登入、登出後）。 */
  #refreshGit = () => {};
  #page = 0;

  constructor(
    store: SettingsStore,
    theme: { get(): ThemePref; set(t: ThemePref): void },
    ai: AiHooks | null = null,
    update: UpdateHooks | null = null,
    github: GitHubHooks | null = null,
    ado: AdoSettingsHooks | null = null,
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
    close.className = "btn btn-primary btn-small";
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
    const themeRow = this.#row("theme", "主題", undefined, () => {
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
    });
    const look = this.#section("外觀", "palette", "主題、字型與版面配置");
    LOOK_GROUPS.forEach((g, i) => look.append(...this.#group(g.title, [...(i === 0 ? [themeRow] : []), ...this.#rows(g.fields)])));
    body.append(look);

    const edit = this.#section("編輯", "pen-line", "打字、貼上與存檔的方式");
    for (const g of EDIT_GROUPS) edit.append(...this.#group(g.title, this.#rows(g.fields)));
    body.append(edit);

    body.append(this.#aiSection());
    if (github) {
      const git = this.#section("Git", "git-branch", "用 GitHub 或 Azure DevOps 同步資料夾；Git 已經內建，不需要另外安裝");
      const accountBtn = document.createElement("button");
      accountBtn.type = "button";
      accountBtn.id = "setting-github";
      const accountRow = this.#row("github", "GitHub 帳號", "讀取中…", () => accountBtn);
      const accountHint = accountRow.querySelector("small")!;
      accountBtn.addEventListener("click", () => (github.account() ? github.logout() : github.login()));
      const action = (id: string, label: string, run: () => void) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn";
        b.id = `setting-${id}`;
        b.textContent = label;
        b.addEventListener("click", () => {
          d.close();
          run();
        });
        return b;
      };
      const publishBtn = action("github-publish", "上傳…", () => github.publish());
      const adoRows = ado ? this.#adoRows(ado, action) : null;
      this.#refreshGit = () => {
        adoRows?.refresh();
        const a = github.account();
        accountHint.textContent = a ? `已登入：${a.login}` : "登入後就能把資料夾同步到 GitHub，在其他電腦也能下載";
        accountBtn.className = a ? "btn" : "btn btn-primary";
        accountBtn.textContent = a ? "登出" : "用 GitHub 登入";
        publishBtn.disabled = !github.canPublish();
        publishBtn.title = publishBtn.disabled ? "請先開啟要上傳的資料夾" : "";
      };
      this.#refreshGit();
      d.addEventListener("toggle", () => this.#refreshGit());
      git.append(
        ...this.#group("帳號", [accountRow]),
        ...this.#group("儲存庫", [
          this.#row("github-open", "從 GitHub 開啟儲存庫", "選一個儲存庫，下載到電腦並開啟", () =>
            action("github-open", "開啟…", () => github.openRepo()),
          ),
          this.#row("github-publish", "上傳到 GitHub", "把目前開啟的資料夾建立成新的 GitHub 儲存庫", () => publishBtn),
        ]),
        ...(adoRows ? this.#group("Azure DevOps（TFS）", adoRows.rows) : []),
        ...this.#group("自動同步", [
          this.#row("gitAutoSync", "自動同步", "定時提交、拉取、推送；兩邊改到同一個地方時會暫停，不會蓋掉任何內容", () =>
            this.#control("gitAutoSync"),
          ),
          this.#row("gitSyncMinutes", "同步頻率", undefined, () => this.#control("gitSyncMinutes")),
        ]),
      );
      body.append(git);
    }

    const advanced = this.#section("進階", "sliders-horizontal", "版本、更新與重設");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn";
    reset.append(icon("rotate-ccw"), "恢復預設值");
    reset.addEventListener("click", () => {
      store.reset();
      this.#sync();
    });
    if (update) {
      const checkBtn = document.createElement("button");
      checkBtn.type = "button";
      checkBtn.className = "btn";
      checkBtn.addEventListener("click", () => (update.pending() ? update.restart() : update.check()));
      const versionRow = this.#row("version", "版本", "讀取中…", () => checkBtn);
      const label = versionRow.querySelector("label")!;
      const hint = versionRow.querySelector("small")!;
      // 新版已經下載好時，版本列直接說明，按鈕改成「重新啟動並更新」。
      const refresh = async () => {
        const v = await update.version();
        const pending = update.pending();
        label.textContent = `版本 ${v.label}`;
        label.title = v.title;
        hint.textContent = pending ? `${pending} 已下載完成，重新啟動即可更新（未存檔的內容會保留）` : v.detail;
        hint.classList.toggle("settings-ready", !!pending);
        checkBtn.textContent = pending ? "重新啟動並更新" : "檢查更新";
        checkBtn.classList.toggle("btn-primary", !!pending);
      };
      d.addEventListener("toggle", () => {
        if (d.open) void refresh();
      });
      update.onChange(() => {
        if (d.open) void refresh();
      });
      advanced.append(
        ...this.#group("更新", [
          versionRow,
          this.#row("autoUpdate", "自動檢查更新", "每天檢查一次，下載前會先詢問", () => this.#control("autoUpdate")),
        ]),
      );
    }
    advanced.append(...this.#group("重設", [this.#row("reset", "所有設定", "恢復成預設值；主題、版面配置不受影響", () => reset)]));
    body.append(advanced);
    this.#buildNav(nav, body);

    d.addEventListener("click", (e) => {
      if (e.target === d) d.close();
    });
    document.body.append(d);
    store.subscribe(() => this.#sync());
  }

  /** 開啟設定；`page` 是分類名稱（例如「AI 協作」）。 */
  /** 外部狀態改變（例如登入 GitHub）後更新畫面。 */
  refresh(): void {
    this.#refreshGit();
  }

  open(page?: string): void {
    this.#sync();
    this.#dialog.showModal();
    // 焦點放在目前的分類上（不要一打開就把框框畫在「完成」按鈕上）。
    this.#dialog.querySelector<HTMLElement>("[role=tab][aria-selected=true]")?.focus();
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
      tab.append(icon(section.dataset.icon ?? "settings"), section.querySelector("h3")?.textContent ?? "");
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
    const section = this.#section(
      "AI 協作",
      "sparkles",
      "使用你自己安裝並登入的 Claude Code 或 Codex。編輯器不會儲存帳號或金鑰；AI 提出的修改一律先標示差異，由你決定是否套用。",
    );
    if (!this.#ai) {
      const p = document.createElement("p");
      p.className = "settings-note";
      p.textContent = "AI 協作（Claude Code／Codex）需要桌面版。";
      section.append(p);
      return section;
    }
    section.append(
      ...this.#group(undefined, [
        this.#row("aiEnabled", "啟用 AI 協作", "開啟後可以使用終端機與選取段落快捷動作", () => this.#control("aiEnabled")),
      ]),
    );
    const permissions = this.#group("AI 可以做的事", [
      this.#row("aiTool", "快捷動作使用", undefined, () => this.#control("aiTool")),
      this.#row("mcpServer", "讀取目前的文件", "Claude Code／Codex 可以讀取你正在看的文件並提出修改；只接受本機連線", () =>
        this.#control("mcpServer"),
      ),
      this.#row("aiTerminal", "在終端機執行指令", "AI 要執行指令（例如 git、轉檔）時，每次都會先問你；需要開啟上一項", () =>
        this.#control("aiTerminal"),
      ),
      this.#row("markExternalChanges", "標示外部修改", "其他程式改了已開啟的檔案時，標示改了哪裡，可以逐段還原", () =>
        this.#control("markExternalChanges"),
      ),
    ]);
    permissions[permissions.length - 1].dataset.aiGroup = "1";
    section.append(...permissions);

    const register = document.createElement("div");
    register.className = "settings-buttons";
    for (const [tool, label] of [
      ["claude", "Claude Code"],
      ["codex", "Codex"],
    ] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-small";
      b.append(icon("copy"), label);
      b.title = `複製 ${label} 的註冊指令`;
      b.setAttribute("aria-label", `複製 ${label} 的註冊指令`);
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
    const outside = this.#group("在其他終端機使用", [
      this.#row("register", "註冊指令", "從編輯器的終端機啟動會自動連線；其他終端機要先執行一次註冊指令", () => register),
    ]);
    outside[outside.length - 1].dataset.aiGroup = "1";
    section.append(...outside);

    this.#actions = document.createElement("div");
    this.#actions.className = "quick-actions";
    this.#actions.dataset.aiGroup = "1";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "quick-action-add";
    add.dataset.aiDependent = "1";
    add.append(icon("plus"), "新增動作");
    add.addEventListener("click", () => {
      const list = [...this.#store.value.quickActions, { name: "新動作", prompt: "請描述要 AI 怎麼處理選取的文字" }];
      this.#store.update({ quickActions: list });
      this.#renderActions();
      this.#actions.querySelector<HTMLInputElement>(".quick-action:last-child input")?.select();
    });
    const title = document.createElement("h4");
    title.className = "settings-group-title";
    title.textContent = "選取段落快捷動作";
    const hint = document.createElement("p");
    hint.className = "settings-group-hint";
    hint.textContent = "選取文字後按 Ctrl+J（或按右鍵）執行；提示詞會連同選取的文字一起送出。";
    section.append(title, hint, this.#actions, add);
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
        name.placeholder = "動作名稱";
        const prompt = document.createElement("textarea");
        prompt.value = a.prompt;
        prompt.rows = 2;
        prompt.maxLength = QUICK_ACTION_LIMITS.prompt;
        prompt.setAttribute("aria-label", `「${a.name}」的提示詞`);
        prompt.placeholder = "要 AI 怎麼處理選取的文字";
        const del = document.createElement("button");
        del.type = "button";
        del.className = "quick-action-delete";
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

  /** 一個分類頁：標題、一句說明，左邊的分類列會用 `iconName` 的圖示。 */
  #section(title: string, iconName: string, desc?: string): HTMLElement {
    const s = document.createElement("section");
    s.dataset.icon = iconName;
    const h = document.createElement("h3");
    h.textContent = title;
    s.append(h);
    if (desc) s.append(Object.assign(document.createElement("p"), { className: "settings-desc", textContent: desc }));
    return s;
  }

  /** 一組選項：卡片上方是小標題，卡片裡的選項用細線分隔。 */
  #group(title: string | undefined, rows: HTMLElement[]): HTMLElement[] {
    const card = document.createElement("div");
    card.className = "settings-group";
    card.append(...rows);
    if (!title) return [card];
    const h = document.createElement("h4");
    h.className = "settings-group-title";
    h.textContent = title;
    return [h, card];
  }

  #rows(fields: Field[]): HTMLElement[] {
    return fields.map((f) => this.#row(f.key, f.label, f.hint, () => this.#control(f.key)));
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
    if (key === "docFontCustom" || key === "codeFont") return this.#fontInput(key);
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

  /** Azure DevOps：沒連線時輸入網址與權杖；連線後顯示帳號、下載儲存庫與工作項目。 */
  #adoRows(
    ado: AdoSettingsHooks,
    action: (id: string, label: string, run: () => void) => HTMLButtonElement,
  ): { rows: HTMLElement[]; refresh(): void } {
    const input = (id: string, type: string, placeholder: string) => {
      const el = document.createElement("input");
      el.type = type;
      el.id = `setting-${id}`;
      el.className = "font-input ado-input";
      el.placeholder = placeholder;
      el.spellcheck = false;
      el.autocomplete = "off";
      return el;
    };
    const url = input("ado-url", "url", "https://tfs.公司.com/tfs/DefaultCollection");
    const pat = input("ado-pat", "password", "貼上權杖");
    const urlRow = this.#row("ado-url", "伺服器網址", "集合或組織的網址；貼上專案或儲存庫的網址也可以", () => url);
    const patRow = this.#row(
      "ado-pat",
      "個人存取權杖（PAT）",
      "在 ADO 網頁右上角的使用者設定 →「Personal access tokens」建立，權限勾選 Code（Read & write）與 Work Items（Read）",
      () => pat,
    );
    const connectBtn = document.createElement("button");
    connectBtn.type = "button";
    connectBtn.id = "setting-ado-connect";
    const statusRow = this.#row("ado-connect", "連線", "讀取中…", () => connectBtn);
    const hint = statusRow.querySelector("small")!;
    const label = statusRow.querySelector("label")!;
    connectBtn.addEventListener("click", async () => {
      if (ado.account()) {
        ado.disconnect();
        return;
      }
      connectBtn.disabled = true;
      const ok = await ado.connect(url.value, pat.value);
      connectBtn.disabled = false;
      if (ok) pat.value = "";
      refresh();
    });
    pat.addEventListener("keydown", (e) => {
      if (e.key === "Enter") connectBtn.click();
    });
    const openRow = this.#row("ado-open", "從 Azure DevOps 開啟儲存庫", "選一個儲存庫或專案 Wiki，下載到電腦並開啟", () =>
      action("ado-open", "開啟…", () => ado.openRepo()),
    );
    const itemsRow = this.#row("ado-items", "工作項目", "在側邊欄列出指派給你的工作項目，可以插入連結到文件", () =>
      action("ado-items", "顯示", () => ado.workItems()),
    );
    const refresh = () => {
      const a = ado.account();
      urlRow.hidden = patRow.hidden = !!a;
      // 上面兩列藏起來時，帳號是第一列，不需要分隔線。
      statusRow.style.borderTop = a ? "0" : "";
      openRow.hidden = itemsRow.hidden = !a;
      label.textContent = a ? "帳號" : "連線";
      hint.textContent = a
        ? `已連線：${a.name}（${a.url.replace(/^https?:\/\//, "")}）`
        : "輸入網址與權杖後按「連線」；權杖只會送到這台伺服器";
      connectBtn.className = a ? "btn" : "btn btn-primary";
      connectBtn.textContent = a ? "中斷連線" : "連線";
    };
    refresh();
    return { rows: [urlRow, patRow, statusRow, openRow, itemsRow], refresh };
  }

  /** 字型名稱：可以直接輸入，也可以從電腦上安裝的字型挑選；輸入框用該字型顯示當作預覽。 */
  #fontInput(key: "docFontCustom" | "codeFont"): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "font-input";
    input.dataset.key = key;
    input.placeholder = key === "codeFont" ? "內建等寬字型" : "例如：微軟正黑體";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("list", "font-choices");
    input.addEventListener("focus", () => this.#loadFonts(), { once: true });
    input.addEventListener("input", () => (input.style.fontFamily = fontPreview(input.value)));
    input.addEventListener("change", () => this.#store.update({ [key]: input.value }));
    return input;
  }

  /** 第一次點字型欄位時才讀取安裝的字型（桌面版要掃描字型資料夾）。 */
  #loadFonts(): void {
    if (this.#dialog.querySelector("#font-choices")) return;
    const list = document.createElement("datalist");
    list.id = "font-choices";
    this.#dialog.append(list);
    installedFonts()
      .then((fonts) => {
        for (const f of fonts) {
          const label = [f.label, f.mono ? "等寬" : ""].filter(Boolean).join("・");
          list.append(new Option(label, f.name));
        }
      })
      .catch(console.error);
  }

  /** 讓畫面上的控制項反映目前的設定值。 */
  #sync(): void {
    const v = this.#store.value;
    for (const el of this.#dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]")) {
      const value = v[el.dataset.key as keyof Settings];
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = value as boolean;
      else if (el.classList.contains("font-input")) {
        // 正在輸入時不要蓋掉。
        if (el !== document.activeElement) el.value = String(value);
        el.style.fontFamily = fontPreview(el.value);
      } else el.value = String(value);
      if (AI_DEPENDENT.includes(el.dataset.key as keyof Settings)) el.disabled = !v.aiEnabled;
    }
    const customFont = this.#dialog.querySelector('[data-key="docFontCustom"]')?.closest<HTMLElement>(".settings-row");
    if (customFont) customFont.hidden = v.docFont !== "custom";
    for (const el of this.#dialog.querySelectorAll<HTMLButtonElement>("[data-ai-dependent]")) el.disabled = !v.aiEnabled;
    // AI 總開關關閉時，相關的卡片一起變淡。
    for (const el of this.#dialog.querySelectorAll<HTMLElement>("[data-ai-group]")) el.classList.toggle("is-off", !v.aiEnabled);
    // 正在輸入時不要重畫，避免游標跳走。
    if (!this.#actions?.contains(document.activeElement)) this.#renderActions();
  }
}

/** 字型欄位用輸入的字型顯示；名稱不完整時退回介面字型。 */
function fontPreview(name: string): string {
  return fontStack(name, "var(--font-ui)");
}
