/**
 * 配色（設定 → 外觀 → 配色）：配色風格與強調色。
 *
 * 和主題（明暗）一樣存在 localStorage，畫面繪製前由 `public/theme-init.js` 先套用，避免閃一下別的顏色。
 * 各風格的顏色寫在 `palettes.css`（`[data-palette=…]`）；強調色寫成根元素上的 CSS 變數，
 * 按鈕上的字、選取範圍等由 `--accent` 推算，所以換強調色時整個介面一起改。
 */
import * as storage from "./storage.ts";
import { t } from "./i18n.ts";

export type PaletteId = "forest" | "mint" | "matcha" | "night" | "clean" | "classic" | "project" | "contrast";

export const DEFAULT_PALETTE: PaletteId = "forest";

export interface PaletteInfo {
  id: PaletteId;
  label: string;
  hint: string;
  /** 固定是深色（不管明暗的設定）。 */
  darkOnly?: boolean;
}

/** 設定頁卡片的順序。 */
export const PALETTES: readonly PaletteInfo[] = [
  { id: "forest", label: t("森林綠"), hint: t("沉穩的深綠，邊框帶一點綠") },
  { id: "mint", label: t("薄荷綠"), hint: t("明亮清新的青綠") },
  { id: "matcha", label: t("抹茶（護眼）"), hint: t("米色紙張底、柔和的橄欖綠，長時間閱讀比較不累") },
  { id: "night", label: t("夜森林（深色）"), hint: t("深墨綠底，固定是深色"), darkOnly: true },
  { id: "clean", label: t("清爽白"), hint: t("上方列和內容一樣是白色") },
  { id: "classic", label: t("經典灰"), hint: t("淺灰的框，和內容清楚分開") },
  { id: "project", label: t("專案色"), hint: t("上方列跟著專案的顏色淡淡上色") },
  { id: "contrast", label: t("高對比"), hint: t("黑白分明、線條與焦點框加粗") },
];

export function isPalette(v: unknown): v is PaletteId {
  return typeof v === "string" && PALETTES.some((p) => p.id === v);
}

export interface AccentPreset {
  id: string;
  label: string;
  /** 淺色、深色時的顏色。 */
  light: string;
  dark: string;
}

/** 強調色的選擇（「配色預設」不在這裡：用各風格自己的強調色）。 */
export const ACCENTS: readonly AccentPreset[] = [
  { id: "blue", label: t("藍"), light: "#2f6fd6", dark: "#61afef" },
  { id: "green", label: t("綠"), light: "#2e7d4f", dark: "#5cc08a" },
  { id: "purple", label: t("紫"), light: "#7c4dcc", dark: "#b392f0" },
  { id: "orange", label: t("橘"), light: "#b85407", dark: "#f0a35e" },
  { id: "red", label: t("紅"), light: "#c9303c", dark: "#f07c84" },
  { id: "teal", label: t("青"), light: "#0b7f6c", dark: "#4fd1b5" },
  { id: "pink", label: t("粉"), light: "#c2367a", dark: "#f18bbf" },
];

const HEX = /^#[0-9a-f]{6}$/;

/** 強調色的設定值：空字串（配色預設）、預設的顏色（`blue`）或自訂的 `#rrggbb`。其他值當成空字串。 */
export function parseAccent(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.trim().toLowerCase();
  if (HEX.test(s) || ACCENTS.some((a) => a.id === s)) return s;
  return "";
}

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG 的相對亮度。 */
export function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 的對比（1～21）。 */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** `a` 和 `b` 依比例混合（`amount` 是 `b` 的比例）。 */
function mix(a: string, b: string, amount: number): string {
  const [p, q] = [rgb(a), rgb(b)];
  return hex([0, 1, 2].map((i) => p[i] + (q[i] - p[i]) * amount) as Rgb);
}

/** 按鈕上的字：白字或深色字，挑對比比較高的。 */
const LIGHT_TEXT = "#ffffff";
const DARK_TEXT = "#16181d";
export function textOn(color: string): string {
  return contrast(color, LIGHT_TEXT) >= contrast(color, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
}

/**
 * 強調色在淺色、深色時的顏色與按鈕上的字色。自訂的顏色：
 * 淺色時太淺（白底上看不清楚）就加深，深色時太深就調亮，各自保持至少 3:1（按鈕、連結底線、焦點框都看得出來）。
 */
export function accentColors(accent: string): { light: string; dark: string; lightText: string; darkText: string } | null {
  const v = parseAccent(accent);
  if (!v) return null;
  const preset = ACCENTS.find((a) => a.id === v);
  let light = preset?.light ?? v;
  let dark = preset?.dark ?? v;
  if (!preset) {
    for (let i = 0; i < 10 && contrast(light, "#ffffff") < 3; i++) light = mix(light, "#000000", 0.12);
    for (let i = 0; i < 10 && contrast(dark, "#1e2227") < 3; i++) dark = mix(dark, "#ffffff", 0.15);
  }
  return { light, dark, lightText: textOn(light), darkText: textOn(dark) };
}

/** 寫在根元素上的強調色變數（沒有自訂時是空的：用配色風格自己的強調色）。 */
export function accentVars(accent: string): Record<string, string> {
  const c = accentColors(accent);
  if (!c) return {};
  return {
    "--accent": `light-dark(${c.light}, ${c.dark})`,
    "--accent-fg": `light-dark(${c.lightText}, ${c.darkText})`,
  };
}

const ACCENT_VARS = ["--accent", "--accent-fg"];

/** 套用到 `root`（主畫面或終端機視窗）。 */
export function applyPalette(root: HTMLElement, palette: PaletteId, accent: string): void {
  root.dataset.palette = palette;
  const vars = accentVars(accent);
  for (const name of ACCENT_VARS) {
    if (vars[name]) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }
}

export function loadPalette(): PaletteId {
  const v = storage.load("palette");
  return isPalette(v) ? v : DEFAULT_PALETTE;
}

export function loadAccent(): string {
  return parseAccent(storage.load("accent"));
}

/** 存起來（`theme-init.js` 下次啟動時直接用算好的變數）。 */
export function savePalette(palette: PaletteId, accent: string): void {
  storage.save("palette", palette);
  if (accent) {
    storage.save("accent", accent);
    storage.save("accent-vars", JSON.stringify(accentVars(accent)));
  } else {
    storage.remove("accent");
    storage.remove("accent-vars");
  }
}

/** 目前畫面是不是深色（明暗設定、系統設定，或固定深色的配色）。 */
export function isDark(root: HTMLElement = document.documentElement): boolean {
  const scheme = getComputedStyle(root).colorScheme;
  if (scheme === "dark") return true;
  if (scheme === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}
