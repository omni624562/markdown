/**
 * 使用者設定：有型別、會驗證，並在變更時通知訂閱者。
 * 網頁版存在 localStorage；桌面版存在 app 設定資料夾的 settings.json，
 * 不會因為清除 WebView 快取而遺失。
 */
import { desktop } from "./desktop.ts";
import { cleanFontName } from "./fonts.ts";
import { t } from "./i18n.ts";
import * as storage from "./storage.ts";
import { TEMPLATE_LIMITS, type Template } from "./templates.ts";

/** 選取段落後可以執行的 AI 快捷動作。 */
export interface QuickAction {
  name: string;
  prompt: string;
}

export type AiTool = "claude" | "codex";

export interface Settings {
  /** 編輯區字級（px）。 */
  editorFontSize: number;
  lineNumbers: boolean;
  /** 自動補上右括號與引號（含全形「」（）等）。 */
  autoPairBrackets: boolean;
  /** 在表格中按 Tab 時自動對齊整個表格。 */
  tableAutoFormat: boolean;
  /** 從網頁、Google 文件、Word 貼上時轉成 Markdown（Ctrl+Shift+V 一律貼純文字）。 */
  smartPaste: boolean;
  /**
   * 編輯區上方固定的格式工具列（JSON 的「格式化」不受影響）。預設關閉：選取文字時才浮出格式按鈕。
   * 舊版的 `formatBar`（預設開啟）不再讀取，讓簡約版面也套用到已經有設定檔的使用者。
   */
  fixedToolbar: boolean;
  /** 大綱固定顯示在內文右邊（視窗夠寬時）；檔案、搜尋等面板仍在左邊。 */
  outlineRight: boolean;
  /** 不載入文件中的遠端圖片（避免對方知道你何時開啟文件、你的 IP）。 */
  blockRemoteImages: boolean;
  /** 桌面版：已經存過的檔案，停止打字一下子後自動存回磁碟。 */
  autoSave: boolean;
  /** 打字自動轉符號：`<=` → `≤`、`->` → `→` 等（程式碼裡不轉換）。 */
  autoSymbols: boolean;
  /** 標示中國用語與常見錯字（波浪底線），滑鼠移上去可以替換。 */
  termCheck: boolean;
  /** 選擇「不再提示」的詞。 */
  termIgnore: string[];
  /** 貼上或拖進很大的圖片時，自動縮小並壓縮。 */
  imageCompress: boolean;
  /** 專注模式：淡化目前段落以外的文字。 */
  focusMode: boolean;
  /** 打字機模式：游標所在行保持在畫面中央。 */
  typewriterMode: boolean;
  /** 預覽與匯出的文字欄寬。 */
  previewWidth: "narrow" | "medium" | "wide";
  /** 即時預覽、預覽與 PDF 的內文字型（原始碼檢視用程式碼字型，表格才對得齊）。 */
  docFont: "sans" | "serif" | "kai" | "mono" | "custom";
  /** `docFont` 為 `"custom"` 時使用的字型名稱。 */
  docFontCustom: string;
  /** 原始碼檢視與程式碼區塊的字型；空字串表示用內建的等寬字型。 */
  codeFont: string;
  /** 即時預覽、預覽與 PDF 的行距。 */
  docLineHeight: "compact" | "normal" | "relaxed";
  /** 用 KaTeX 顯示 `$…$` 數學公式。 */
  math: boolean;
  /** 顯示 ```mermaid 流程圖。 */
  mermaid: boolean;
  /** AI 協作總開關（桌面版）。預設關閉；關閉時下面的 AI 選項都不會生效。 */
  aiEnabled: boolean;
  /** 快捷動作使用的命令列工具。 */
  aiTool: AiTool;
  /** 讓終端機裡的 Claude Code／Codex 讀取目前的文件並提出修改（編輯器 MCP 伺服器）。 */
  mcpServer: boolean;
  /** 讓 AI 透過編輯器在終端機執行指令（每次都會先詢問）。 */
  aiTerminal: boolean;
  /** 檔案被外部程式修改時，逐段標示變更處，可以保留或還原。 */
  markExternalChanges: boolean;
  quickActions: QuickAction[];
  /** 自訂的文件範本（內建範本不在這裡）。 */
  templates: Template[];
  /** 桌面版：每天檢查一次有沒有新版（下載前會先詢問）。 */
  autoUpdate: boolean;
  /** 開啟的資料夾是 Git 儲存庫時，定時提交、拉取、推送。預設關閉。 */
  gitAutoSync: boolean;
  gitSyncMinutes: 5 | 10 | 30 | 60;
}

/** 內建的快捷動作（第一次使用時存進設定；英文介面用英文的名稱與指示）。 */
export const DEFAULT_QUICK_ACTIONS: readonly QuickAction[] = Object.freeze([
  { name: t("改寫得更精簡"), prompt: t("把這段文字改寫得更精簡、通順，保留原意與所有重要資訊。") },
  { name: t("修正錯字與語病"), prompt: t("修正這段文字的錯字、標點與語病，盡量不要改動原本的用字與語氣。") },
  { name: t("翻譯成英文"), prompt: t("把這段文字翻譯成自然流暢的英文。") },
  { name: t("翻譯成繁體中文"), prompt: t("把這段文字翻譯成自然流暢的繁體中文（台灣用語）。") },
  { name: t("摘要重點"), prompt: t("用條列式整理這段文字的重點，最多五點。") },
]);

/** 快捷動作的數量與長度上限。 */
export const QUICK_ACTION_LIMITS = { count: 20, name: 40, prompt: 2000 } as const;

export const DEFAULTS: Readonly<Settings> = Object.freeze({
  editorFontSize: 15,
  lineNumbers: true,
  autoPairBrackets: true,
  tableAutoFormat: true,
  smartPaste: true,
  fixedToolbar: false,
  outlineRight: false,
  // 預設封鎖：開啟別人給的文件時，對方的伺服器不會知道你的 IP 與開啟時間。按一下圖片就能載入。
  blockRemoteImages: true,
  autoSymbols: true,
  autoSave: true,
  termCheck: true,
  termIgnore: [],
  imageCompress: true,
  focusMode: false,
  typewriterMode: false,
  previewWidth: "medium",
  docFont: "sans",
  docFontCustom: "",
  codeFont: "",
  docLineHeight: "normal",
  math: true,
  mermaid: true,
  aiEnabled: false,
  aiTool: "claude",
  mcpServer: true,
  aiTerminal: true,
  markExternalChanges: true,
  quickActions: DEFAULT_QUICK_ACTIONS.map((a) => ({ ...a })),
  templates: [],
  autoUpdate: true,
  gitAutoSync: false,
  gitSyncMinutes: 10,
});

/** 「不再提示」的詞最多記幾個。 */
export const TERM_IGNORE_LIMIT = 500;

export const FONT_SIZE_RANGE = { min: 12, max: 24 } as const;

/** 驗證讀進來的設定：型別不對或超出範圍的欄位一律用預設值。 */
export function sanitize(raw: unknown): { settings: Settings; problems: number } {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Settings = {
    ...DEFAULTS,
    quickActions: DEFAULTS.quickActions.map((a) => ({ ...a })),
    templates: [],
    termIgnore: [],
  };
  let problems = raw && typeof raw === "object" ? 0 : 1;
  type BoolKey = {
    [K in keyof Settings]: Settings[K] extends boolean ? K : never;
  }[keyof Settings];
  const bool = (k: BoolKey) => {
    if (!(k in input)) return;
    if (typeof input[k] === "boolean") out[k] = input[k] as boolean;
    else problems++;
  };
  bool("lineNumbers");
  bool("autoPairBrackets");
  bool("tableAutoFormat");
  bool("smartPaste");
  bool("fixedToolbar");
  bool("outlineRight");
  bool("blockRemoteImages");
  bool("autoSymbols");
  bool("autoSave");
  bool("termCheck");
  bool("imageCompress");
  bool("focusMode");
  bool("typewriterMode");
  bool("math");
  bool("mermaid");
  bool("aiEnabled");
  bool("mcpServer");
  bool("aiTerminal");
  bool("markExternalChanges");
  bool("autoUpdate");
  bool("gitAutoSync");
  if ("gitSyncMinutes" in input) {
    const m = input.gitSyncMinutes;
    if (m === 5 || m === 10 || m === 30 || m === 60) out.gitSyncMinutes = m;
    else problems++;
  }
  if ("aiTool" in input) {
    if (input.aiTool === "claude" || input.aiTool === "codex") out.aiTool = input.aiTool;
    else problems++;
  }
  if ("quickActions" in input) {
    const list = input.quickActions;
    if (Array.isArray(list)) {
      out.quickActions = list
        .filter(
          (a): a is QuickAction =>
            !!a && typeof a === "object" && typeof a.name === "string" && typeof a.prompt === "string",
        )
        .map((a) => ({
          name: a.name.trim().slice(0, QUICK_ACTION_LIMITS.name),
          prompt: a.prompt.trim().slice(0, QUICK_ACTION_LIMITS.prompt),
        }))
        .filter((a) => a.name && a.prompt)
        .slice(0, QUICK_ACTION_LIMITS.count);
      if (out.quickActions.length !== list.length) problems++;
    } else problems++;
  }
  if ("templates" in input) {
    const list = input.templates;
    if (Array.isArray(list)) {
      out.templates = list
        .filter((t): t is Template => !!t && typeof t === "object" && typeof t.name === "string" && typeof t.body === "string")
        .map((t) => ({ name: t.name.trim().slice(0, TEMPLATE_LIMITS.name), body: t.body.slice(0, TEMPLATE_LIMITS.body) }))
        .filter((t) => t.name)
        .slice(0, TEMPLATE_LIMITS.count);
      if (out.templates.length !== list.length) problems++;
    } else problems++;
  }
  if ("termIgnore" in input) {
    const list = input.termIgnore;
    if (Array.isArray(list)) {
      out.termIgnore = [...new Set(list.filter((w): w is string => typeof w === "string" && w.length > 0 && w.length <= 20))].slice(
        0,
        TERM_IGNORE_LIMIT,
      );
      if (out.termIgnore.length !== list.length) problems++;
    } else problems++;
  }
  if ("editorFontSize" in input) {
    const n = input.editorFontSize;
    if (typeof n === "number" && Number.isFinite(n)) {
      out.editorFontSize = Math.round(Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, n)));
    } else problems++;
  }
  if ("previewWidth" in input) {
    const w = input.previewWidth;
    if (w === "narrow" || w === "medium" || w === "wide") out.previewWidth = w;
    else problems++;
  }
  if ("docFont" in input) {
    const f = input.docFont;
    if (f === "sans" || f === "serif" || f === "kai" || f === "mono" || f === "custom") out.docFont = f;
    else problems++;
  }
  for (const key of ["docFontCustom", "codeFont"] as const) {
    if (!(key in input)) continue;
    const name = input[key];
    if (typeof name === "string") out[key] = cleanFontName(name);
    else problems++;
  }
  if ("docLineHeight" in input) {
    const h = input.docLineHeight;
    if (h === "compact" || h === "normal" || h === "relaxed") out.docLineHeight = h;
    else problems++;
  }
  return { settings: out, problems };
}

type Listener = (settings: Settings, changed: (keyof Settings)[]) => void;

export class SettingsStore {
  #value: Settings;
  #listeners = new Set<Listener>();

  private constructor(value: Settings) {
    this.#value = value;
  }

  /** 讀取設定。`recovered` 為 true 代表設定檔損毀或有欄位無效，已改用預設值。 */
  static async load(): Promise<{ store: SettingsStore; recovered: boolean }> {
    let raw: string | null = null;
    try {
      raw = desktop ? await desktop.loadSettings() : storage.load("settings");
    } catch (e) {
      console.error("讀取設定失敗", e); // i18n-ignore（開發者主控台）
    }
    if (!raw) return { store: new SettingsStore({ ...DEFAULTS }), recovered: false };
    try {
      const { settings, problems } = sanitize(JSON.parse(raw));
      return { store: new SettingsStore(settings), recovered: problems > 0 };
    } catch {
      return { store: new SettingsStore({ ...DEFAULTS }), recovered: true };
    }
  }

  get value(): Readonly<Settings> {
    return this.#value;
  }

  update(patch: Partial<Settings>): void {
    const { settings } = sanitize({ ...this.#value, ...patch });
    // 快捷動作是陣列，用內容比較。
    const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
    const changed = (Object.keys(settings) as (keyof Settings)[]).filter((k) => !same(settings[k], this.#value[k]));
    if (!changed.length) return;
    this.#value = settings;
    this.#persist();
    for (const l of this.#listeners) l(settings, changed);
  }

  reset(): void {
    this.update({ ...DEFAULTS });
  }

  subscribe(listener: Listener): void {
    this.#listeners.add(listener);
  }

  #persist(): void {
    const json = JSON.stringify(this.#value, null, 2);
    if (desktop) {
      desktop
        .saveSettings(json)
        .then((accepted) => {
          // 使用者在系統的確認對話框拒絕啟用 AI 協作：開關改回關閉。
          if (accepted === false && this.#value.aiEnabled) this.update({ aiEnabled: false });
        })
        .catch((e) => console.error("儲存設定失敗", e)); // i18n-ignore（開發者主控台）
    }
    else storage.save("settings", json);
  }
}
