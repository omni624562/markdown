import {
  DEFAULTS,
  FONT_SIZE_RANGE,
  QUICK_ACTION_LIMITS,
  type QuickAction,
  type Settings,
  type SettingsStore,
} from "../settings.ts";
import { fontStack, installedFonts } from "../fonts.ts";
import { type LangPref, langPref, langPrefs, setLangPref, t } from "../i18n.ts";
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
    ["narrow", t("窄")],
    ["medium", t("中")],
    ["wide", t("寬")],
  ],
  docFont: [
    ["sans", t("黑體（預設）")],
    ["serif", t("明體")],
    ["kai", t("楷體")],
    ["mono", t("等寬")],
    ["custom", t("自訂…")],
  ],
  docLineHeight: [
    ["compact", t("緊湊")],
    ["normal", t("標準")],
    ["relaxed", t("寬鬆")],
  ],
  aiTool: [
    ["claude", "Claude Code"],
    ["codex", "Codex"],
  ],
  gitSyncMinutes: [
    ["5", t("每 {n} 分鐘", { n: 5 })],
    ["10", t("每 {n} 分鐘", { n: 10 })],
    ["30", t("每 {n} 分鐘", { n: 30 })],
    ["60", t("每小時")],
  ],
};
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

/** 桌面版提供：目前版本與手動檢查更新。 */
export interface UpdateHooks {
  /** `label` 是版本號，`detail` 顯示在下面（例如發佈日期），`title` 是滑鼠停留時的技術資訊。 */
  version(): Promise<{ label: string; detail: string; title: string }>;
  /** 已經下載好、等重新啟動的新版本。 */
  pending(): string | null;
  /** 正在檢查更新（按鈕暫時不能按）。 */
  checking(): boolean;
  /** 更新狀態改變時呼叫 `fn`。 */
  onChange(fn: () => void): void;
  check(): void;
  restart(): void;
}

/** 「關於」頁的連結與說明。 */
export interface AboutHooks {
  /** 網頁版沒有更新機制時，直接顯示的版本號。 */
  version: string;
  openUrl(url: string): void;
  shortcuts(): void;
  welcome(): void;
  changelog(): void;
}

/** 「外觀」頁的左側圖示列：面板圖示的順序與顯示、釘上去的指令按鈕。 */
export interface ActivityHooks {
  /** 面板圖示（依目前的順序）。`available` 是這台電腦、這個資料夾能不能用。 */
  panels(): { id: string; label: string; icon: string; available: boolean }[];
  command(id: string): { title: string; icon: string } | null;
  /** 選一個指令新增到圖示列。 */
  add(): void;
}

/** 原始碼與問題回報。 */
export const REPO_URL = "https://github.com/omni624562/markdown";

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

/** 「外觀」頁。 */
const LOOK_GROUPS: Group[] = [
  {
    title: t("字型"),
    fields: [
      { key: "docFont", label: t("內文字型"), hint: t("即時預覽、預覽與 PDF 使用") },
      {
        key: "docFontCustom",
        label: t("自訂內文字型"),
        hint: t("輸入或從清單挑選電腦上的字型；這個字型缺字時，用預設字型補上"),
      },
      { key: "codeFont", label: t("程式碼字型"), hint: t("原始碼檢視與程式碼區塊；留空使用內建的等寬字型") },
      { key: "editorFontSize", label: t("字級"), hint: t("也可以按 Ctrl+= 或 Ctrl+- 調整") },
    ],
  },
  {
    title: t("版面"),
    fields: [
      { key: "docLineHeight", label: t("行距") },
      { key: "previewWidth", label: t("文字欄寬"), hint: t("預覽與匯出的版面寬度") },
      { key: "fixedToolbar", label: t("固定顯示格式工具列"), hint: t("關閉時，選取文字才會浮出格式按鈕") },
      { key: "outlineRight", label: t("大綱放在右邊"), hint: t("視窗夠寬時，大綱固定在內文右邊，目前的章節會亮起來") },
      { key: "lineNumbers", label: t("顯示行號"), hint: t("原始碼檢視") },
    ],
  },
  {
    title: t("文件內容"),
    fields: [
      { key: "math", label: t("顯示數學公式"), hint: t("$…$ 與 $$…$$，使用 KaTeX") },
      { key: "mermaid", label: t("顯示流程圖"), hint: t("```mermaid 程式碼區塊") },
      { key: "blockRemoteImages", label: t("封鎖遠端圖片"), hint: t("不載入網路上的圖片，避免別人得知你何時開啟文件") },
    ],
  },
];

/** 「編輯」頁。 */
const EDIT_GROUPS: Group[] = [
  {
    title: t("寫作模式"),
    fields: [
      { key: "focusMode", label: t("專注模式"), hint: t("淡化目前段落以外的文字") },
      { key: "typewriterMode", label: t("打字機模式"), hint: t("游標所在的行保持在畫面中央") },
    ],
  },
  {
    title: t("輸入輔助"),
    fields: [
      { key: "autoPairBrackets", label: t("自動補上右括號與引號"), hint: t("包含全形「」『』（）《》【】") },
      { key: "autoSymbols", label: t("打字自動轉符號"), hint: t("<= 變 ≤、-> 變 →、!= 變 ≠；轉換後按 Backspace 可以還原") },
      { key: "tableAutoFormat", label: t("表格自動對齊"), hint: t("在表格中按 Tab 時，依中文字寬對齊直線") },
      {
        key: "termCheck",
        label: t("檢查兩國用語、錯字與標點"),
        hint: t("中國用語、常見錯字與中文裡的半形標點畫上波浪底線，滑鼠移上去就能修正"),
      },
    ],
  },
  {
    title: t("貼上"),
    fields: [
      { key: "smartPaste", label: t("貼上時轉成 Markdown"), hint: t("網頁、Google 文件、Word 保留標題、清單與表格；Ctrl+Shift+V 貼純文字") },
      { key: "imageCompress", label: t("壓縮貼上的大圖片"), hint: t("超過 2000 像素的圖片自動縮小，大照片改存成 JPEG") },
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
  /** 依搜尋文字篩選選項（空白時回到分類頁）。 */
  #filter: (query: string) => void = () => {};

  constructor(
    store: SettingsStore,
    theme: { get(): ThemePref; set(t: ThemePref): void },
    ai: AiHooks | null = null,
    update: UpdateHooks | null = null,
    github: GitHubHooks | null = null,
    ado: AdoSettingsHooks | null = null,
    about: AboutHooks | null = null,
    activityHooks: ActivityHooks | null = null,
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
    h.textContent = t("設定");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn btn-primary btn-small";
    close.textContent = t("完成");
    close.addEventListener("click", () => d.close());
    // 選項不少：可以直接搜尋（比對名稱與說明）。
    const search = document.createElement("input");
    search.type = "search";
    search.className = "settings-search";
    search.placeholder = t("搜尋設定…");
    search.setAttribute("aria-label", t("搜尋設定"));
    search.addEventListener("input", () => this.#filter(search.value));
    d.addEventListener("close", () => {
      search.value = "";
      this.#filter("");
    });
    header.append(h, search, close);
    d.append(header);

    // 左邊是分類，右邊一次只顯示一個分類的選項。
    const layout = document.createElement("div");
    layout.className = "settings-layout";
    const nav = document.createElement("div");
    nav.className = "settings-nav";
    nav.role = "tablist";
    nav.setAttribute("aria-label", t("設定分類"));
    nav.setAttribute("aria-orientation", "vertical");
    const body = document.createElement("div");
    body.className = "settings-body";
    layout.append(nav, body);
    d.append(layout);

    // 介面語言：存在 localStorage，切換後重新載入介面（所有模組在載入時就決定好語言）。
    const langRow = this.#row("language", t("介面語言"), t("切換後會重新載入介面，開著的分頁和沒存的內容都會保留"), () => {
      const sel = document.createElement("select");
      sel.id = "setting-language";
      for (const p of langPrefs()) sel.append(new Option(p.label, p.id, false, langPref() === p.id));
      sel.addEventListener("change", () => {
        setLangPref(sel.value as LangPref);
        location.reload();
      });
      return sel;
    });
    // 外觀：主題沿用標題列主題選單的同一份狀態。
    const themeRow = this.#row("theme", t("主題"), undefined, () => {
      const sel = document.createElement("select");
      sel.id = "setting-theme";
      for (const [v, l] of [
        ["system", t("跟隨系統")],
        ["light", t("淺色")],
        ["dark", t("深色")],
      ] as const) {
        sel.append(new Option(l, v, false, theme.get() === v));
      }
      sel.addEventListener("change", () => theme.set(sel.value as ThemePref));
      d.addEventListener("toggle", () => (sel.value = theme.get()));
      return sel;
    });
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn";
    reset.append(icon("rotate-ccw"), t("恢復預設值"));
    reset.addEventListener("click", () => {
      store.reset();
      this.#sync();
    });
    const general = this.#section(t("一般"), "settings", t("語言、主題與存檔"));
    general.append(
      ...this.#group(t("介面"), [langRow, themeRow]),
      ...this.#group(t("存檔"), this.#rows([{ key: "autoSave", label: t("自動存檔"), hint: t("已經存過的檔案，停止打字後自動存回磁碟") }])),
      ...this.#group(t("重設"), [this.#row("reset", t("所有設定"), t("恢復成預設值；主題、版面配置不受影響"), () => reset)]),
    );
    body.append(general);

    const look = this.#section(t("外觀"), "palette", t("字型、版面與文件內容的顯示方式"));
    for (const g of LOOK_GROUPS) look.append(...this.#group(g.title, this.#rows(g.fields)));
    if (activityHooks) look.append(...this.#activityGroup(activityHooks));
    body.append(look);

    const edit = this.#section(t("編輯"), "pen-line", t("寫作模式、輸入輔助與貼上"));
    for (const g of EDIT_GROUPS) edit.append(...this.#group(g.title, this.#rows(g.fields)));
    body.append(edit);

    body.append(this.#aiSection());
    if (github) {
      const git = this.#section("Git", "git-branch", t("用 GitHub 或 Azure DevOps 同步資料夾；Git 已經內建，不需要另外安裝"));
      const accountBtn = document.createElement("button");
      accountBtn.type = "button";
      accountBtn.id = "setting-github";
      const accountRow = this.#row("github", t("GitHub 帳號"), t("讀取中…"), () => accountBtn);
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
      const publishBtn = action("github-publish", t("上傳…"), () => github.publish());
      const adoRows = ado ? this.#adoRows(ado, action) : null;
      this.#refreshGit = () => {
        adoRows?.refresh();
        const a = github.account();
        accountHint.textContent = a ? t("已登入：{name}", { name: a.login }) : t("登入後就能把資料夾同步到 GitHub，在其他電腦也能下載");
        accountBtn.className = a ? "btn" : "btn btn-primary";
        accountBtn.textContent = a ? t("登出") : t("用 GitHub 登入");
        publishBtn.disabled = !github.canPublish();
        publishBtn.title = publishBtn.disabled ? t("請先開啟要上傳的資料夾") : "";
      };
      this.#refreshGit();
      d.addEventListener("toggle", () => this.#refreshGit());
      git.append(
        ...this.#group(t("帳號"), [accountRow]),
        ...this.#group(t("儲存庫"), [
          this.#row("github-open", t("從 GitHub 開啟儲存庫"), t("選一個儲存庫，下載到電腦並開啟"), () =>
            action("github-open", t("開啟…"), () => github.openRepo()),
          ),
          this.#row("github-publish", t("上傳到 GitHub"), t("把目前開啟的資料夾建立成新的 GitHub 儲存庫"), () => publishBtn),
        ]),
        ...(adoRows ? this.#group(t("Azure DevOps（TFS）"), adoRows.rows) : []),
        ...this.#group(t("自動同步"), [
          this.#row("gitAutoSync", t("自動同步"), t("定時提交、拉取、推送；兩邊改到同一個地方時會暫停，不會蓋掉任何內容"), () =>
            this.#control("gitAutoSync"),
          ),
          this.#row("gitSyncMinutes", t("同步頻率"), undefined, () => this.#control("gitSyncMinutes")),
        ]),
      );
      body.append(git);
    }

    body.append(this.#aboutSection(update, about, d));
    this.#buildNav(nav, body);

    d.addEventListener("click", (e) => {
      if (e.target === d) d.close();
    });
    document.body.append(d);
    store.subscribe(() => this.#sync());
  }

  /** 外部狀態改變（例如登入 GitHub）後更新畫面。 */
  refresh(): void {
    this.#refreshGit();
  }

  /** 開啟設定；`page` 是分類名稱（例如「AI 協作」）。 */
  open(page?: string): void {
    this.#sync();
    this.#dialog.showModal();
    // 焦點放在目前的分類上（不要一打開就把框框畫在「完成」按鈕上）。
    this.#dialog.querySelector<HTMLElement>("[role=tab][aria-selected=true]")?.focus();
    void this.#refreshTools();
    if (page) {
      // 呼叫端可能傳中文原文或翻譯過的名稱。
      const names = [page, t(page)];
      const tab = [...this.#dialog.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((b) => names.includes(b.textContent ?? ""));
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
    this.#filter = (query) => {
      const q = query.trim().toLowerCase();
      const rows = [...body.querySelectorAll<HTMLElement>(".settings-row")];
      if (!q) {
        for (const el of body.querySelectorAll<HTMLElement>(".settings-row, .settings-group, .settings-group-title")) el.hidden = false;
        nav.classList.remove("searching");
        show(this.#page);
        return;
      }
      nav.classList.add("searching");
      for (const r of rows) r.hidden = !(r.textContent ?? "").toLowerCase().includes(q);
      for (const card of body.querySelectorAll<HTMLElement>(".settings-group")) {
        const empty = ![...card.querySelectorAll<HTMLElement>(".settings-row")].some((r) => !r.hidden);
        card.hidden = empty;
        const title = card.previousElementSibling;
        if (title instanceof HTMLElement && title.classList.contains("settings-group-title")) title.hidden = empty;
      }
      sections.forEach((sec) => (sec.hidden = ![...sec.querySelectorAll<HTMLElement>(".settings-row")].some((r) => !r.hidden)));
      tabs.forEach((tab) => tab.setAttribute("aria-selected", "false"));
      body.scrollTop = 0;
    };
  }

  #aiSection(): HTMLElement {
    const section = this.#section(
      t("AI 協作"),
      "sparkles",
      t("使用你自己安裝並登入的 Claude Code 或 Codex。編輯器不會儲存帳號或金鑰；AI 提出的修改一律先標示差異，由你決定是否套用。"),
    );
    if (!this.#ai) {
      const p = document.createElement("p");
      p.className = "settings-note";
      p.textContent = t("AI 協作（Claude Code／Codex）需要桌面版。");
      section.append(p);
      return section;
    }
    section.append(
      ...this.#group(undefined, [
        this.#row("aiEnabled", t("啟用 AI 協作"), t("開啟後可以使用終端機與選取段落快捷動作"), () => this.#control("aiEnabled")),
      ]),
    );
    const permissions = this.#group(t("AI 可以做的事"), [
      this.#row("aiTool", t("快捷動作使用"), undefined, () => this.#control("aiTool")),
      this.#row("mcpServer", t("讀取目前的文件"), t("Claude Code／Codex 可以讀取你正在看的文件並提出修改；只接受本機連線"), () =>
        this.#control("mcpServer"),
      ),
      this.#row("aiTerminal", t("在終端機執行指令"), t("AI 要執行指令（例如 git、轉檔）時，每次都會先問你；需要開啟上一項"), () =>
        this.#control("aiTerminal"),
      ),
      this.#row("markExternalChanges", t("標示外部修改"), t("其他程式改了已開啟的檔案時，標示改了哪裡，可以逐段還原"), () =>
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
      b.title = t("複製 {name} 的註冊指令", { name: label });
      b.setAttribute("aria-label", b.title);
      b.dataset.aiDependent = "1";
      b.addEventListener("click", async () => {
        try {
          const r = await this.#ai!.registration();
          await navigator.clipboard.writeText(tool === "claude" ? r.claudeAdd : r.codexAdd);
          toast(t("已複製。在終端機貼上執行一次，之後在任何地方啟動都能連到編輯器（編輯器要開著）。"), { duration: 8000 });
        } catch (e) {
          toast(t("無法取得註冊指令：{error}", { error: e instanceof Error ? e.message : String(e) }), { tone: "error" });
        }
      });
      register.append(b);
    }
    const outside = this.#group(t("在其他終端機使用"), [
      this.#row("register", t("註冊指令"), t("從編輯器的終端機啟動會自動連線；其他終端機要先執行一次註冊指令"), () => register),
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
    add.append(icon("plus"), t("新增動作"));
    add.addEventListener("click", () => {
      const list = [...this.#store.value.quickActions, { name: t("新動作"), prompt: t("請描述要 AI 怎麼處理選取的文字") }];
      this.#store.update({ quickActions: list });
      this.#renderActions();
      this.#actions.querySelector<HTMLInputElement>(".quick-action:last-child input")?.select();
    });
    const title = document.createElement("h4");
    title.className = "settings-group-title";
    title.textContent = t("選取段落快捷動作");
    const hint = document.createElement("p");
    hint.className = "settings-group-hint";
    hint.textContent = t("選取文字後按 Ctrl+J（或按右鍵）執行；提示詞會連同選取的文字一起送出。");
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
        name.setAttribute("aria-label", t("第 {n} 個動作的名稱", { n: i + 1 }));
        name.placeholder = t("動作名稱");
        const prompt = document.createElement("textarea");
        prompt.value = a.prompt;
        prompt.rows = 2;
        prompt.maxLength = QUICK_ACTION_LIMITS.prompt;
        prompt.setAttribute("aria-label", t("「{name}」的提示詞", { name: a.name }));
        prompt.placeholder = t("要 AI 怎麼處理選取的文字");
        const del = document.createElement("button");
        del.type = "button";
        del.className = "quick-action-delete";
        del.title = t("刪除這個動作");
        del.setAttribute("aria-label", t("刪除「{name}」", { name: a.name }));
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
      const notInstalled = t("（未安裝）");
      for (const opt of sel?.options ?? []) {
        const ok = !!found[opt.value as "claude" | "codex"];
        opt.textContent = `${opt.value === "claude" ? "Claude Code" : "Codex"}${ok ? "" : notInstalled}`;
      }
    } catch (e) {
      console.error(e);
    }
  }

  /** 一個分類頁：標題、一句說明，左邊的分類列會用 `iconName` 的圖示。 */
  /** 「關於」頁：版本與更新、說明文件、原始碼與問題回報、授權。 */
  #aboutSection(update: UpdateHooks | null, about: AboutHooks | null, d: HTMLDialogElement): HTMLElement {
    const section = this.#section(t("關於"), "info");
    const hero = document.createElement("div");
    hero.className = "settings-about";
    const logo = document.createElement("img");
    logo.src = "favicon.svg";
    logo.alt = "";
    const name = document.createElement("div");
    const title = Object.assign(document.createElement("strong"), { textContent: "oMarker" });
    const version = Object.assign(document.createElement("span"), { textContent: about ? t("版本 {version}", { version: about.version }) : "" });
    const tagline = Object.assign(document.createElement("p"), { textContent: t("給中文寫作的 Markdown 編輯器：即時預覽、資料夾、Git 與 AI 協作") });
    name.append(title, version, tagline);
    hero.append(logo, name);
    section.append(hero);

    if (update) {
      const checkBtn = document.createElement("button");
      checkBtn.type = "button";
      checkBtn.className = "btn";
      checkBtn.addEventListener("click", () => (update.pending() ? update.restart() : update.check()));
      const versionRow = this.#row("version", t("版本"), t("讀取中…"), () => checkBtn);
      const label = versionRow.querySelector("label")!;
      const hint = versionRow.querySelector("small")!;
      // 新版已經下載好時，版本列直接說明，按鈕改成「重新啟動並更新」。
      const refresh = async () => {
        const v = await update.version();
        const pending = update.pending();
        label.textContent = t("版本 {version}", { version: v.label });
        label.title = v.title;
        version.textContent = t("版本 {version}", { version: v.label });
        hint.textContent = pending ? t("{version} 已下載完成，重新啟動即可更新（未存檔的內容會保留）", { version: pending }) : v.detail;
        hint.classList.toggle("settings-ready", !!pending);
        const checking = !pending && update.checking();
        checkBtn.textContent = pending ? t("重新啟動並更新") : checking ? t("檢查中…") : t("檢查更新");
        checkBtn.disabled = checking;
        checkBtn.classList.toggle("btn-primary", !!pending);
      };
      d.addEventListener("toggle", () => {
        if (d.open) void refresh();
      });
      update.onChange(() => {
        if (d.open) void refresh();
      });
      section.append(
        ...this.#group(t("更新"), [
          versionRow,
          this.#row("autoUpdate", t("自動檢查更新"), t("每天檢查一次，下載前會先詢問"), () => this.#control("autoUpdate")),
        ]),
      );
    }
    if (about) {
      const button = (id: string, text: string, iconName: string, run: () => void) => () => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn";
        b.id = `setting-${id}`;
        b.append(icon(iconName), text);
        b.addEventListener("click", () => {
          d.close();
          run();
        });
        return b;
      };
      const link = (id: string, text: string, url: string) => () => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn";
        b.id = `setting-${id}`;
        b.append(icon("external-link"), text);
        b.addEventListener("click", () => about.openUrl(url));
        return b;
      };
      section.append(
        ...this.#group(t("說明"), [
          this.#row("shortcuts", t("快速鍵一覽"), t("也可以按 F1"), button("shortcuts", t("開啟"), "command", about.shortcuts)),
          this.#row("welcome", t("歡迎文件"), t("3 分鐘認識主要功能"), button("welcome", t("開啟"), "book-open-text", about.welcome)),
          this.#row("changelog", t("更新紀錄"), t("每一版改了什麼"), button("changelog", t("開啟"), "scroll-text", about.changelog)),
        ]),
        ...this.#group(t("意見回饋"), [
          this.#row("report", t("回報問題或建議"), t("在 GitHub 上留言；附上版本號會更容易找到原因"), link("report", t("回報"), `${REPO_URL}/issues/new`)),
          this.#row("source", t("原始碼"), t("oMarker 以 MIT 授權開放原始碼"), link("source", "GitHub", REPO_URL)),
        ]),
      );
    }
    return section;
  }

  /** 左側圖示列：可以上下移動、隱藏面板圖示，新增或移除指令按鈕。 */
  #activityGroup(h: ActivityHooks): HTMLElement[] {
    const list = document.createElement("div");
    list.className = "activity-settings";
    const button = (label: string, iconName: string, run: () => void, disabled = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn icon-only";
      b.title = label;
      b.setAttribute("aria-label", label);
      b.disabled = disabled;
      b.append(icon(iconName));
      b.addEventListener("click", run);
      return b;
    };
    const move = <T,>(arr: T[], i: number, d: number): T[] => {
      const out = [...arr];
      const [x] = out.splice(i, 1);
      out.splice(i + d, 0, x);
      return out;
    };
    const render = () => {
      const v = this.#store.value;
      const panels = h.panels();
      const rows: HTMLElement[] = [];
      panels.forEach((p, i) => {
        const row = document.createElement("div");
        row.className = "activity-setting";
        const shown = !v.activityHidden.includes(p.id);
        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = shown;
        check.setAttribute("aria-label", t("顯示「{name}」", { name: p.label }));
        check.addEventListener("change", () =>
          this.#store.update({
            activityHidden: check.checked ? v.activityHidden.filter((x) => x !== p.id) : [...v.activityHidden, p.id],
          }),
        );
        const name = document.createElement("span");
        name.className = "activity-setting-name";
        name.textContent = p.available ? p.label : t("{name}（目前用不到）", { name: p.label });
        const ids = panels.map((x) => x.id);
        row.append(
          icon(p.icon),
          name,
          button(t("往上移"), "arrow-up", () => this.#store.update({ activityOrder: move(ids, i, -1) }), i === 0),
          button(t("往下移"), "arrow-down", () => this.#store.update({ activityOrder: move(ids, i, 1) }), i === panels.length - 1),
          check,
        );
        rows.push(row);
      });
      const cmds = v.activityCommands;
      if (cmds.length) {
        const sep = document.createElement("p");
        sep.className = "activity-setting-sep";
        sep.textContent = t("釘選的按鈕");
        rows.push(sep);
      }
      cmds.forEach((id, i) => {
        const c = h.command(id);
        const row = document.createElement("div");
        row.className = "activity-setting";
        const name = document.createElement("span");
        name.className = "activity-setting-name";
        name.textContent = c?.title ?? id;
        row.append(
          icon(c?.icon ?? "command"),
          name,
          button(t("往上移"), "arrow-up", () => this.#store.update({ activityCommands: move(cmds, i, -1) }), i === 0),
          button(t("往下移"), "arrow-down", () => this.#store.update({ activityCommands: move(cmds, i, 1) }), i === cmds.length - 1),
          button(t("從圖示列移除"), "x", () => this.#store.update({ activityCommands: cmds.filter((x) => x !== id) })),
        );
        rows.push(row);
      });
      const actions = document.createElement("div");
      actions.className = "activity-setting-actions";
      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn";
      add.append(icon("plus"), t("新增按鈕…"));
      add.addEventListener("click", () => h.add());
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "btn";
      reset.append(icon("rotate-ccw"), t("恢復預設"));
      reset.addEventListener("click", () =>
        this.#store.update({ activityOrder: [], activityHidden: [], activityCommands: [...DEFAULTS.activityCommands] }),
      );
      actions.append(add, reset);
      list.replaceChildren(...rows, actions);
    };
    render();
    this.#store.subscribe((_, changed) => {
      if (changed.some((k) => k.startsWith("activity"))) render();
    });
    const hint = this.#row(
      "activity",
      t("圖示與順序"),
      t("勾選要顯示的圖示、調整順序，也可以把常用的指令（例如 Git 歷史）放上去。在圖示列上按右鍵或直接拖曳圖示也可以調整。"),
      () => list,
    );
    hint.classList.add("settings-row-block");
    return this.#group(t("左側圖示列"), [hint]);
  }

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
    const url = input("ado-url", "url", t("https://tfs.公司.com/tfs/DefaultCollection"));
    const pat = input("ado-pat", "password", t("貼上權杖"));
    const urlRow = this.#row("ado-url", t("伺服器網址"), t("集合或組織的網址；貼上專案或儲存庫的網址也可以"), () => url);
    const patRow = this.#row(
      "ado-pat",
      t("個人存取權杖（PAT）"),
      t("在 ADO 網頁右上角的使用者設定 →「Personal access tokens」建立，權限勾選 Code（Read & write）與 Work Items（Read）"),
      () => pat,
    );
    const connectBtn = document.createElement("button");
    connectBtn.type = "button";
    connectBtn.id = "setting-ado-connect";
    const statusRow = this.#row("ado-connect", t("連線"), t("讀取中…"), () => connectBtn);
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
    const openRow = this.#row("ado-open", t("從 Azure DevOps 開啟儲存庫"), t("選一個儲存庫或專案 Wiki，下載到電腦並開啟"), () =>
      action("ado-open", t("開啟…"), () => ado.openRepo()),
    );
    const itemsRow = this.#row("ado-items", t("工作項目"), t("在側邊欄列出指派給你的工作項目，可以插入連結到文件"), () =>
      action("ado-items", t("顯示"), () => ado.workItems()),
    );
    const refresh = () => {
      const a = ado.account();
      urlRow.hidden = patRow.hidden = !!a;
      // 上面兩列藏起來時，帳號是第一列，不需要分隔線。
      statusRow.style.borderTop = a ? "0" : "";
      openRow.hidden = itemsRow.hidden = !a;
      label.textContent = a ? t("帳號") : t("連線");
      hint.textContent = a
        ? t("已連線：{name}（{url}）", { name: a.name, url: a.url.replace(/^https?:\/\//, "") })
        : t("輸入網址與權杖後按「連線」；權杖只會送到這台伺服器");
      connectBtn.className = a ? "btn" : "btn btn-primary";
      connectBtn.textContent = a ? t("中斷連線") : t("連線");
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
    input.placeholder = key === "codeFont" ? t("內建等寬字型") : t("例如：微軟正黑體");
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
          const label = [f.label, f.mono ? t("等寬") : ""].filter(Boolean).join("・");
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
