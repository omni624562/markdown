/**
 * 工作項目類型的顏色：分頁圖示、工作項目標頭的類型標籤、左側圖示列的捷徑共用。
 * 常見類型有預設顏色（接近 Azure DevOps 網頁上的顏色），使用者可以在設定裡改。
 */

/** 預設顏色：[淺色主題, 深色主題]。 */
const DEFAULTS: readonly (readonly [kinds: readonly string[], light: string, dark: string])[] = [
  [["Epic"], "#c25b00", "#ff9d4d"],
  [["Feature"], "#773b93", "#b77ad6"],
  [["User Story", "Product Backlog Item", "Requirement"], "#0078b4", "#4fb7ea"],
  [["Bug"], "#cc293d", "#f0707f"],
  [["Task"], "#a37c00", "#f2cb1d"],
  [["Issue", "Impediment"], "#b4009e", "#e77fd8"],
  [["Test Case"], "#00737a", "#4fc3c9"],
];

/** 設定裡沒有列出伺服器上的類型時（還沒讀到、或讀不到），顯示這些常見類型。 */
export const COMMON_KINDS: readonly string[] = ["Epic", "Feature", "User Story", "Product Backlog Item", "Bug", "Task"];

/** 沒有預設顏色、也沒有自訂的類型用灰色。 */
export const FALLBACK_COLOR = "#64748b";

/** 自訂顏色最多記幾種類型。 */
export const KIND_COLOR_LIMIT = 50;

/** 類型的比對用名稱：不分大小寫，空白換成連字號（`User Story` → `user-story`）。也是 `data-wi-kind` 的值。 */
export function kindKey(kind: string): string {
  return kind.trim().toLowerCase().replace(/\s+/g, "-");
}

const DEFAULT_BY_KEY = new Map<string, { light: string; dark: string }>(
  DEFAULTS.flatMap(([kinds, light, dark]) => kinds.map((k): [string, { light: string; dark: string }] => [kindKey(k), { light, dark }])),
);

const HEX = /^#[0-9a-f]{6}$/i;

/** 驗證設定裡的自訂顏色：類型名稱 → `#rrggbb`。格式不對的略過；`dropped` 表示有略過的。 */
export function sanitizeKindColors(raw: unknown): { colors: Record<string, string>; dropped: boolean } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const colors: Record<string, string> = {};
  const seen = new Set<string>();
  let dropped = false;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const kind = name.trim();
    const key = kindKey(kind);
    if (!kind || kind.length > 60 || typeof value !== "string" || !HEX.test(value) || seen.has(key) || seen.size >= KIND_COLOR_LIMIT) {
      dropped = true;
      continue;
    }
    seen.add(key);
    colors[kind] = value.toLowerCase();
  }
  return { colors, dropped };
}

/** 自訂顏色裡找這個類型（不分大小寫）。 */
function customFor(kind: string, custom: Readonly<Record<string, string>>): string | undefined {
  const key = kindKey(kind);
  for (const [name, color] of Object.entries(custom)) if (kindKey(name) === key) return color;
  return undefined;
}

/** 類型在淺色主題的顏色（設定裡的色塊顯示這個）。 */
export function kindColor(kind: string, custom: Readonly<Record<string, string>>): string {
  return customFor(kind, custom) ?? DEFAULT_BY_KEY.get(kindKey(kind))?.light ?? FALLBACK_COLOR;
}

/** 這個類型是否改過顏色。 */
export function isCustomKind(kind: string, custom: Readonly<Record<string, string>>): boolean {
  return customFor(kind, custom) !== undefined;
}

/** 深色主題用的顏色：太暗的提高亮度，在深色背景上才看得清楚。 */
export function darkVariant(hex: string): string {
  const [h, s, l] = toHsl(hex);
  return toHex(h, s, Math.max(l, 0.62));
}

/** 產生 CSS：每種有顏色的類型一條規則，設定 `--kind`（`[data-wi-kind]` 的元素用它上色）。 */
export function kindColorCss(custom: Readonly<Record<string, string>>): string {
  const rules = new Map<string, string>();
  for (const [key, c] of DEFAULT_BY_KEY) rules.set(key, `light-dark(${c.light}, ${c.dark})`);
  for (const [name, color] of Object.entries(custom)) rules.set(kindKey(name), `light-dark(${color}, ${darkVariant(color)})`);
  return [...rules].map(([key, value]) => `:root [data-wi-kind="${cssString(key)}"] { --kind: ${value}; }`).join("\n");
}

/** CSS 字串裡的跳脫（類型名稱可能有任何字元）。 */
function cssString(s: string): string {
  return s.replace(/[\\"]/g, "\\$&").replace(/[\u0000-\u001f\u007f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
}

function toHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function toHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
