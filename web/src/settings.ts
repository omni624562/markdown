/**
 * 使用者設定：有型別、會驗證，並在變更時通知訂閱者。
 * 網頁版存在 localStorage；桌面版存在 app 設定資料夾的 settings.json，
 * 不會因為清除 WebView 快取而遺失。
 */
import { desktop } from "./desktop.ts";
import * as storage from "./storage.ts";

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
}

export const DEFAULTS: Readonly<Settings> = Object.freeze({
  editorFontSize: 15,
  lineNumbers: true,
  autoPairBrackets: true,
  tableAutoFormat: true,
  previewWidth: "medium",
  math: true,
  mermaid: true,
});

export const FONT_SIZE_RANGE = { min: 12, max: 24 } as const;

/** 驗證讀進來的設定：型別不對或超出範圍的欄位一律用預設值。 */
export function sanitize(raw: unknown): { settings: Settings; problems: number } {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Settings = { ...DEFAULTS };
  let problems = raw && typeof raw === "object" ? 0 : 1;
  const bool = (k: "lineNumbers" | "autoPairBrackets" | "tableAutoFormat" | "math" | "mermaid") => {
    if (!(k in input)) return;
    if (typeof input[k] === "boolean") out[k] = input[k] as boolean;
    else problems++;
  };
  bool("lineNumbers");
  bool("autoPairBrackets");
  bool("tableAutoFormat");
  bool("math");
  bool("mermaid");
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
    const changed = (Object.keys(settings) as (keyof Settings)[]).filter((k) => settings[k] !== this.#value[k]);
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
