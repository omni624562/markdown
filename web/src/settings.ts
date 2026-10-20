/**
 * 使用者設定：有型別、會驗證，並在變更時通知訂閱者。
 * 網頁版存在 localStorage；桌面版存在 app 設定資料夾的 settings.json，
 * 不會因為清除 WebView 快取而遺失。
 */
import { desktop } from "./desktop.ts";
import * as storage from "./storage.ts";

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
  /** 預覽與匯出的文字欄寬。 */
  previewWidth: "narrow" | "medium" | "wide";
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
  /** 檔案被外部程式修改時，逐段標示變更處，可以保留或還原。 */
  markExternalChanges: boolean;
  quickActions: QuickAction[];
  /** 桌面版：每天檢查一次有沒有新版（下載前會先詢問）。 */
  autoUpdate: boolean;
}

export const DEFAULT_QUICK_ACTIONS: readonly QuickAction[] = Object.freeze([
  { name: "改寫得更精簡", prompt: "把這段文字改寫得更精簡、通順，保留原意與所有重要資訊。" },
  { name: "修正錯字與語病", prompt: "修正這段文字的錯字、標點與語病，盡量不要改動原本的用字與語氣。" },
  { name: "翻譯成英文", prompt: "把這段文字翻譯成自然流暢的英文。" },
  { name: "翻譯成繁體中文", prompt: "把這段文字翻譯成自然流暢的繁體中文（台灣用語）。" },
  { name: "摘要重點", prompt: "用條列式整理這段文字的重點，最多五點。" },
]);

/** 快捷動作的數量與長度上限。 */
export const QUICK_ACTION_LIMITS = { count: 20, name: 40, prompt: 2000 } as const;

export const DEFAULTS: Readonly<Settings> = Object.freeze({
  editorFontSize: 15,
  lineNumbers: true,
  autoPairBrackets: true,
  tableAutoFormat: true,
  previewWidth: "medium",
  math: true,
  mermaid: true,
  aiEnabled: false,
  aiTool: "claude",
  mcpServer: true,
  markExternalChanges: true,
  quickActions: DEFAULT_QUICK_ACTIONS.map((a) => ({ ...a })),
  autoUpdate: true,
});

export const FONT_SIZE_RANGE = { min: 12, max: 24 } as const;

/** 驗證讀進來的設定：型別不對或超出範圍的欄位一律用預設值。 */
export function sanitize(raw: unknown): { settings: Settings; problems: number } {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Settings = { ...DEFAULTS, quickActions: DEFAULTS.quickActions.map((a) => ({ ...a })) };
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
  bool("math");
  bool("mermaid");
  bool("aiEnabled");
  bool("mcpServer");
  bool("markExternalChanges");
  bool("autoUpdate");
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
      console.error("讀取設定失敗", e);
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
    if (desktop) desktop.saveSettings(json).catch((e) => console.error("儲存設定失敗", e));
    else storage.save("settings", json);
  }
}
