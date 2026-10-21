/**
 * 指令中心：工具列按鈕、指令面板與快速鍵都從這裡取得同一份指令清單，
 * 確保三個入口的名稱、快速鍵與可用狀態一致。
 */

export interface Command {
  id: string;
  title: string;
  group: string;
  /** lucide 圖示名稱（例如 "bold"）。 */
  icon?: string;
  /** 快速鍵，例如 `Mod-Shift-p`；`Mod` 在 macOS 是 ⌘，其他平台是 Ctrl。 */
  keys?: string;
  /** 只顯示、不綁定的快速鍵（例如 Ctrl+C 由瀏覽器原生處理）。 */
  shownKeys?: string;
  /** 回傳 false 時不顯示於指令面板、快速鍵也不觸發。 */
  when?: () => boolean;
  run(): void | Promise<void>;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 用 `-` 分隔的快速鍵寫法裡，`=` 和 `-` 鍵改用名稱表示。 */
const NAMED_KEYS: Record<string, { label: string; codes: string[] }> = {
  Equal: { label: "=", codes: ["Equal", "NumpadAdd"] },
  Minus: { label: "-", codes: ["Minus", "NumpadSubtract"] },
};

/** 把 `Mod-Shift-p` 轉成 `⌘⇧P` 或 `Ctrl+Shift+P`。 */
export function formatKeys(keys: string, mac = isMac): string {
  const parts = keys.split("-");
  const key = parts.pop()!;
  const label = NAMED_KEYS[key]?.label ?? (key.length === 1 ? key.toUpperCase() : key);
  if (mac) {
    const sym: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Shift: "⇧", Alt: "⌥" };
    return parts.map((p) => sym[p] ?? p).join("") + label;
  }
  return [...parts.map((p) => (p === "Mod" ? "Ctrl" : p)), label].join("+");
}

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * 判斷鍵盤事件是否符合快速鍵。字母與數字比對實體按鍵（`event.code`），
 * 所以 macOS 按住 Option 或使用不同鍵盤配置時依然有效。
 */
export function matchKeys(keys: string, e: KeyLike, mac = isMac): boolean {
  const parts = keys.split("-");
  const key = parts.pop()!;
  const want = { ctrl: false, meta: false, shift: false, alt: false };
  for (const p of parts) {
    if (p === "Mod") want[mac ? "meta" : "ctrl"] = true;
    else if (p === "Ctrl") want.ctrl = true;
    else if (p === "Shift") want.shift = true;
    else if (p === "Alt") want.alt = true;
  }
  if (e.ctrlKey !== want.ctrl || e.metaKey !== want.meta || e.shiftKey !== want.shift || e.altKey !== want.alt) {
    return false;
  }
  if (NAMED_KEYS[key]) return NAMED_KEYS[key].codes.includes(e.code);
  if (/^[a-z]$/i.test(key)) return e.code === `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return e.code === `Digit${key}`;
  return e.key === key;
}

export class Commands {
  #list: Command[] = [];

  register(...cmds: Command[]): void {
    this.#list.push(...cmds);
  }

  get(id: string): Command | undefined {
    return this.#list.find((c) => c.id === id);
  }

  available(): Command[] {
    return this.#list.filter((c) => c.when?.() ?? true);
  }

  async run(id: string): Promise<void> {
    const cmd = this.get(id);
    if (cmd && (cmd.when?.() ?? true)) await cmd.run();
  }

  /** 處理全域快速鍵；有對應指令時回傳該指令。 */
  match(e: KeyLike): Command | undefined {
    return this.available().find((c) => c.keys && matchKeys(c.keys, e));
  }
}

/** 指令面板的模糊比對：查詢字元依序出現在標題或群組中即算符合，連續命中分數較高。 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 - t.indexOf(q);
  let score = 0;
  let last = -2;
  let pos = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, pos);
    if (i < 0) return 0;
    score += i === last + 1 ? 3 : 1;
    last = i;
    pos = i + 1;
  }
  return score;
}
